// A zip archive for tests, each file deflated, with the sizes its directory gives set apart from the real ones, as a
// crafted file can.

export type ZipFile = { name: string; data: Uint8Array<ArrayBuffer>; claims?: number };

const deflated = async (data: Uint8Array<ArrayBuffer>) => {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({ start: (c) => (c.enqueue(data), c.close()) });
  return new Uint8Array(await new Response(source.pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
};

function record(fields: [bytes: 2 | 4, value: number][], name: Uint8Array) {
  const head = new Uint8Array(fields.reduce((n, [bytes]) => n + bytes, 0));
  const view = new DataView(head.buffer);
  let at = 0;
  for (const [bytes, value] of fields) {
    if (bytes === 2) view.setUint16(at, value, true);
    else view.setUint32(at, value, true);
    at += bytes;
  }
  return [head, name];
}

export async function fakeZip(files: ZipFile[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const packed = await deflated(f.data);
    const size = f.claims ?? f.data.length;
    const local = record([[4, 0x04034b50], [2, 20], [2, 0], [2, 8], [2, 0], [2, 0], [4, 0], [4, packed.length], [4, size], [2, name.length], [2, 0]], name);
    // prettier-ignore
    directory.push(...record([[4, 0x02014b50], [2, 20], [2, 20], [2, 0], [2, 8], [2, 0], [2, 0], [4, 0], [4, packed.length], [4, size],
      [2, name.length], [2, 0], [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]], name));
    parts.push(...local, packed);
    offset += local[0].length + name.length + packed.length;
  }
  const dirLength = directory.reduce((n, p) => n + p.length, 0);
  const end = record([[4, 0x06054b50], [2, 0], [2, 0], [2, files.length], [2, files.length], [4, dirLength], [4, offset], [2, 0]], new Uint8Array());
  const all = [...parts, ...directory, ...end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  all.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
}
