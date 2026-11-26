// One FIFO write queue per stream. Each write is a whole framed Buffer, so
// concurrent producers never interleave partial lines.

import type { Writable } from "node:stream";

export class FrameWriter {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private error: Error | null = null;

  constructor(
    private readonly stream: Writable,
    private readonly onWrite?: (buf: Buffer) => void,
  ) {
    stream.on("error", (err) => {
      this.error ??= err;
    });
  }

  write(buf: Buffer): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("write after close"));
    }
    const result = this.tail.then(() => this.send(buf));
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Resolves once every queued write has completed. */
  flush(): Promise<void> {
    return this.tail;
  }

  /** Flushes, then refuses further writes. */
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }

  /** Closes the writer, then ends the underlying stream. */
  async end(): Promise<void> {
    await this.close();
    this.stream.end();
  }

  // Resolves when the write callback fires, which also reports async errors.
  private send(buf: Buffer): Promise<void> {
    if (this.error) {
      return Promise.reject(this.error);
    }
    this.onWrite?.(buf);
    return new Promise<void>((resolve, reject) => {
      this.stream.write(buf, (err) => (err ? reject(err) : resolve()));
    });
  }
}
