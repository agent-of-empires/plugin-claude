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

  /** Resolves once every queued write has been handed to the stream. */
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

  private async send(buf: Buffer): Promise<void> {
    if (this.error) {
      throw this.error;
    }
    this.onWrite?.(buf);
    if (this.stream.write(buf)) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const stream = this.stream;
      const done = (err?: Error) => {
        stream.off("drain", onDrain);
        stream.off("error", done);
        stream.off("close", onClose);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };
      const onDrain = () => done();
      const onClose = () => done(new Error("stream closed"));
      stream.once("drain", onDrain);
      stream.once("error", done);
      stream.once("close", onClose);
    });
  }
}
