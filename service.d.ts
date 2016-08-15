import * as nano from 'nanomsg';
export interface Config {
    svraddr: string;
    msgaddr?: string;
}
export interface Context {
    domain: string;
    ip: string;
    uid: string;
    msgqueue?: nano.Socket;
}
export declare type Permission = [string, boolean];
export interface ResponseFunction {
    (result: any): void;
}
export interface ModuleFunction {
    (ctx: Context, rep: ResponseFunction, ...rest: any[]): void;
}
export declare class Service {
    functions: Map<string, ModuleFunction>;
    permissions: Map<string, Map<string, boolean>>;
    config: Config;
    constructor(config: Config);
    call(fun: string, permissions: Permission[], impl: ModuleFunction): void;
    run(): void;
}
