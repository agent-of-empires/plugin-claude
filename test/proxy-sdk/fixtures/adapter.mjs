/* global process, setTimeout, setInterval */
// Fixture ACP adapter. The first argument selects the mode.
//   echo               copy stdin to stdout, exit 0 on stdin EOF
//   eof                on stdin EOF write {"eof":true} and exit 3
//   emit <file> <code> on stdin EOF write the file's bytes to stdout, exit <code>
//   acp                answer initialize and session/new, then send three updates
//   term               print ready, then exit 5 on SIGTERM after printing the count
//   ignore-term        print ready, then ignore SIGTERM forever
import { readFileSync } from "node:fs";

const [mode, file, code] = process.argv.slice(2);

if (mode === "echo") {
  // pipe() ends stdout after the last write, so the process exits on its own.
  process.stdin.pipe(process.stdout);
} else if (mode === "eof") {
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.stdout.write('{"eof":true}\n', () => process.exit(3));
  });
} else if (mode === "emit") {
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.stdout.write(readFileSync(file), () => process.exit(Number(code ?? 0)));
  });
} else if (mode === "acp") {
  let buf = "";
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const update = (s, body) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: body } });
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { protocolVersion: 1, agent_info: { name: "fixture" }, _meta: { vendor: { x: 1 }, aoe: { other: true } } },
        });
      } else if (msg.method === "session/new") {
        send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });
        update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
        update("s1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Task" });
        update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "bye" } });
      }
    }
  });
  process.stdin.on("end", () => process.stdout.end());
} else if (mode === "term") {
  let count = 0;
  process.on("SIGTERM", () => {
    count += 1;
    setTimeout(() => process.stdout.write(JSON.stringify({ term: count }) + "\n", () => process.exit(5)), 50);
  });
  process.stdout.write('{"ready":true}\n');
  setInterval(() => {}, 1000);
} else if (mode === "ignore-term") {
  process.on("SIGTERM", () => {});
  process.stdout.write('{"ready":true}\n');
  setInterval(() => {}, 1000);
}
