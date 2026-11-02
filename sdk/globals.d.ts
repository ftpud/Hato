// Globals provided by the kernel prelude inside each module's QuickJS runtime (no DOM, no Node).
declare const console: { log(...a: any[]): void; info(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void; debug(...a: any[]): void };
declare function setTimeout(fn: (...a: any[]) => void, ms?: number, ...args: any[]): number;
declare function clearTimeout(id: any): void;
declare function setInterval(fn: (...a: any[]) => void, ms?: number, ...args: any[]): number;
declare function clearInterval(id: any): void;
declare function queueMicrotask(fn: () => void): void;
declare const crypto: { randomUUID(): string; randomHex(bytes?: number): string };
declare class TextEncoder { encode(s: string): Uint8Array }
declare class TextDecoder { decode(b: Uint8Array): string }
interface Console { log(...a: any[]): void; info(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void; debug(...a: any[]): void }
declare module "*.sql" { const text: string; export default text; }
declare module "*.md" { const text: string; export default text; }
