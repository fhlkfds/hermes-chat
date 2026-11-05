// A measuring RFB client for the Screen latency work (issue #172). It speaks to Hermes's `/api/display/ws` as noVNC 1.7
// does with Hermes's Xvnc (TigerVNC): the same pixel format, Tight first, quality and compression levels, fences and
// continuous updates. It doesn't draw anything: it parses each update only far enough to know where it ends, and
// records when every message arrived, so frame rate, bytes and lag can be timed.

const enc = {
  copyRect: 1,
  tight: 7,
  zrle: 16,
  zlib: 6,
  raw: 0,
  desktopSize: -223,
  lastRect: -224,
  cursor: -239,
  extDesktopSize: -308,
  fence: -312,
  continuous: -313,
  desktopName: -307,
};

/** A byte queue that `await`s until enough has arrived. Each read reports when its last byte came in. */
class Reader {
  chunks = [];
  len = 0;
  waiting = null;
  lastAt = 0;
  push(buf, at) {
    this.chunks.push({ buf, at });
    this.len += buf.length;
    if (this.waiting && this.len >= this.waiting.n) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve();
    }
  }
  async take(n) {
    if (this.len < n) await new Promise((resolve) => (this.waiting = { n, resolve }));
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const k = Math.min(n - off, c.buf.length);
      c.buf.copy(out, off, 0, k);
      off += k;
      this.lastAt = c.at;
      if (k === c.buf.length) this.chunks.shift();
      else c.buf = c.buf.subarray(k);
    }
    this.len -= n;
    return out;
  }
  async skip(n) {
    while (n > 0) {
      const k = Math.min(n, 1 << 20);
      await this.take(k);
      n -= k;
    }
  }
}

/** Xvnc's own socket, straight, shaped like the WebSocket above: to tell Xvnc's time from the bridge's. */
async function unixSocket(path) {
  const { connect } = await import("node:net");
  const sock = connect(path);
  const shim = { onmessage: null, onclose: null, onopen: null, onerror: null };
  sock.setNoDelay(true);
  sock.on("connect", () => shim.onopen?.());
  sock.on("error", (e) => shim.onerror?.(e));
  sock.on("data", (d) => shim.onmessage?.({ data: d }));
  sock.on("close", () => shim.onclose?.({ code: 1006, reason: "" }));
  shim.send = (b) => sock.write(b);
  shim.close = () => sock.end();
  return shim;
}

const u16 = (v) => Buffer.from([v >> 8, v & 255]);
const i32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v);
  return b;
};

/**
 * Connects to `url` (a ws:// URL with the display ticket) and runs the RFB session. `opts.quality` and
 * `opts.compression` are noVNC's levels. Returns a handle with the recorded `frames`, `fences` and helpers to send
 * input.
 */
