// A userspace stand-in for a slower link between this computer and the server (no root, so no `tc netem`): a TCP
// proxy that holds every chunk for a fixed one-way delay and lets bytes out no faster than a bandwidth cap, each
// direction on its own. Queues are unbounded, like a link with a big buffer. Chunks leave strictly in order (one FIFO
// per direction), since separate timers can fire out of order.
//   node netem.mjs <listen port> <target port> <one-way delay ms> <megabits per second>
import { createServer, connect } from "node:net";

const [listen, target, delayMs, mbps] = process.argv.slice(2).map(Number);
const bytesPerMs = (mbps * 1e6) / 8 / 1000;

function pipe(from, to) {
  let free = 0; // when the link is next free, ms (performance.now)
  const queue = []; // [due ms, chunk | null for end]
  let timer;
  const pump = () => {
    timer = undefined;
    const now = performance.now();
    while (queue.length && queue[0][0] <= now) {
      const [, chunk] = queue.shift();
      if (chunk === null) to.end();
      else if (to.writable) to.write(chunk);
    }
    if (queue.length) timer = setTimeout(pump, Math.max(0, queue[0][0] - now));
  };
  const push = (chunk, bytes) => {
    const now = performance.now();
    free = Math.max(free, now) + bytes / bytesPerMs;
    queue.push([free + delayMs, chunk]);
    if (!timer) timer = setTimeout(pump, Math.max(0, queue[0][0] - now));
  };
  from.on("data", (chunk) => push(chunk, chunk.length));
  from.on("end", () => push(null, 0));
  from.on("error", () => to.destroy());
}

createServer((client) => {
  client.setNoDelay(true);
  const server = connect(target, "127.0.0.1");
  server.setNoDelay(true);
  pipe(client, server);
  pipe(server, client);
  server.on("close", () => client.destroy());
  client.on("close", () => server.destroy());
}).listen(listen, "127.0.0.1", () => console.log(`netem ${listen} -> ${target}: ${delayMs} ms each way, ${mbps} Mbit/s`));
