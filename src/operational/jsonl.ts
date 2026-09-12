import { StringDecoder } from "node:string_decoder";
// Bounded line framing; an oversized line is discarded through its delimiter.
// A complete JSON value without a trailing newline is accepted at EOF.
export class JsonLines {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private dropping = false;
  constructor(
    private readonly accept: (value: unknown) => void,
    private readonly invalid: () => void,
    private readonly limit = 16384,
  ) {}
  write(chunk: Buffer) {
    this.consume(this.decoder.write(chunk));
  }
  private consume(text: string) {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (!this.dropping) {
        this.pending += parts[i];
        if (Buffer.byteLength(this.pending) > this.limit) {
          this.pending = "";
          this.dropping = true;
          this.invalid();
        }
      }
      if (i < parts.length - 1) {
        if (!this.dropping) this.line();
        this.dropping = false;
      }
    }
  }
  private line() {
    const text = this.pending;
    this.pending = "";
    if (!text.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.invalid();
      return;
    }
    this.accept(value);
  }
  end() {
    this.consume(this.decoder.end());
    if (!this.dropping) this.line();
    this.pending = "";
  }
}
