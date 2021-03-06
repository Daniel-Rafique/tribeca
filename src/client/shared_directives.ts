import {NgModule, Component, Injectable, Inject} from '@angular/core';
import {AgRendererComponent} from 'ag-grid-angular/main';

import moment = require('moment');
import * as io from 'socket.io-client';

import Subscribe = require("./subscribe");
import Models = require("../share/models");

@Injectable()
export class FireFactory {
    constructor(@Inject('socket') private socket: SocketIOClient.Socket) {}

    public getFire = <T>(topic : string) : Subscribe.IFire<T> => {
        return new Subscribe.Fire<T>(topic, this.socket);
    }
}

@Injectable()
export class SubscriberFactory {
    constructor(@Inject('socket') private socket: SocketIOClient.Socket) {}

    public getSubscriber = <T>(scope: any, topic: string): Subscribe.ISubscribe<T> => {
      return new EvalAsyncSubscriber<T>(scope, topic, this.socket);
    }
}

class EvalAsyncSubscriber<T> implements Subscribe.ISubscribe<T> {
    private _wrapped: Subscribe.ISubscribe<T>;

    constructor(private _scope: any, topic: string, io: any) {
      this._wrapped = new Subscribe.Subscriber<T>(topic, io);
    }

    public registerSubscriber = (incrementalHandler: (msg: T) => void) => {
      return this._wrapped.registerSubscriber(x => this._scope.run(() => incrementalHandler(x)))
    };

    public registerDisconnectedHandler = (handler: () => void) => {
      return this._wrapped.registerDisconnectedHandler(() => this._scope.run(handler));
    };

    public get connected() { return this._wrapped.connected; }
}

@Component({
    selector: 'base-currency-cell',
    template: `{{ params.value | number:'1.3-3' }}`
})
export class BaseCurrencyCellComponent implements AgRendererComponent {
  private params:any;

  agInit(params:any):void {
    this.params = params;
  }
}

@Component({
    selector: 'quote-currency-cell',
    template: `{{ params.value | currency:quoteSymbol:true:'1.2-2' }}`
})
export class QuoteCurrencyCellComponent implements AgRendererComponent {
  private params:any;
  private quoteSymbol:string = 'USD';

  agInit(params:any):void {
    this.params = params;
    if ('quoteSymbol' in params.node.data)
      this.quoteSymbol = params.node.data.quoteSymbol;
  }
}

@NgModule({
  providers: [
    SubscriberFactory,
    FireFactory,
    {
      provide: 'socket',
      useValue: io()
    }
  ]
})
export class SharedModule {}