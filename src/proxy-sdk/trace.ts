// Trace files (mode 0600). `<path>` holds the bytes written to the worker,
// `<path>.client` the bytes from the worker. Any failure is fatal: the caller
// does not catch it.

import { closeSync, fchmodSync, openSync, writeSync } from "node:fs";

export const TRACE_ENV = "AOE_ACP_PROXY_TRACE";

export interface Trace {
  agent(buf: Buffer): void;
  client(buf: Buffer): void;
  close(): void;
}

function append(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    offset += writeSync(fd, buf, offset);
  }
}

export function openTrace(path: string): Trace {
  const agentFd = openSync(path, "w", 0o600);
  let clientFd = -1;
  try {
    fchmodSync(agentFd, 0o600);
    clientFd = openSync(`${path}.client`, "w", 0o600);
    fchmodSync(clientFd, 0o600);
  } catch (err) {
    closeSync(agentFd);
    if (clientFd !== -1) {
      closeSync(clientFd);
    }
    throw err;
  }
  // After close, late writes are dropped: the fd numbers may already be reused.
  let closed = false;
  return {
    agent: (buf) => {
      if (!closed) {
        append(agentFd, buf);
      }
    },
    client: (buf) => {
      if (!closed) {
        append(clientFd, buf);
      }
    },
    close: () => {
      closed = true;
      closeSync(agentFd);
      closeSync(clientFd);
    },
  };
}
