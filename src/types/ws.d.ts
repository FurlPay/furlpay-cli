declare module "ws" {
  import { EventEmitter } from "events";

  export namespace WebSocket {
    export type RawData = Buffer | ArrayBuffer | Buffer[];
  }

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;

    readonly readyState: number;

    constructor(address: string, options?: any);
    send(data: any, cb?: (err?: Error) => void): void;
    close(code?: number, data?: string | Buffer): void;
    ping(data?: any, mask?: boolean, cb?: (err?: Error) => void): void;
    terminate(): void;
  }

  export default WebSocket;
}
