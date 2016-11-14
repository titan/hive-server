"use strict";
const msgpack = require("msgpack-lite");
const crypto = require("crypto");
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
            cache = redis_1.createClient(this.config.cacheport ? this.config.cacheport : (process.env["CACHE_PORT"] ? parseInt(process.env["CACHE_PORT"]) : 6379), this.config.cacheaddr);
        }
        let _self = this;
        let pair = nano.socket("pair");
        pair.bind(this.config.svraddr);
        let rep = nano.socket("rep");
        rep.bind(this.config.svraddr);
        for (const sock of [pair, rep]) {
            sock.on("data", function (buf) {
                let data = msgpack.decode(buf);
                let pkt = data.pkt;
                let sn = data.sn;
                let ctx = pkt.ctx;
                ctx.msgqueue = mq ? mq : null;
                ctx.cache = cache ? cache : null;
                let fun = pkt.fun;
                let args = pkt.args;
                if (_self.permissions.has(fun) && _self.permissions.get(fun).get(ctx.domain)) {
                    let func = _self.functions.get(fun);
                    if (args != null) {
                        func(ctx, function (result) {
                            const payload = msgpack.encode(result);
                            sock.send(msgpack.encode({ sn, payload }));
                        }, ...args);
                    }
                    else {
                        func(ctx, function (result) {
                            const payload = msgpack.encode(result);
                            sock.send(msgpack.encode({ sn, payload }));
                        });
                    }
                }
                else {
                    const payload = msgpack.encode({ code: 403, msg: "Forbidden" });
                    sock.send(msgpack.encode({ sn, payload }));
                }
            });
        }
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
        const sn = crypto.randomBytes(64).toString("base64");
        let req = nano.socket("req");
        const lastnumber = parseInt(addr[addr.length - 1]) + 1;
        const newaddr = addr.substr(0, addr.length - 1) + lastnumber.toString();
        req.connect(newaddr);
        req.on("data", (msg) => {
            const data = msgpack.decode(msg);
            if (sn === data["sn"]) {
                resolve(msgpack.decode(data["payload"]));
            }
            else {
                reject(new Error("Invalid calling sequence number"));
            }
            req.shutdown(addr);
        });
        req.send(msgpack.encode({ sn, pkt: params }));
    });
    return p;
}
exports.rpc = rpc;
function fib_iter(a, b, p, q, n) {
    if (n === 0) {
        return b;
    }
    if (n % 2 === 0) {
        return fib_iter(a, b, p * p + q * q, 2 * p * q + q * q, n / 2);
    }
    return fib_iter(a * p + a * q + b * q, b * p + a * q, p, q, n - 1);
}
function fib(n) {
    return fib_iter(1, 0, 0, 1, n);
}
exports.fib = fib;
function timer_callback(cache, reply, rep, countdown) {
    cache.get(reply, (err, result) => {
        if (result) {
            rep(JSON.parse(result));
        }
        else if (countdown === 0) {
            rep({
                code: 408,
                msg: "Request Timeout"
            });
        }
        else {
            setTimeout(timer_callback, fib(8 - countdown) * 1000, cache, reply, rep, countdown - 1);
        }
    });
}
function wait_for_response(cache, reply, rep) {
    setTimeout(timer_callback, 500, cache, reply, rep, 7);
}
exports.wait_for_response = wait_for_response;
