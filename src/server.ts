import * as msgpack from "msgpack-lite";
import * as crypto from "crypto";
import * as nano from "nanomsg";
import * as fs from "fs";
import * as ip from "ip";
import * as bluebird from "bluebird";
import * as zlib from "zlib";
import { createClient, RedisClient } from "redis";

export interface Config {
  svraddr: string;
  msgaddr?: string;
  cacheaddr?: string;
  cacheport?: number;
}

export interface Context {
  domain: string;
  ip: string;
  uid: string;
  msgqueue?: nano.Socket;
  cache?: RedisClient;
}

export type Permission = [string, boolean];

export interface ResponseFunction {
  (result: any): void;
}

export interface ModuleFunction {
  (ctx: Context, rep: ResponseFunction, ...rest: any[]): void;
}

export class Server {
  functions: Map<string, ModuleFunction>;
  permissions: Map<string, Map<string, boolean>>; // {function => { domain => permission }}
  config: Config;

  constructor(config: Config) {
    this.config = config;
    this.functions = new Map<string, ModuleFunction>();
    this.permissions = new Map<string, Map<string, boolean>>();
  }

  public call(fun: string, permissions: Permission[], impl: ModuleFunction): void {
    this.functions.set(fun, impl);
    this.permissions.set(fun, new Map(permissions));
  }

  public run(): void {
    let mq = null;
    if (this.config.msgaddr) {
      let path = this.config.msgaddr.substring(this.config.msgaddr.indexOf("///") + 2, this.config.msgaddr.length);
      if (fs.existsSync(path)) {
        fs.unlinkSync(path); // make nanomsg happy
      }
      mq = nano.socket("push");
      mq.bind(this.config.msgaddr);
    }
    let cache = null;
    if (this.config.cacheaddr) {
      cache = bluebird.promisifyAll(createClient(this.config.cacheport ? this.config.cacheport : (process.env["CACHE_PORT"] ? parseInt(process.env["CACHE_PORT"]) : 6379), this.config.cacheaddr));
    }
    let _self = this;
    let rep = nano.socket("rep");
    rep.bind(this.config.svraddr);
    const lastnumber = parseInt(this.config.svraddr[this.config.svraddr.length - 1]) + 1;
    const newaddr = this.config.svraddr.substr(0, this.config.svraddr.length - 1) + lastnumber.toString();
    let pair = nano.socket("pair");
    pair.bind(newaddr);
    for (const sock of [pair, rep]) {
      sock.on("data", function (buf: NodeBuffer) {
        let data = msgpack.decode(buf);
        let pkt = data.pkt;
        let sn = data.sn;
        let ctx: Context = pkt.ctx; /* Domain, IP, User */
        ctx.msgqueue = mq ? mq : null;
        ctx.cache = cache ? cache : null;
        let fun = pkt.fun;
        let args = pkt.args;
        if (_self.permissions.has(fun) && _self.permissions.get(fun).get(ctx.domain)) {
          let func: ModuleFunction = _self.functions.get(fun);
          if (args != null) {
            func(ctx, function(result) {
              const payload = msgpack.encode(result);
              if (payload.length > 1024) {
                zlib.deflate(payload, (e: Error, newbuf: Buffer) => {
                  if (e) {
                    sock.send(msgpack.encode({ sn, payload }));
                  } else {
                    sock.send(msgpack.encode({ sn, payload: newbuf }));
                  }
                });
              } else {
                sock.send(msgpack.encode({ sn, payload }));
              }
            }, ...args);
          } else {
            func(ctx, function(result) {
              const payload = msgpack.encode(result);
              if (payload.length > 1024) {
                zlib.deflate(payload, (e: Error, newbuf: Buffer) => {
                  if (e) {
                    sock.send(msgpack.encode({ sn, payload }));
                  } else {
                    sock.send(msgpack.encode({ sn, payload: newbuf }));
                  }
                });
              } else {
                sock.send(msgpack.encode({ sn, payload }));
              }
            });
          }
        } else {
          const payload = msgpack.encode({code: 403, msg: "Forbidden"});
          sock.send(msgpack.encode({ sn, payload }));
        }
      });
    }
  }
}

export function rpc<T>(domain: string, addr: string, uid: string, fun: string, ...args: any[]): Promise<T> {
  let p = new Promise<T>(function (resolve, reject) {
    let a = [];
    if (args != null) {
      a = [...args];
    }
    let params = {
      ctx: {
        domain: domain,
        ip:     ip.address(),
        uid:    uid
      },
      fun: fun,
      args: a
    };
    const sn = crypto.randomBytes(64).toString("base64");
    let req = nano.socket("req");
    req.connect(addr);
    req.on("data", (msg) => {
      const data: Object = msgpack.decode(msg);
      if (sn === data["sn"]) {
        if (data["payload"][0] === 0x78 && data["payload"][1] === 0x9c) {
          zlib.inflate(data["payload"], (e: Error, newbuf: Buffer) => {
            if (e) {
              reject(e);
            } else {
              resolve(msgpack.decode(newbuf));
            }
          });
        } else {
          resolve(msgpack.decode(data["payload"]));
        }
      } else {
        reject(new Error("Invalid calling sequence number"));
      }
      req.shutdown(addr);
    });
    req.send(msgpack.encode({ sn, pkt: params }));
  });
  return p;
}


function fib_iter(a: number, b: number, p: number, q: number, n: number) {
  if (n === 0) {
    return b;
  }
  if (n % 2 === 0) {
    return fib_iter(a, b, p * p + q * q, 2 * p * q + q * q, n / 2);
  }
  return fib_iter(a * p + a * q + b * q, b * p + a * q, p, q, n - 1);
}

export function fib(n: number) {
  return fib_iter(1, 0, 0, 1, n);
}

function timer_callback(cache: RedisClient, reply: string, rep: ResponseFunction, countdown: number) {
  cache.get(reply, (err: Error, result) => {
    if (result) {
      rep(JSON.parse(result));
    } else if (countdown === 0) {
      rep({
        code: 408,
        msg: "Request Timeout"
      });
    } else {
      setTimeout(timer_callback, fib(8 - countdown) * 1000, cache, reply, rep, countdown - 1);
    }
  });
}

export function wait_for_response(cache: RedisClient, reply: string, rep: ResponseFunction) {
  setTimeout(timer_callback, 500, cache, reply, rep, 7);
}
