// Everywhere search (everywhere.ts, issue #608) with two real `Hermes` on two FakeHermes in a real `LiveConnections`:
// Alpha is the composer target and Bravo a background connection. Each test reads what a caller gets (rows, outcomes)
// and what the servers got (which profiles were searched, and how many requests were in flight at once).
import { afterEach, describe, expect, it } from "vitest";
import { BOT_CHAT_TITLE } from "./bots";
import type { SavedConnection } from "./connections";
import { searchEverywhere, type EverywhereFilter, type EverywhereOutcome } from "./everywhere";
import { FakeHermes, row, type SessionRow } from "./fakeHermes";
import { BACKGROUND_READS_AT_ONCE, LiveConnections } from "./liveConnections";
import { RestError, type OpenPipe } from "./pipe";
import type { SignInDetails } from "./tauriPipe";
import { BackgroundRefused, connect, type Hermes } from "./transport";

const DAY = 86_400_000;
const day = (daysAgo: number) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const saved = (name: string): SavedConnection => ({ id: name.toLowerCase(), name, mode: "url", sshTarget: "", url: `https://${name.toLowerCase()}.example.com`, username: "owner", addedAt: 0 });

type Seed = [id: string, title: string, daysAgo: number, said: string, over?: Partial<SessionRow>];

/** A FakeHermes holding `profiles`, each with its chats. `default` is always one of them. */
function serverWith(profiles: Record<string, Seed[]>): FakeHermes {
  const server = new FakeHermes();
  for (const [profile, seeds] of Object.entries(profiles)) {
    const rows = seeds.map(([id, title, daysAgo, , over]) => row(id, daysAgo, { title, ...over }));
    if (profile === "default") server.sessions = rows;
    else server.otherProfiles[profile] = rows;
    for (const [id, , , said] of seeds) server.transcripts[id] = [{ role: "user", text: said }];
  }
  return server;
}

const alphaChats = (): Record<string, Seed[]> => ({
  default: [
    ["a1", "Nightly backup", 1, "Why did the backup fail?", { model: "claude-opus-5-5" }],
    ["a2", "Garden plan", 2, "Plant the tomatoes."],
    ["bot", BOT_CHAT_TITLE, 1, "Remind me about the backup."],
  ],
  work: [
    ["w1", "Deploy backup", 3, "Ship the backup script.", { model: "gpt-6.1" }],
    ["w2", "Old backup notes", 40, "The backup plan from last month."],
  ],
  ops: [["o1", "Pager", 1, "Nothing about that word here."]],
});
const bravoChats = (): Record<string, Seed[]> => ({
  default: [["a1", "NAS backup", 2, "Where does the backup land?", { model: "claude-sonnet-5-5" }]],
  home: [["h1", "Photos", 5, "Run a backup of the photos.", { model: "claude-opus-5-5" }]],
});

/**
 * The requests the app has in flight on its pipes to these servers, counted where the relay is: `most` is the most at
 * once. While `holding`, each request waits here until a test lets it go, so a test decides what answers when.
 */
function relay() {
  const flight = { now: 0, most: 0, holding: false, held: [] as { server: string; path: string; go: () => void }[] };
  const open =
    (name: string, server: FakeHermes): OpenPipe =>
    async (...args) => {
      const pipe = await server.openPipe(...args);
      const counted = async (pathAndQuery: string, send: () => Promise<string>) => {
        flight.most = Math.max(flight.most, ++flight.now);
        try {
          if (flight.holding) await new Promise<void>((go) => flight.held.push({ server: name, path: pathAndQuery.split("?")[0], go }));
          return await send();
        } finally {
          flight.now--;
        }
      };
      return {
        ...pipe,
        request: (method, pathAndQuery, body) => counted(pathAndQuery, () => pipe.request(method, pathAndQuery, body)),
        getLimited: (pathAndQuery, maxBytes) => counted(pathAndQuery, () => pipe.getLimited(pathAndQuery, maxBytes)),
      };
    };
  const release = (which: (h: { server: string; path: string }) => boolean = () => true, count = Infinity) => {
    const going = flight.held.filter(which).slice(0, count);
    flight.held = flight.held.filter((h) => !going.includes(h));
    going.forEach((h) => h.go());
    return going.length;
  };
  return { flight, open, release };
}

