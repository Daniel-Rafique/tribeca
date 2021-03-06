import Models = require("../share/models");
import Utils = require("./utils");
import Interfaces = require("./interfaces");
import Broker = require("./broker");
import Publish = require("./publish");
import moment = require('moment');
import _ = require("lodash");
import FairValue = require("./fair-value");
import Persister = require("./persister");

export class SafetyCalculator {
    NewValue = new Utils.Evt();

    private _log = Utils.log("safety");

    private _latest: Models.TradeSafety = null;
    public get latest() { return this._latest; }
    public set latest(val: Models.TradeSafety) {
        if (!this._latest || Math.abs(val.combined - this._latest.combined) > 1e-3
          || Math.abs(val.buyPing - this._latest.buyPing) >= 1e-2
          || Math.abs(val.sellPong - this._latest.sellPong) >= 1e-2) {
            this._latest = val;
            this.NewValue.trigger(this.latest);
            this._publisher.publish(this.latest);
        }
    }

    private _buys: Models.Trade[] = [];
    private _sells: Models.Trade[] = [];

    constructor(
        private _timeProvider: Utils.ITimeProvider,
        private _fvEngine: FairValue.FairValueEngine,
        private _qlParams: Interfaces.IRepository<Models.QuotingParameters>,
        private _positionBroker: Interfaces.IPositionBroker,
        private _broker: Broker.OrderBroker,
        private _publisher: Publish.IPublish<Models.TradeSafety>) {
        _publisher.registerSnapshot(() => [this.latest]);
        _qlParams.NewParameters.on(_ => this.computeQtyLimit());
        _qlParams.NewParameters.on(_ => this.cancelOpenOrders());
        _broker.Trade.on(this.onTrade);

        _timeProvider.setInterval(this.computeQtyLimit, moment.duration(1, "seconds"));
    }

    private cancelOpenOrders = () => {
      if (this._qlParams.latest.mode === Models.QuotingMode.AK47)
        this._broker.cancelOpenOrders();
    };

    private onTrade = (ut: Models.Trade) => {
        var u = _.cloneDeep(ut);
        if (this.isOlderThan(u, this._qlParams.latest)) return;

        if (u.side === Models.Side.Ask) {
            this._sells.push(u);
        }
        else if (u.side === Models.Side.Bid) {
            this._buys.push(u);
        }

        this.computeQtyLimit();
    };

    private isOlderThan(o: Models.Trade, settings: Models.QuotingParameters) {
        var now = this._timeProvider.utcNow();
        return Math.abs(Utils.fastDiff(now, o.time)) > (1000 * settings.tradeRateSeconds);
    }

