import Models = require("../share/models");
import Utils = require("./utils");
import Interfaces = require("./interfaces");
import Safety = require("./safety");
import _ = require("lodash");
import FairValue = require("./fair-value");
import MarketFiltration = require("./market-filtration");
import QuotingParameters = require("./quoting-parameters");
import PositionManagement = require("./position-management");
import moment = require('moment');
import QuotingStyleRegistry = require("./quoting-styles/style-registry");
import MidMarket = require("./quoting-styles/mid-market");
import TopJoin = require("./quoting-styles/top-join");
import PingPong = require("./quoting-styles/ping-pong");

export class QuotingEngine {
    private _log = Utils.log("quotingengine");

    public QuoteChanged = new Utils.Evt<Models.TwoSidedQuote>();

    private _latest: Models.TwoSidedQuote = null;
    public get latestQuote() { return this._latest; }
    public set latestQuote(val: Models.TwoSidedQuote) {
        if (_.isEqual(val, this._latest)) return;

        this._latest = val;
        this.QuoteChanged.trigger();
    }

    private _registry: QuotingStyleRegistry.QuotingStyleRegistry = null;

    constructor(
        private _timeProvider: Utils.ITimeProvider,
        private _filteredMarkets: MarketFiltration.MarketFiltration,
        private _fvEngine: FairValue.FairValueEngine,
        private _qlParamRepo: QuotingParameters.QuotingParametersRepository,
        private _orderBroker: Interfaces.IOrderBroker,
        private _positionBroker: Interfaces.IPositionBroker,
        private _ewma: Interfaces.IEwmaCalculator,
        private _targetPosition: PositionManagement.TargetBasePositionManager,
        private _safeties: Safety.SafetyCalculator) {
        this._registry = new QuotingStyleRegistry.QuotingStyleRegistry([
          new MidMarket.MidMarketQuoteStyle(),
          new TopJoin.InverseJoinQuoteStyle(),
          new TopJoin.InverseTopOfTheMarketQuoteStyle(),
          new TopJoin.JoinQuoteStyle(),
          new TopJoin.TopOfTheMarketQuoteStyle(),
          new PingPong.PingPongQuoteStyle(),
          new PingPong.BoomerangQuoteStyle(),
          new PingPong.AK47QuoteStyle(),
        ]);

        var recalcWithoutInputTime = () => this.recalcQuote(_timeProvider.utcNow());

        _filteredMarkets.FilteredMarketChanged.on(m => this.recalcQuote(Utils.timeOrDefault(m, _timeProvider)));
        _qlParamRepo.NewParameters.on(recalcWithoutInputTime);
        _orderBroker.Trade.on(recalcWithoutInputTime);
        _ewma.Updated.on(() => {
          recalcWithoutInputTime();
          _targetPosition.quoteEWMA = _ewma.latest;
        });
        _targetPosition.NewTargetPosition.on(recalcWithoutInputTime);
        _safeties.NewValue.on(recalcWithoutInputTime);

        _timeProvider.setInterval(recalcWithoutInputTime, moment.duration(1, "seconds"));
    }