const running: { hermes: Hermes[]; live: LiveConnections }[] = [];
afterEach(async () => {
  for (const { hermes, live } of running.splice(0)) {
    live.stop();
    await Promise.all(hermes.map((h) => h.close()));
  }
});

async function until(ok: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Waits for the check a connection makes of its capabilities a moment after it opens, so it sends nothing later. */
const checked = (h: Hermes) => until(() => !h.capabilities.getSnapshot().checking && h.capabilities.getSnapshot().checkedAt !== undefined, 8000);

/** Alpha as the composer target and Bravo in the background, both signed in. `settled`: their own checks are done. */
async function fleet({ alpha = serverWith(alphaChats()), bravo = serverWith(bravoChats()), settled = true } = {}) {
  const wire = relay();
  const a = await connect(wire.open("Alpha", alpha));
  const b = await connect(wire.open("Bravo", bravo));
  const live = new LiveConnections();
  running.push({ hermes: [a, b], live });
  await Promise.all([a.sync(), b.sync()]);
  live.add({ connection: saved("Alpha"), hermes: a, details: {} as SignInDetails }, true);
  live.add({ connection: saved("Bravo"), hermes: b, details: {} as SignInDetails }, false);
  if (settled) await Promise.all([checked(a), checked(b)]);
  const search = (filter: EverywhereFilter, signal = new AbortController().signal, onUpdate?: (o: EverywhereOutcome) => void) => searchEverywhere(filter, { live, signal, onUpdate });
  return { alpha, bravo, a, b, live, search, ...wire };
}

const searched = (server: FakeHermes) => server.restRequests.filter((r) => r.path === "/api/sessions/search" && r.query.get("q")).map((r) => r.query.get("profile"));
const where = (o: EverywhereOutcome) => o.rows.map((r) => [r.server, r.ref.profile, r.hit.title]);
const outcomes = (o: EverywhereOutcome) => Object.fromEntries(o.connections.map((c) => [c.server, c.outcome]));

describe("Searching Everywhere", { timeout: 20_000 }, () => {
  it("finds chats in every profile of both connections, each row naming its server, profile and chat, the target's first", async () => {
    const { alpha, bravo, b, search } = await fleet();
    const listedOnBravo = b.getSnapshot().chats;

    const o = await search({ text: "backup" });

    expect(where(o)).toEqual([
      ["Alpha", "default", "Nightly backup"],
      ["Alpha", "work", "Deploy backup"],
      ["Alpha", "work", "Old backup notes"],
      ["Bravo", "default", "NAS backup"],
      ["Bravo", "home", "Photos"],
    ]);
    // Both servers have a chat `a1` in `default`: each row says which one it is.
    expect(o.rows.filter((r) => r.ref.chatId === "a1").map((r) => r.ref)).toEqual([
      { connection: "alpha", profile: "default", chatId: "a1" },
      { connection: "bravo", profile: "default", chatId: "a1" },
    ]);
    expect(o.rows[0].hit).toMatchObject({ find: "backup", role: "user", snippet: [{ text: "Why did the " }, { text: "backup", hit: true }, { text: " fail?" }] });
    expect(outcomes(o)).toEqual({
      Alpha: { kind: "listed", leftOut: 0, profiles: ["default", "work", "ops"].map((profile) => ({ profile, outcome: { kind: "searched", capped: false } })) },
      Bravo: { kind: "listed", leftOut: 0, profiles: ["default", "home"].map((profile) => ({ profile, outcome: { kind: "searched", capped: false } })) },
    });
    expect(o.done).toBe(true);
    expect([...searched(alpha)].sort()).toEqual(["default", "ops", "work"]);
    expect([...searched(bravo)].sort()).toEqual(["default", "home"]);

    // Bravo answered as a background connection: its list is as it was, and it still runs no search of its own.
    expect(b.roleNow).toBe("background");
    expect(b.getSnapshot().chats).toBe(listedOnBravo);
    await expect(b.search("backup")).rejects.toBeInstanceOf(BackgroundRefused);
  });

  it("has four requests in flight at once and never five, the profile listings included, and asks each profile once", async () => {
    const many = (n: number, at: string) => Object.fromEntries(Array.from({ length: n }, (_, i): [string, Seed[]] => [i ? `p${i}` : "default", [[`${at}${i}`, `Backup ${at}${i}`, 1, "the backup ran"]]]));
    const { alpha, bravo, search, flight, release } = await fleet({ alpha: serverWith(many(6, "a")), bravo: serverWith(many(5, "b")) });
    flight.most = 0;
    flight.holding = true;
    const paths = new Set<string>();

    const run = search({ text: "backup" });
    let finished = false;
    void run.finally(() => (finished = true));
    while (!finished) {
      await until(() => flight.held.length > 0 || finished);
      // Everything that can start has started before one more answer is let through.
      await new Promise((r) => setTimeout(r, 5));
      expect(flight.now).toBeLessThanOrEqual(BACKGROUND_READS_AT_ONCE);
      flight.held.forEach((h) => paths.add(h.path));
      release(undefined, 1);
    }

    expect(flight.most).toBe(BACKGROUND_READS_AT_ONCE);
    expect([...paths].sort()).toEqual(["api/profiles", "api/sessions/search"]);
    expect([...searched(alpha)].sort()).toEqual(["default", "p1", "p2", "p3", "p4", "p5"]);
    expect([...searched(bravo)].sort()).toEqual(["default", "p1", "p2", "p3", "p4"]);
    expect((await run).rows).toHaveLength(11);
  });

  it("shares its four slots with every other read the live connections make", async () => {
    const { live, search, flight, release } = await fleet();
    let free!: () => void;
    const other = live.readInTurn(() => new Promise<void>((done) => (free = done)));
    flight.most = 0;
    flight.holding = true;

    const run = search({ text: "backup" });
    let finished = false;
    void run.finally(() => (finished = true));
    for (let i = 0; i < 4; i++) {
      await until(() => flight.held.length > 0);
      await new Promise((r) => setTimeout(r, 5));
      release(undefined, 1);
    }
    expect(flight.most).toBe(BACKGROUND_READS_AT_ONCE - 1);

    free();
    await other;
    flight.holding = false;
    release();
    await run;
    expect(finished).toBe(true);
  });

  it("shows rows as each profile answers, while a slower server is still waited for", async () => {
    const { search, flight, release } = await fleet();
    flight.holding = true;
    const seen: EverywhereOutcome[] = [];
    const run = search({ text: "backup" }, undefined, (o) => seen.push(o));

    const alphaDone = () => seen.at(-1)?.connections[0].outcome.kind === "listed" && where(seen.at(-1)!).length === 3;
    while (!alphaDone()) {
      await until(() => flight.held.some((h) => h.server === "Alpha") || alphaDone());
      release((h) => h.server === "Alpha");
    }
    expect(where(seen.at(-1)!).every(([server]) => server === "Alpha")).toBe(true);
    expect(outcomes(seen.at(-1)!).Bravo).toEqual({ kind: "waiting" });
    expect(seen.at(-1)!.done).toBe(false);

    flight.holding = false;
    release();
    const o = await run;
    expect(o.done).toBe(true);
    expect(where(o)).toHaveLength(5);
    expect(seen.at(-1)).toEqual(o);
  });

  it("says which profile gave as many chats as Hermes gives, so more may match there", async () => {
    const full: Seed[] = Array.from({ length: 101 }, (_, i): Seed => [`f${i}`, `Backup run ${i}`, 1, "the backup ran"]);
    const { search } = await fleet({ alpha: serverWith({ ...alphaChats(), work: full }) });
    const o = await search({ text: "backup" });
    expect(outcomes(o).Alpha).toMatchObject({
      profiles: [
        { profile: "default", outcome: { kind: "searched", capped: false } },
        { profile: "work", outcome: { kind: "searched", capped: true } },
        { profile: "ops", outcome: { kind: "searched", capped: false } },
      ],
    });
    expect(o.rows.filter((r) => r.server === "Alpha" && r.ref.profile === "work")).toHaveLength(100);
  });

  it("asks only the profiles whose name holds the bot filter, and counts the ones it left out", async () => {
    const { alpha, bravo, search } = await fleet();
    const o = await search({ text: "backup", bot: " WO " });
    expect(searched(alpha)).toEqual(["work"]);
    expect(searched(bravo)).toEqual([]);
    expect(where(o).map(([server, profile]) => `${server} ${profile}`)).toEqual(["Alpha work", "Alpha work"]);
    expect(outcomes(o)).toEqual({
      Alpha: { kind: "listed", leftOut: 2, profiles: [{ profile: "work", outcome: { kind: "searched", capped: false } }] },
      Bravo: { kind: "listed", leftOut: 2, profiles: [] },
    });
  });

  it("checks the model and the dates here, on the chats Hermes's search gave, and counts chats with no model recorded", async () => {
    const { alpha, bravo, search } = await fleet();

    const opus = await search({ text: "backup", model: "OPUS" });
    expect(where(opus)).toEqual([
      ["Alpha", "default", "Nightly backup"],
      ["Bravo", "home", "Photos"],
    ]);
    // "Old backup notes" on Alpha's work has no model recorded.
    expect(opus.noModel).toBe(1);

    const recent = await search({ text: "backup", from: day(3), to: day(2) });
    expect(where(recent)).toEqual([
      ["Alpha", "work", "Deploy backup"],
      ["Bravo", "default", "NAS backup"],
    ]);
    expect(recent.noModel).toBe(0);

    const asked = [...alpha.restRequests, ...bravo.restRequests].filter((r) => r.path === "/api/sessions/search" && r.query.get("q")).map((r) => [...r.query.keys()].sort().join(" ") + ` limit=${r.query.get("limit")}`);
    expect(new Set(asked)).toEqual(new Set(["exclude_sources limit profile q limit=100"]));
  });

  it("leaves out a connection found to have no chat search, with why, and sends it nothing", async () => {
    const bravo = serverWith(bravoChats());
    delete bravo.rest["GET /api/sessions/search"];
    const { search } = await fleet({ bravo });
    const before = bravo.restRequests.length;

    const o = await search({ text: "backup" });

    expect(outcomes(o).Bravo).toEqual({ kind: "refused", why: expect.stringMatching(/no chat search.*answered 404/) });
    expect(where(o)).toEqual([
      ["Alpha", "default", "Nightly backup"],
      ["Alpha", "work", "Deploy backup"],
      ["Alpha", "work", "Old backup notes"],
    ]);
    expect(o.done).toBe(true);
    expect(bravo.restRequests.slice(before)).toEqual([]);
  });

  it("stops asking a connection once one answer shows it has no chat search, and asks it nothing the next time", async () => {
    const profiles = Object.fromEntries(Array.from({ length: 6 }, (_, i): [string, Seed[]] => [i ? `p${i}` : "default", [[`b${i}`, `Backup ${i}`, 1, "the backup ran"]]]));
    const bravo = serverWith(profiles);
    delete bravo.rest["GET /api/sessions/search"];
    // Searched before either connection has checked what its Hermes can do.
    const { search, flight, release } = await fleet({ bravo, settled: false });
    flight.holding = true;

    const run = search({ text: "backup" });
    await until(() => flight.held.some((h) => h.server === "Bravo" && h.path === "api/profiles"));
    release((h) => h.path === "api/profiles");
    await until(() => flight.held.some((h) => h.server === "Bravo" && h.path === "api/sessions/search"));
    release((h) => h.server === "Bravo" && h.path === "api/sessions/search", 1);
    await until(() => flight.held.every((h) => h.server === "Alpha"));
    flight.holding = false;
    release();
    const o = await run;

    expect(outcomes(o).Bravo).toEqual({ kind: "refused", why: expect.stringMatching(/no chat search/) });
    expect(searched(bravo).length).toBeLessThan(6);
    expect(where(o).every(([server]) => server === "Alpha")).toBe(true);
    expect(where(o)).toHaveLength(3);

    const sent = bravo.restRequests.length;
    expect(outcomes(await search({ text: "backup" })).Bravo).toMatchObject({ kind: "refused" });
    expect(bravo.restRequests.slice(sent).filter((r) => r.path === "/api/sessions/search" || r.path === "/api/profiles")).toEqual([]);
  });

  it("sends nothing to a connection that isn't connected, and says so", async () => {
    const { bravo, b, search } = await fleet();
    bravo.refuse = "The server is down.";
    bravo.drop();
    await until(() => b.getSnapshot().status !== "connected");
    const before = bravo.restRequests.length;

    const o = await search({ text: "backup" });
    expect(outcomes(o).Bravo).toEqual({ kind: "offline", status: b.getSnapshot().status });
    expect(where(o)).toHaveLength(3);
    expect(bravo.restRequests.slice(before)).toEqual([]);
  });

  it("gives the other profiles' rows when one profile's search fails, and names that profile's reason", async () => {
    const alpha = serverWith(alphaChats());
    const find = alpha.rest["GET /api/sessions/search"];
    alpha.rest["GET /api/sessions/search"] = (req) => {
      if (req.query.get("q") && req.query.get("profile") === "work") throw new RestError(500, '{"detail":"The index is locked."}');
      return find(req);
    };
    const { search } = await fleet({ alpha });
    const o = await search({ text: "backup" });
    expect(outcomes(o).Alpha).toMatchObject({
      kind: "listed",
      profiles: [
        { profile: "default", outcome: { kind: "searched" } },
        { profile: "work", outcome: { kind: "failed", why: expect.stringContaining("The index is locked.") } },
        { profile: "ops", outcome: { kind: "searched" } },
      ],
    });
    expect(where(o)).toEqual([
      ["Alpha", "default", "Nightly backup"],
      ["Bravo", "default", "NAS backup"],
      ["Bravo", "home", "Photos"],
    ]);
  });

  it("says a connection's profiles couldn't be listed, and still searches the other connection", async () => {
    const bravo = serverWith(bravoChats());
    const { search } = await fleet({ bravo });
    bravo.rest["GET /api/profiles"] = () => {
      throw new RestError(500, '{"detail":"The profiles folder is unreadable."}');
    };
    const o = await search({ text: "backup" });
    expect(outcomes(o).Bravo).toEqual({ kind: "failed", why: expect.stringContaining("The profiles folder is unreadable.") });
    expect(searched(bravo)).toEqual([]);
    expect(where(o)).toHaveLength(3);
  });

  it("never sends a stopped search's waiting requests, and two searches together stay within the four slots", async () => {
    const many = (n: number, at: string) => Object.fromEntries(Array.from({ length: n }, (_, i): [string, Seed[]] => [i ? `p${i}` : "default", [[`${at}${i}`, `Backup ${at}${i}`, 1, "the backup ran and the restore ran"]]]));
    const { alpha, bravo, search, flight, release } = await fleet({ alpha: serverWith(many(6, "a")), bravo: serverWith(many(6, "b")) });
    flight.most = 0;
    flight.holding = true;

    const stop = new AbortController();
    const first = search({ text: "backup" }, stop.signal);
    const failed = first.then(
      () => undefined,
      (e: unknown) => e,
    );
    await until(() => flight.held.length === 2);
    release();
    await until(() => flight.held.length === BACKGROUND_READS_AT_ONCE);
    stop.abort();
    const second = search({ text: "restore" });
    flight.holding = false;
    release();

    expect(((await failed) as Error).name).toBe("AbortError");
    expect(where(await second)).toHaveLength(12);
    const words = (server: FakeHermes, q: string) => server.restRequests.filter((r) => r.path === "/api/sessions/search" && r.query.get("q") === q).length;
    // The first search got as far as the four requests in flight when it was stopped.
    expect(words(alpha, "backup") + words(bravo, "backup")).toBe(BACKGROUND_READS_AT_ONCE);
    expect(words(alpha, "restore") + words(bravo, "restore")).toBe(12);
    expect(flight.most).toBe(BACKGROUND_READS_AT_ONCE);
  });

  it("sends nothing without words", async () => {
    const { alpha, bravo, search } = await fleet();
    const sent = [alpha.restRequests.length, bravo.restRequests.length];
    expect(await search({ text: "  ", model: "opus" })).toEqual({ connections: [], rows: [], noModel: 0, done: true });
    expect([alpha.restRequests.length, bravo.restRequests.length]).toEqual(sent);
  });
});