    private computeQtyLimit = () => {
        var settings = this._qlParams.latest;
        var latestPosition = this._positionBroker.latestReport;
        let buySize: number = (settings.percentageValues && latestPosition != null)
          ? settings.buySizePercentage * latestPosition.value / 100
          : settings.buySize;
        let sellSize: number = (settings.percentageValues && latestPosition != null)
          ? settings.sellSizePercentage * latestPosition.value / 100
          : settings.sellSize;
        var buyPing = 0;
        var sellPong = 0;
        var buyPq = 0;
        var sellPq = 0;
        var _buyPq = 0;
        var _sellPq = 0;
        var trades = this._broker._trades;
        var fv = this._fvEngine.latestFairValue;
        var fvp = 0;
        if (fv != null) {fvp = fv.price;}
        if (settings.pongAt == Models.PongAt.ShortPingFair || settings.pongAt == Models.PongAt.ShortPingAggressive) {
          trades.sort((a: Models.Trade, b: Models.Trade) => a.price>b.price?1:(a.price<b.price?-1:0));
          for (var ti = 0;ti<trades.length;ti++) {
            if ((!fvp || (fvp>trades[ti].price && fvp-settings.widthPong<trades[ti].price)) && ((settings.mode !== Models.QuotingMode.Boomerang && settings.mode !== Models.QuotingMode.AK47) || trades[ti].Kqty<trades[ti].quantity) && trades[ti].side == Models.Side.Bid && buyPq<sellSize) {
              _buyPq = Math.min(sellSize - buyPq, trades[ti].quantity);
              buyPing += trades[ti].price * _buyPq;
              buyPq += _buyPq;
            }
            if (buyPq>=sellSize) break;
          }
          trades.sort((a: Models.Trade, b: Models.Trade) => a.price<b.price?1:(a.price>b.price?-1:0));
        } else if (settings.pongAt == Models.PongAt.LongPingFair || settings.pongAt == Models.PongAt.LongPingAggressive)
          trades.sort((a: Models.Trade, b: Models.Trade) => a.price>b.price?1:(a.price<b.price?-1:0));
        if (!buyPq) for (var ti = 0;ti<trades.length;ti++) {
          if ((!fvp || fvp>trades[ti].price) && ((settings.mode !== Models.QuotingMode.Boomerang && settings.mode !== Models.QuotingMode.AK47) || trades[ti].Kqty<trades[ti].quantity) && trades[ti].side == Models.Side.Bid && buyPq<sellSize) {
            _buyPq = Math.min(sellSize - buyPq, trades[ti].quantity);
            buyPing += trades[ti].price * _buyPq;
            buyPq += _buyPq;
          }
          if (buyPq>=sellSize) break;
        }
        if (settings.pongAt == Models.PongAt.ShortPingFair || settings.pongAt == Models.PongAt.ShortPingAggressive) {
          trades.sort((a: Models.Trade, b: Models.Trade) => a.price<b.price?1:(a.price>b.price?-1:0));
          for (var ti = 0;ti<trades.length;ti++) {
            if ((!fvp || (fvp<trades[ti].price && fvp+settings.widthPong>trades[ti].price)) && ((settings.mode !== Models.QuotingMode.Boomerang && settings.mode !== Models.QuotingMode.AK47) || trades[ti].Kqty<trades[ti].quantity) && trades[ti].side == Models.Side.Ask && sellPq<buySize) {
              _sellPq = Math.min(buySize - sellPq, trades[ti].quantity);
              sellPong += trades[ti].price * _sellPq;
              sellPq += _sellPq;
            }
            if (sellPq>=buySize) break;
          }
          trades.sort((a: Models.Trade, b: Models.Trade) => a.price>b.price?1:(a.price<b.price?-1:0));
        } else if (settings.pongAt == Models.PongAt.LongPingFair || settings.pongAt == Models.PongAt.LongPingAggressive)
          trades.sort((a: Models.Trade, b: Models.Trade) => a.price<b.price?1:(a.price>b.price?-1:0));
        if (!sellPq) for (var ti = 0;ti<trades.length;ti++) {
          if ((!fvp || fvp<trades[ti].price) && ((settings.mode !== Models.QuotingMode.Boomerang && settings.mode !== Models.QuotingMode.AK47) || trades[ti].Kqty<trades[ti].quantity) && trades[ti].side == Models.Side.Ask && sellPq<buySize) {
            _sellPq = Math.min(buySize - sellPq, trades[ti].quantity);
            sellPong += trades[ti].price * _sellPq;
            sellPq += _sellPq;
          }
          if (sellPq>=buySize) break;
        }

        if (buyPq) buyPing /= buyPq;
        if (sellPq) sellPong /= sellPq;

        var orderTrades = (input: Models.Trade[], direction: number): Models.Trade[]=> {
            return _.chain(input)
                .filter(o => !this.isOlderThan(o, settings))
                .sortBy((t: Models.Trade) => direction * t.price)
                .value();
        };

        this._buys = orderTrades(this._buys, -1);
        this._sells = orderTrades(this._sells, 1);

        // don't count good trades against safety
        while (_.size(this._buys) > 0 && _.size(this._sells) > 0) {
            var sell = _.last(this._sells);
            var buy = _.last(this._buys);
            if (sell.price >= buy.price) {

                var sellQty = sell.quantity;
                var buyQty = buy.quantity;

                buy.quantity -= sellQty;
                sell.quantity -= buyQty;

                if (buy.quantity < 1e-4) this._buys.pop();
                if (sell.quantity < 1e-4) this._sells.pop();
            }
            else {
                break;
            }
        }

        var computeSafety = (t: Models.Trade[]) => t.reduce((sum, t) => sum + t.quantity, 0) / (buySize + sellSize / 2);
        var computeSafetyBuy = (t: Models.Trade[]) => t.reduce((sum, t) => sum + t.quantity, 0) / buySize;
        var computeSafetySell = (t: Models.Trade[]) => t.reduce((sum, t) => sum + t.quantity, 0) / sellSize;

        this.latest = new Models.TradeSafety(
          computeSafetyBuy(this._buys),
          computeSafetySell(this._sells),
          computeSafety(this._buys.concat(this._sells)),
          buyPing,
          sellPong,
          this._timeProvider.utcNow()
        );
    };
}