    private computeQuote(filteredMkt: Models.Market, fv: Models.FairValue) {
        var params = this._qlParamRepo.latest;
        var unrounded = this._registry.Get(params.mode).GenerateQuote(filteredMkt, fv, params, this._positionBroker);

        if (unrounded === null)
            return null;

        if (params.ewmaProtection && this._ewma.latest !== null) {
            if (this._ewma.latest > unrounded.askPx) {
                unrounded.askPx = Math.max(this._ewma.latest, unrounded.askPx);
            }

            if (this._ewma.latest < unrounded.bidPx) {
                unrounded.bidPx = Math.min(this._ewma.latest, unrounded.bidPx);
            }
        }

        var tbp = this._targetPosition.latestTargetPosition;
        if (tbp === null) {
            // this._log.warn("cannot compute a quote since no position report exists!");
            return null;
        }
        var targetBasePosition = tbp.data;

        var latestPosition = this._positionBroker.latestReport;
        var totalBasePosition = latestPosition.baseAmount + latestPosition.baseHeldAmount;
        var totalQuotePosition = (latestPosition.quoteAmount + latestPosition.quoteHeldAmount) / fv.price;
        let sideAPR: string[] = [];

        let superTradesMultipliers = (params.superTrades &&
          params.widthPing * params.sopWidthMultiplier < filteredMkt.asks[0].price - filteredMkt.bids[0].price
        ) ? [
          (params.superTrades == Models.SOP.x2trds || params.superTrades == Models.SOP.x2trdsSz
            ? 2 : (params.superTrades == Models.SOP.x3trds || params.superTrades == Models.SOP.x3trdsSz
              ? 3 : 1)),
          (params.superTrades == Models.SOP.x2Sz || params.superTrades == Models.SOP.x2trdsSz
            ? 2 : (params.superTrades == Models.SOP.x3Sz || params.superTrades == Models.SOP.x3trdsSz
              ? 3 : 1))
        ] : [1, 1];

        let buySize: number = (params.percentageValues)
          ? params.buySizePercentage * latestPosition.value / 100
          : params.buySize;
        let sellSize: number = (params.percentageValues)
          ? params.sellSizePercentage * latestPosition.value / 100
          : params.sellSize;
        if (superTradesMultipliers[1] > 1) {
          unrounded.bidSz = Math.min(superTradesMultipliers[1]*buySize, (latestPosition.quoteAmount / fv.price) / 2);
          unrounded.askSz = Math.min(superTradesMultipliers[1]*sellSize, latestPosition.baseAmount / 2);
        }

        let pDiv: number  = (params.percentageValues)
          ? params.positionDivergencePercentage * latestPosition.value / 100
          : params.positionDivergence;
        if (totalBasePosition < targetBasePosition - pDiv) {
            unrounded.askPx = null;
            unrounded.askSz = null;
            if (params.aggressivePositionRebalancing !== Models.APR.Off) {
              sideAPR.push('Bid');
              unrounded.bidSz = Math.min(params.aprMultiplier*buySize, targetBasePosition - totalBasePosition, (latestPosition.quoteAmount / fv.price) / 2);
            }
        }
        if (totalBasePosition > targetBasePosition + pDiv) {
            unrounded.bidPx = null;
            unrounded.bidSz = null;
            if (params.aggressivePositionRebalancing !== Models.APR.Off) {
              sideAPR.push('Sell');
              unrounded.askSz = Math.min(params.aprMultiplier*sellSize, totalBasePosition - targetBasePosition, latestPosition.baseAmount / 2);
            }
        }

        this._targetPosition.sideAPR = sideAPR;

        var safety = this._safeties.latest;
        if (safety === null) {
            this._log.warn("cannot compute a quote since trade safety is not yet computed!");
            return null;
        }

        if (params.mode === Models.QuotingMode.PingPong || params.mode === Models.QuotingMode.Boomerang || params.mode === Models.QuotingMode.AK47) {
          if (unrounded.askSz && safety.buyPing && (
            (params.aggressivePositionRebalancing === Models.APR.SizeWidth && sideAPR.indexOf('Sell')>-1)
            || params.pongAt == Models.PongAt.ShortPingAggressive
            || params.pongAt == Models.PongAt.LongPingAggressive
            || unrounded.askPx < safety.buyPing + params.widthPong
          )) unrounded.askPx = safety.buyPing + params.widthPong;
          if (unrounded.bidSz && safety.sellPong && (
            (params.aggressivePositionRebalancing === Models.APR.SizeWidth && sideAPR.indexOf('Buy')>-1)
            || params.pongAt == Models.PongAt.ShortPingAggressive
            || params.pongAt == Models.PongAt.LongPingAggressive
            || unrounded.bidPx > safety.sellPong - params.widthPong
          )) unrounded.bidPx = safety.sellPong - params.widthPong;
        }

        if (unrounded.askPx !== null)
          for (var fai = 0; fai < filteredMkt.asks.length; fai++)
            if (filteredMkt.asks[fai].price > unrounded.askPx) {
              let bestAsk: number = filteredMkt.asks[fai].price - 1e-2;
              if (bestAsk > fv.price) {
                unrounded.askPx = bestAsk;
                break;
              }
            }
        if (unrounded.bidPx !== null)
          for (var fbi = 0; fbi < filteredMkt.bids.length; fbi++)
            if (filteredMkt.bids[fbi].price < unrounded.bidPx) {
              let bestBid: number = filteredMkt.bids[fbi].price + 1e-2;
              if (bestBid < fv.price) {
                unrounded.bidPx = bestBid;
                break;
              }
            }

        if (safety.sell > (params.tradesPerMinute * superTradesMultipliers[0]) || (
            (params.mode === Models.QuotingMode.PingPong || params.mode === Models.QuotingMode.Boomerang || params.mode === Models.QuotingMode.AK47)
            && !safety.buyPing && (params.pingAt === Models.PingAt.StopPings || params.pingAt === Models.PingAt.BidSide || params.pingAt === Models.PingAt.DepletedAskSide
              || (totalQuotePosition>buySize && (params.pingAt === Models.PingAt.DepletedSide || params.pingAt === Models.PingAt.DepletedBidSide))
        ))) {
            unrounded.askPx = null;
            unrounded.askSz = null;
        }
        if (safety.buy > (params.tradesPerMinute * superTradesMultipliers[0]) || (
          (params.mode === Models.QuotingMode.PingPong || params.mode === Models.QuotingMode.Boomerang || params.mode === Models.QuotingMode.AK47)
            && !safety.sellPong && (params.pingAt === Models.PingAt.StopPings || params.pingAt === Models.PingAt.AskSide || params.pingAt === Models.PingAt.DepletedBidSide
              || (totalBasePosition>sellSize && (params.pingAt === Models.PingAt.DepletedSide || params.pingAt === Models.PingAt.DepletedAskSide))
        ))) {
            unrounded.bidPx = null;
            unrounded.bidSz = null;
        }

        if (unrounded.bidPx !== null) {
            unrounded.bidPx = Utils.roundFloat(unrounded.bidPx);
            unrounded.bidPx = Math.max(0, unrounded.bidPx);
        }

        if (unrounded.askPx !== null) {
            unrounded.askPx = Utils.roundFloat(unrounded.askPx);
            unrounded.askPx = Math.max(unrounded.bidPx + 1e-2, unrounded.askPx);
        }

        if (unrounded.askSz !== null) {
            unrounded.askSz = Utils.roundFloat(unrounded.askSz);
            unrounded.askSz = Math.max(1e-2, unrounded.askSz);
        }

        if (unrounded.bidSz !== null) {
            unrounded.bidSz = Utils.roundFloat(unrounded.bidSz);
            unrounded.bidSz = Math.max(1e-2, unrounded.bidSz);
        }

        return unrounded;
    }

