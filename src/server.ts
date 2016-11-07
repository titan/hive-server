import * as msgpack from "msgpack-lite";
import * as nano from "nanomsg";
import * as fs from "fs";
import * as ip from "ip";
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
    let rep = nano.socket("rep");
    rep.bind(this.config.svraddr);
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
      cache = createClient(this.config.cacheport ? this.config.cacheport : (process.env["CACHE_PORT"] ? parseInt(process.env["CACHE_PORT"]) : 6379), this.config.cacheaddr);
    }
    let _self = this;
    rep.on("data", function (buf: NodeBuffer) {
      let pkt = msgpack.decode(buf);
      let ctx: Context = pkt.ctx; /* Domain, IP, User */
      ctx.msgqueue = mq ? mq : null;
      ctx.cache = cache ? cache : null;
      let fun = pkt.fun;
      let args = pkt.args;
      if (_self.permissions.has(fun) && _self.permissions.get(fun).get(ctx.domain)) {
        let func: ModuleFunction = _self.functions.get(fun);
        if (args != null) {
          func(ctx, function(result) {
            rep.send(msgpack.encode(result));
          }, ...args);
        } else {
          func(ctx, function(result) {
            rep.send(msgpack.encode(result));
          });
        }
      } else {
        rep.send(msgpack.encode({code: 403, msg: "Forbidden"}));
      }
    });
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
