// Byte-preserving NDJSON splitter. Lines keep their delimiter (\n or \r\n).

const LF = 0x0a;

export class LineSplitter {
  private pending: Buffer = Buffer.alloc(0);

  /** Returns every complete line in the data so far, each with its delimiter. */
  push(chunk: Buffer): Buffer[] {
    const data = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const lines: Buffer[] = [];
    let start = 0;
    for (let i = data.indexOf(LF, start); i !== -1; i = data.indexOf(LF, start)) {
      lines.push(data.subarray(start, i + 1));
      start = i + 1;
    }
    this.pending = Buffer.from(data.subarray(start));
    return lines;
  }

  /** The final unterminated chunk, if any. */
  end(): Buffer | null {
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    return rest.length > 0 ? rest : null;
  }
}

/** Splits a line into its content and delimiter. */
export function splitDelimiter(line: Buffer): { body: Buffer; delimiter: Buffer } {
  if (line.length === 0 || line[line.length - 1] !== LF) {
    return { body: line, delimiter: Buffer.alloc(0) };
  }
  const cut = line.length >= 2 && line[line.length - 2] === 0x0d ? 2 : 1;
  return { body: line.subarray(0, line.length - cut), delimiter: line.subarray(line.length - cut) };
}