    private recalcQuote = (t: moment.Moment) => {
        var fv = this._fvEngine.latestFairValue;
        if (fv == null) {
            this.latestQuote = null;
            return;
        }

        var filteredMkt = this._filteredMarkets.latestFilteredMarket;
        if (filteredMkt == null) {
            this.latestQuote = null;
            return;
        }

        var genQt = this.computeQuote(filteredMkt, fv);

        if (genQt === null) {
            this.latestQuote = null;
            return;
        }

        this.latestQuote = new Models.TwoSidedQuote(
            QuotingEngine.quotesAreSame(new Models.Quote(genQt.bidPx, genQt.bidSz), this.latestQuote, t => t.bid),
            QuotingEngine.quotesAreSame(new Models.Quote(genQt.askPx, genQt.askSz), this.latestQuote, t => t.ask),
            t
            );
    };

    private static quotesAreSame(newQ: Models.Quote, prevTwoSided: Models.TwoSidedQuote, sideGetter: (q: Models.TwoSidedQuote) => Models.Quote): Models.Quote {
        if (newQ.price === null && newQ.size === null) return null;
        if (prevTwoSided == null) return newQ;
        var previousQ = sideGetter(prevTwoSided);
        if (previousQ == null && newQ != null) return newQ;
        if (Math.abs(newQ.size - previousQ.size) > 5e-3) return newQ;
        return Math.abs(newQ.price - previousQ.price) < .009999 ? previousQ : newQ;
    }
}
