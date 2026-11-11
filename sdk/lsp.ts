/** LSP uses UTF-8 byte lengths, unlike newline-delimited ACP JSON-RPC. */
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function lspFrame(message: any): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${encoder.encode(body).length}\r\n\r\n${body}`;
}
export function decodeBase64(text: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const result: number[] = []; let bits = 0, value = 0;
  for (const c of text.replace(/=+$/, "")) {
    const n = alphabet.indexOf(c);
    if (n < 0) throw new Error("Invalid base64 stream");
    value = (value << 6) | n; bits += 6;
    if (bits >= 8) { bits -= 8; result.push((value >> bits) & 255); }
  }
  return new Uint8Array(result);
}
export class LspPeer {
  private buffer = new Uint8Array(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private writes = Promise.resolve();
  private closed: Error | null = null;
  onRequest: (method: string, params: any) => Promise<any> = async method => { throw Object.assign(new Error(`Unsupported request: ${method}`), { code: -32601 }); };
  onNotification: (method: string, params: any) => void = () => {};
  constructor(private send: (frame: string) => Promise<void>) {}
  private write(message: any): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    const next = this.writes.then(() => this.send(lspFrame(message)));
    this.writes = next.catch(e => this.fail(e));
    return next;
  }
  feed(bytes: Uint8Array) {
    if (this.closed) return;
    try {
      if (this.buffer.length + bytes.length > 16 * 1024 * 1024) throw new Error("LSP message exceeds 16 MiB");
      const buffer = new Uint8Array(this.buffer.length + bytes.length);
      buffer.set(this.buffer); buffer.set(bytes, this.buffer.length); this.buffer = buffer;
      while (this.buffer.length) {
        let end = -1;
        for (let i = 0; i + 3 < this.buffer.length; i++) if (this.buffer[i] === 13 && this.buffer[i + 1] === 10 && this.buffer[i + 2] === 13 && this.buffer[i + 3] === 10) { end = i; break; }
        if (end < 0) { if (this.buffer.length > 8192) throw new Error("LSP header too large"); return; }
        if (end > 8192) throw new Error("LSP header too large");
        const header = decoder.decode(this.buffer.slice(0, end));
        const lengths = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
        if (lengths.length !== 1) throw new Error("Invalid LSP Content-Length");
        const length = Number(lengths[0][1]);
        if (length > 16 * 1024 * 1024) throw new Error("LSP message exceeds 16 MiB");
        if (this.buffer.length < end + 4 + length) return;
        const message = JSON.parse(decoder.decode(this.buffer.slice(end + 4, end + 4 + length)));
        this.buffer = this.buffer.slice(end + 4 + length); this.handle(message);
      }
    } catch (error) { this.fail(error); }
  }
  private handle(message: any) {
    if (message?.jsonrpc !== "2.0") throw new Error("Invalid LSP response");
    if (typeof message.method === "string") {
      if (message.id != null) {
        void Promise.resolve().then(() => this.onRequest(message.method, message.params)).then(
          result => this.write({ jsonrpc: "2.0", id: message.id, result: result ?? null }),
          error => this.write({ jsonrpc: "2.0", id: message.id, error: { code: typeof error.code === "number" ? error.code : -32603, message: String(error.message || error) } }),
        ).catch(() => {});
      } else this.onNotification(message.method, message.params);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || "LSP request failed"));
    else pending.resolve(message.result);
  }
  request(method: string, params?: any, timeoutMs = 30000): Promise<any> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`${method} timed out`));
        void this.notify("$/cancelRequest", { id }).catch(() => {});
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ jsonrpc: "2.0", id, method, params }).catch(error => this.fail(error));
    });
  }
  notify(method: string, params?: any): Promise<void> { return this.write({ jsonrpc: "2.0", method, params }); }
  fail(reason: unknown) {
    if (this.closed) return;
    this.closed = reason instanceof Error ? reason : new Error(String(reason));
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(this.closed); }
    this.pending.clear(); this.buffer = new Uint8Array(0);
  }
  get alive() { return !this.closed; }
}

// Semantic token kinds a client accepts; editors use them to tell interfaces from classes, fields
// from locals, and so on.
export const SEMANTIC_TYPES = ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property",
  "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"];
/** Decode relative semantic tokens into `{identifier: kind}`; a name used with several kinds is dropped. */
export function semanticNames(result: any, legend: any, text: string): Record<string, string> {
  const data: unknown = result?.data, types: unknown = legend?.tokenTypes;
  if (!Array.isArray(data) || !Array.isArray(types)) return {};
  const lines = text.split("\n"), out = new Map<string, string | null>();
  let line = 0, start = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const [dl, ds, length, type] = [data[i], data[i + 1], data[i + 2], data[i + 3]].map(Number);
    if (![dl, ds, length, type].every(Number.isInteger)) break;
    line += dl; start = dl ? ds : start + ds;
    const kind = types[type];
    if (typeof kind !== "string" || length < 1 || length > 128) continue;
    const name = lines[line]?.slice(start, start + length);
    if (!name || !/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name)) continue;
    const seen = out.get(name);
    out.set(name, seen === undefined || seen === kind ? kind : null);
    if (out.size > 5000) break;
  }
  return Object.fromEntries([...out].filter((entry): entry is [string, string] => entry[1] !== null));
}
