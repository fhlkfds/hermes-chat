// The desktop link inbox (tauriLinks.ts) with Rust stood in for: no link is left behind, or delivered out of order,
// however the IPC calls interleave.
import { describe, expect, it } from "vitest";
import { fromDesktop, linkInbox, type LinkIpc } from "./tauriLinks";

/** Rust's side: the one link it holds (links.rs `Links`), and the event it emits when one arrives. */
function rust() {
  let held: string | null = null;
  let listener: (() => void) | undefined;
  const takes: { resolve: () => void }[] = [];
  let gateTakes = false;
  let registered!: () => void;
  const registering = new Promise<void>((r) => (registered = r));
  const ipc: LinkIpc = {
    take: () => {
      // The answer is what Rust held when the call reached it, as `chat_link_take` is.
      const answer = held;
      held = null;
      if (!gateTakes) return Promise.resolve(answer);
      return new Promise((resolve) => takes.push({ resolve: () => resolve(answer) }));
    },
    onArrived: async (fn) => {
      await registering;
      listener = fn;
    },
  };
  return {
    ipc,
    open(link: string) {
      held = link;
      listener?.();
    },
    finishRegistering: () => registered(),
    gate: (on: boolean) => (gateTakes = on),
    takes,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Links from the desktop", () => {
  it("takes a link that arrives while the listener is still being set up", async () => {
    const r = rust();
    const inbox = linkInbox(fromDesktop(r.ipc));
    inbox.subscribe(() => {});
    await settle();
    expect(inbox.isReady()).toBe(false);
    // Arrives after the app asked to listen, before listening has started: nobody hears the event.
    r.open("hermes-chat://chat?first");
    r.finishRegistering();
    await settle();
    await settle();
    expect(inbox.getSnapshot()?.raw).toBe("hermes-chat://chat?first");
    expect(inbox.isReady()).toBe(true);
  });

  it("delivers links in the order Rust handed them out, however slowly each take answers", async () => {
    const r = rust();
    const inbox = linkInbox(fromDesktop(r.ipc));
    const seen: string[] = [];
    inbox.subscribe(() => {
      const raw = inbox.getSnapshot()?.raw;
      if (raw && seen.at(-1) !== raw) seen.push(raw);
    });
    r.finishRegistering();
    await settle();
    await settle();
    r.gate(true);
    r.open("hermes-chat://chat?older");
    r.open("hermes-chat://chat?newer");
    await settle();
    // Takes run one at a time: the second hasn't been asked yet.
    expect(r.takes).toHaveLength(1);
    r.takes[0].resolve();
    await settle();
    await settle();
    expect(r.takes).toHaveLength(2);
    r.takes[1].resolve();
    await settle();
    await settle();
    // Rust kept only the newer one, and nothing older can land over it.
    expect(seen).toEqual(["hermes-chat://chat?newer"]);
    expect(inbox.getSnapshot()?.raw).toBe("hermes-chat://chat?newer");
  });

  it("is ready at once with no desktop, and a cleared link stays cleared unless a newer one arrives", () => {
    const inbox = linkInbox();
    expect(inbox.isReady()).toBe(true);
    inbox.arrive("a");
    const first = inbox.getSnapshot()!;
    inbox.arrive("b");
    inbox.clear(first.at);
    expect(inbox.getSnapshot()?.raw).toBe("b");
    inbox.clear(inbox.getSnapshot()!.at);
    expect(inbox.getSnapshot()).toBeUndefined();
  });
});
