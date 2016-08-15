"use strict";
const msgpack = require('msgpack-lite');
const nano = require('nanomsg');
class Service {
    constructor(config) {
        this.config = config;
        this.functions = new Map();
        this.permissions = new Map();
    }
    call(fun, permissions, impl) {
        this.functions.set(fun, impl);
        this.permissions.set(fun, new Map(permissions));
    }
    run() {
        let rep = nano.socket('rep');
        rep.bind(this.config.svraddr);
        let mq = this.config.msgaddr ? nano.socket('push') : null;
        let _self = this;
        rep.on('data', function (buf) {
            let pkt = msgpack.decode(buf);
            let ctx = pkt.ctx;
            ctx.msgqueue = mq ? mq : null;
            let fun = pkt.fun;
            let args = pkt.args;
            if (_self.permissions.has(fun) && _self.permissions.get(fun).get(ctx.domain)) {
                let func = _self.functions.get(fun);
                func(ctx, function (result) {
                    rep.send(msgpack.encode(result));
                }, args);
            }
            else {
                rep.send(msgpack.encode({ code: 403, msg: "Forbidden" }));
            }
        });
    }
}
exports.Service = Service;
