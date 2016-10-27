import * as nano from "nanomsg";
import { RedisClient } from "redis";
export interface Config {
    svraddr: string;
    msgaddr?: string;
    cacheaddr?: string;
}
export interface Context {
    domain: string;
    ip: string;
    uid: string;
    msgqueue?: nano.Socket;
    cache?: RedisClient;
}
export declare type Permission = [string, boolean];
export interface ResponseFunction {
    (result: any): void;
}
export interface ModuleFunction {
    (ctx: Context, rep: ResponseFunction, ...rest: any[]): void;
}
export declare class Server {
    functions: Map<string, ModuleFunction>;
    permissions: Map<string, Map<string, boolean>>;
    config: Config;
    constructor(config: Config);
    call(fun: string, permissions: Permission[], impl: ModuleFunction): void;
    run(): void;
}
export declare function rpc<T>(domain: string, addr: string, uid: string, fun: string, ...args: any[]): Promise<T>;
export declare function fib(n: number): any;
export declare function wait_for_response(cache: RedisClient, reply: string, rep: ResponseFunction): void;
