"use strict";
const msgpack = require("msgpack-lite");
const nano = require("nanomsg");
const fs = require("fs");
const ip = require("ip");
const redis_1 = require("redis");
class Server {
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
        let rep = nano.socket("rep");
        rep.bind(this.config.svraddr);
        let mq = null;
        if (this.config.msgaddr) {
            let path = this.config.msgaddr.substring(this.config.msgaddr.indexOf("///") + 2, this.config.msgaddr.length);
            if (fs.existsSync(path)) {
                fs.unlinkSync(path);
            }
            mq = nano.socket("push");
            mq.bind(this.config.msgaddr);
        }
        let cache = null;
        if (this.config.cacheaddr) {
            cache = redis_1.createClient(6379, this.config.cacheaddr);
        }
        this.config.msgaddr ? nano.socket("push") : null;
        let _self = this;
        rep.on("data", function (buf) {
            let pkt = msgpack.decode(buf);
            let ctx = pkt.ctx;
            ctx.msgqueue = mq ? mq : null;
            ctx.cache = cache ? cache : null;
            let fun = pkt.fun;
            let args = pkt.args;
            if (_self.permissions.has(fun) && _self.permissions.get(fun).get(ctx.domain)) {
                let func = _self.functions.get(fun);
                if (args != null) {
                    func(ctx, function (result) {
                        rep.send(msgpack.encode(result));
                    }, ...args);
                }
                else {
                    func(ctx, function (result) {
                        rep.send(msgpack.encode(result));
                    });
                }
            }
            else {
                rep.send(msgpack.encode({ code: 403, msg: "Forbidden" }));
            }
        });
    }
}
exports.Server = Server;
function rpc(domain, addr, uid, fun, ...args) {
    let p = new Promise(function (resolve, reject) {
        let a = [];
        if (args != null) {
            a = [...args];
        }
        let params = {
            ctx: {
                domain: domain,
                ip: ip.address(),
                uid: uid
            },
            fun: fun,
            args: a
        };
        let req = nano.socket("req");
        req.connect(addr);
        req.on("data", (msg) => {
            resolve(msgpack.decode(msg));
            req.shutdown(addr);
        });
        req.send(msgpack.encode(params));
    });
    return p;
}
exports.rpc = rpc;
function wait_for_response(cache, reply, rep) {
    let countdown = 10;
    let timer = setInterval(() => {
        cache.get(reply, (err, result) => {
            countdown--;
            if (result) {
                rep(JSON.parse(result));
                clearInterval(timer);
            }
            else if (countdown === 0) {
                rep({
                    code: 408,
                    msg: "Request Timeout"
                });
                clearInterval(timer);
            }
        });
    }, 3);
}
exports.wait_for_response = wait_for_response;