export async function connectRfb(url, opts = {}) {
  const { quality = 7, compression = 2, onFrame } = opts;
  const ws = String(url).startsWith("unix:") ? await unixSocket(String(url).slice(5)) : new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const r = new Reader();
  const stats = { messages: 0, bytes: 0, firstAt: 0 };
  ws.onmessage = (m) => {
    const at = performance.now();
    const buf = Buffer.from(m.data);
    stats.messages++;
    stats.bytes += buf.length;
    r.push(buf, at);
  };
  let closed;
  const closedP = new Promise((res) => (ws.onclose = (e) => res((closed = { code: e.code, reason: e.reason }))));
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error("display socket failed: " + (e.message ?? "")));
  });
  const send = (...parts) => ws.send(Buffer.concat(parts));

  // Handshake (RFB 3.8, security None, shared).
  const version = (await r.take(12)).toString();
  send(Buffer.from("RFB 003.008\n"));
  const nTypes = (await r.take(1))[0];
  const types = [...(await r.take(nTypes))];
  if (!types.includes(1)) throw new Error("no None security in " + types + " (" + version.trim() + ")");
  send(Buffer.from([1]));
  const result = (await r.take(4)).readUInt32BE();
  if (result !== 0) throw new Error("security failed");
  send(Buffer.from([1]));
  const init = await r.take(24);
  const width = init.readUInt16BE(0);
  const height = init.readUInt16BE(2);
  await r.take(init.readUInt32BE(20));

  // noVNC's pixel format: 32 bpp, depth 24, little-endian, red 0, green 8, blue 16.
  send(Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]));
  const encs = [enc.copyRect, enc.tight, enc.zrle, enc.zlib, enc.raw, -32 + quality, -256 + compression, enc.desktopSize, enc.lastRect, enc.extDesktopSize, enc.fence, enc.continuous, enc.desktopName, enc.cursor];
  send(Buffer.from([2, 0]), u16(encs.length), ...encs.map(i32));
  const fbRequest = (incremental) => send(Buffer.from([3, incremental ? 1 : 0]), u16(0), u16(0), u16(width), u16(height));
  fbRequest(false);

  const frames = []; // { start, end, bytes, rects }
  const fences = []; // client-initiated fence round trips, ms
  let continuous = false;
  let pendingFence = null;
  let tightResets = 0;

  const compactLen = async () => {
    let b = (await r.take(1))[0];
    let len = b & 0x7f;
    if (b & 0x80) {
      b = (await r.take(1))[0];
      len |= (b & 0x7f) << 7;
      if (b & 0x80) len |= (await r.take(1))[0] << 14;
    }
    return len;
  };

  async function tightRect(w, h) {
    const ctl = (await r.take(1))[0];
    tightResets += ctl & 0x0f ? 1 : 0;
    const kind = ctl >> 4;
    if (kind === 0x08) return void (await r.take(3)); // fill
    if (kind === 0x09) return void (await r.skip(await compactLen())); // JPEG
    let filter = 0;
    if (ctl & 0x40) filter = (await r.take(1))[0];
    let size = w * h * 3;
    if (filter === 1) {
      const colours = (await r.take(1))[0] + 1;
      await r.take(colours * 3);
      size = colours === 2 ? Math.ceil(w / 8) * h : w * h;
    }
    if (size < 12) await r.take(size);
    else await r.skip(await compactLen());
  }

  async function update() {
    const head = await r.take(3);
    const start = r.lastAt;
    const bytesBefore = stats.bytes - r.len - 4;
    let n = head.readUInt16BE(1);
    let rects = 0;
    for (let i = 0; i < n || n === 0xffff; i++) {
      const rh = await r.take(12);
      const [x, y, w, h] = [0, 2, 4, 6].map((o) => rh.readUInt16BE(o));
      const e = rh.readInt32BE(8);
      rects++;
      if (e === enc.lastRect) break;
      else if (e === enc.tight) await tightRect(w, h);
      else if (e === enc.copyRect) await r.take(4);
      else if (e === enc.zrle || e === enc.zlib) await r.skip((await r.take(4)).readUInt32BE());
      else if (e === enc.raw) await r.skip(w * h * 4);
      else if (e === enc.cursor) await r.skip(w * h * 4 + Math.ceil(w / 8) * h);
      else if (e === enc.desktopSize) {
      } else if (e === enc.extDesktopSize) {
        const s = await r.take(4);
        await r.skip(s[0] * 16);
      } else if (e === enc.desktopName) await r.skip((await r.take(4)).readUInt32BE());
      else throw new Error(`unhandled encoding ${e} at ${x},${y} ${w}x${h}`);
    }
    const frame = { start, end: r.lastAt, bytes: stats.bytes - r.len - bytesBefore, rects };
    frames.push(frame);
    onFrame?.(frame);
    if (!continuous) fbRequest(true);
  }

  (async () => {
    try {
      for (;;) {
        const type = (await r.take(1))[0];
        if (type === 0) await update();
        else if (type === 1) {
          const h = await r.take(5);
          await r.skip(h.readUInt16BE(3) * 6);
        } else if (type === 2) {
        } else if (type === 3) {
          const h = await r.take(7);
          await r.skip(Math.abs(h.readInt32BE(3)));
        } else if (type === 150) {
          if (!continuous) {
            continuous = true;
            send(Buffer.from([150, 1]), u16(0), u16(0), u16(width), u16(height));
          }
        } else if (type === 248) {
          const h = await r.take(8);
          const flags = h.readUInt32BE(3);
          const payload = await r.take(h[7]);
          if (flags & 0x80000000) {
            // The server's request: answer at once, as noVNC does once it has processed what came before.
            const f = Buffer.alloc(4);
            f.writeUInt32BE(flags & 3);
            send(Buffer.from([248, 0, 0, 0]), f, Buffer.from([payload.length]), payload);
          } else if (pendingFence && payload.toString() === pendingFence.tag) {
            fences.push(r.lastAt - pendingFence.at);
            pendingFence.resolve();
            pendingFence = null;
          }
        } else if (type === 250) await r.take(3);
        else throw new Error("unknown server message " + type);
      }
    } catch (e) {
      if (!closed) console.error("rfb:", e.message);
    }
  })();

  return {
    width,
    height,
    frames,
    fences,
    stats,
    closed: closedP,
    get continuous() {
      return continuous;
    },
    /** A fence of our own, for the round trip through the relay with nothing else in the way. */
    fence() {
      const tag = Math.random().toString(36).slice(2, 10);
      const flags = Buffer.alloc(4);
      flags.writeUInt32BE(0x80000000);
      return new Promise((resolve) => {
        pendingFence = { tag, at: performance.now(), resolve };
        send(Buffer.from([248, 0, 0, 0]), flags, Buffer.from([tag.length]), Buffer.from(tag));
      });
    },
    key(keysym) {
      const k = Buffer.alloc(4);
      k.writeUInt32BE(keysym);
      send(Buffer.from([4, 1, 0, 0]), k);
      send(Buffer.from([4, 0, 0, 0]), k);
    },
    click(x, y) {
      send(Buffer.from([5, 1]), u16(x), u16(y));
      send(Buffer.from([5, 0]), u16(x), u16(y));
    },
    close: () => ws.close(1000),
  };
}
