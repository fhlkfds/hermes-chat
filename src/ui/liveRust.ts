// The Rust side of several live connections, as tests of the whole App stand it in (ADR 0125): each command is routed
// by the attempt that opened its connection, as `Slots` does, a connect past the owner's limit is refused, and the
// keyring keeps one entry per saved connection. A test hands its `invoke` to a `vi.mock` of `@tauri-apps/api/core`.
import type { FakeHermes } from "../hermes/fakeHermes";
import type { Pipe, PipeEvent } from "../hermes/pipe";

/** `servers` and `passwords` are by dashboard URL. */
export function liveRust(servers: Record<string, FakeHermes>, passwords: Record<string, string>) {
  const keyring = new Map<string, string>();
  /** Every sign-in Rust was asked for: where to, with which password, under which saved connection. */
  const connects: { url: string; password: string; saved: string }[] = [];
  /** The connections Rust holds, by the attempt that opened each. */
  const held = new Map<string, { url: string; saved: string; pipe: Pipe }>();
  const notices: { title: string; body: string; tag?: string; deny?: boolean }[] = [];
  /** A sign-in that waits until the test lets it go, by URL. */
  const heldBack: Record<string, Promise<void>> = {};
  /** What the tray was told needs the owner, in order. */
  const trayCounts: number[] = [];

  const holding = (attempt: unknown) => {
    const h = held.get(attempt as string);
    if (!h) throw "The connection is closed.";
    return h.pipe;
  };

  const invoke = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const slot = `${cmd.split("_")[0]}:${(args.connection as string | null) ?? "legacy"}`;
    switch (cmd) {
      case "hermes_connect": {
        const url = (args.target as { url: string }).url;
        const saved = args.savedConnection as string;
        const { password } = args.credential as { password: string };
        await heldBack[url];
        const limit = (args.liveLimit as number | null) ?? 1;
        // src-tauri live.rs `Slots::evict_for`.
        const others = [...held.entries()].filter(([, h]) => h.saved !== saved);
        if (limit > 1 && others.length >= limit) throw `Highwing already has ${limit} connections open, the most it keeps open. Disconnect one first.`;
        for (const [a, h] of held) if (limit <= 1 || h.saved === saved) (held.delete(a), h.pipe.close());
        connects.push({ url, password, saved });
        if (passwords[url] !== password) throw "Wrong username or password.";
        const channel = args.onEvent as { onmessage: (e: PipeEvent) => void };
        const pipe = await servers[url].openPipe((e) => channel.onmessage(e), args.profile as string);
        held.set(args.attempt as string, { url, saved, pipe });
        return { kind: "url", url, addresses: [] };
      }
      case "hermes_probe": {
        const url = (args.target as { url: string }).url;
        if (passwords[url] !== (args.credential as { password: string }).password) throw { stage: "sign-in", message: "Wrong username or password." };
        return {
          route: { kind: "url", url, addresses: [] },
          status: '{"version":"0.22.5","auth_required":true,"auth_providers":["basic"]}',
          ready: JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: servers[url].readyPayload } }),
        };
      }
      case "hermes_send":
        return holding(args.attempt).send(args.frame as string);
      case "hermes_request":
        return holding(args.attempt).request(args.method as "GET", args.path as string, args.body as string | undefined);
      case "hermes_disconnect": {
        const h = held.get(args.attempt as string);
        held.delete(args.attempt as string);
        return h?.pipe.close();
      }
      case "tray_inbox":
        return void trayCounts.push(args.count as number);
      case "notify_desktop":
        return void notices.push(args as (typeof notices)[number]);
      case "password_load":
      case "headers_load":
        return keyring.get(slot) ?? null;
      case "password_save":
        return void keyring.set(slot, args.password as string);
      case "headers_save":
        return void keyring.set(slot, args.headers as string);
      case "password_delete":
      case "headers_delete":
        return void keyring.delete(slot);
      default:
        return undefined;
    }
  };

  return { invoke, keyring, connects, held, notices, heldBack, trayCounts };
}
