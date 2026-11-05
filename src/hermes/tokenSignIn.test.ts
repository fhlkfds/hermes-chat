// Token sign-in (ADR 0058) as the account sees it: Rust holds the token, so this side keeps only which addresses it is
// saved for, records the method beside the connection, and deletes the right entry on Sign out and Remove.
import { describe, expect, it } from "vitest";
import { type Account, type Keyring, type TokenKeyring, launchSignIn, removeConnection, savedSignIn, signIn, signOut } from "./account";
import { Connections } from "./connections";
import { FakeHermes } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { routeKey } from "./routes";
import type { SignInDetails } from "./tauriPipe";
import { connect, readSaved } from "./transport";

const lan: SignInDetails = { mode: "url", sshTarget: "", url: "http://hermes:9119", username: "", password: "", method: "token", token: "GOOD" };

const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

function keyring(): Keyring & { value?: string } {
  const k: Keyring & { value?: string } = {
    load: async () => k.value,
    save: async (v) => void (k.value = v),
    delete: async () => void (k.value = undefined),
  };
  return k;
}

/** The token entry as Rust keeps it: only which addresses it is for reaches this side. */
function tokenKeyring(): TokenKeyring & { routes?: string[]; deletes: number; broken?: string } {
  const t: TokenKeyring & { routes?: string[]; deletes: number; broken?: string } = {
    deletes: 0,
    saved: async () => t.routes,
    keep: async (routes) => (t.broken ? Promise.reject(new Error(t.broken)) : void (t.routes = routes)),
    delete: async () => {
      t.deletes++;
      t.routes = undefined;
    },
  };
  return t;
}

function account() {
  const server = new FakeHermes();
  const connections = new Connections(memoryStorage());
  const password = keyring();
  const headers = keyring();
  const token = tokenKeyring();
  const sent: SignInDetails[] = [];
  const a: Account = {
    connections,
    secrets: () => ({ password, headers, token }),
    connect: async (_c, d) => {
      sent.push(d);
      if (d.method !== "token" || !(d.token === "GOOD" || (!d.token && d.savedToken !== undefined))) throw new Error("Wrong token: the dashboard turned it down.");
      return connect(server.openPipe, "default");
    },
    readSaved: (_c, _d, reason) => readSaved(server.openPipe, reason, memoryCache()),
  };
  return { a, password, token, sent, c: connections.draft(lan) };
}

describe("Token sign-in", () => {
  it("records the method beside the connection, asks Rust to keep the token for its address, and drops a saved password", async () => {
    const { a, password, token, c } = account();
    password.value = JSON.stringify({ v: 1, for: "x", password: "old" });
    const { kept } = await signIn(c, lan, a);
    expect(a.connections.get(c.id)?.method).toBe("token");
    expect(token.routes).toEqual([routeKey({ id: "main", kind: "lan", target: "http://hermes:9119" })]);
    expect(password.value).toBeUndefined();
    expect(kept.password).toBe(true);
    expect(JSON.stringify(a.connections.getSnapshot())).not.toContain("GOOD");
  });

  it("says so when the keyring can't keep it", async () => {
    const { a, token, c } = account();
    token.broken = "no Secret Service on the bus";
    const { notSaved, kept } = await signIn(c, lan, a);
    expect(notSaved).toBe("Couldn't save the token in the system keyring: no Secret Service on the bus");
    expect(kept.password).toBe(false);
  });

  it("signs in at launch with the saved token, which Rust loads, and skips a route it wasn't saved for", async () => {
    const { a, c, sent } = account();
    const routes = [
      { id: "lan", kind: "lan" as const, target: "http://hermes:9119" },
      { id: "ts", kind: "tailscale" as const, target: "http://hermes.tail1234.ts.net:9119" },
    ];
    await (await signIn(c, { ...lan, routes }, a)).hermes.close();
    const saved = a.connections.get(c.id)!;
    a.connections.save({ ...saved, routes: [...saved.routes!, { id: "ssh", kind: "ssh", target: "liam@hermes" }] });
    const d = await savedSignIn(a.connections.get(c.id)!, a);
    expect(d).toMatchObject({ method: "token", savedToken: c.id, password: "" });
    expect(d?.token).toBeUndefined();
    expect(d?.routes?.map((r) => [r.id, !!r.locked])).toEqual([
      ["lan", false],
      ["ts", false],
      ["ssh", true],
    ]);
    await (await launchSignIn(c, d!, a)).close();
    expect(sent.at(-1)).toMatchObject({ method: "token", savedToken: c.id });
  });

  it("asks again when no token is saved for the address, or the saved one is turned down, rather than opening offline", async () => {
    const { a, c, token } = account();
    await (await signIn(c, lan, a)).hermes.close();
    token.routes = [routeKey({ id: "main", kind: "lan", target: "http://other:9119" })];
    expect(await savedSignIn(a.connections.get(c.id)!, a)).toBeUndefined();
    await expect(launchSignIn(c, { ...lan, token: "STALE" }, a)).rejects.toThrow(/^Wrong token:/);
    for (const why of [
      "This Hermes server doesn't take a token: its sign-in doesn't list the session-token provider.",
      "Token sign-in sends the token in the Authorization header, and this connection's extra request headers already set Authorization.",
      "No token is saved for this address. Enter the token to sign in.",
    ]) {
      const refusing: Account = { ...a, connect: () => Promise.reject(new Error(why)) };
      await expect(launchSignIn(c, lan, refusing)).rejects.toThrow(why);
    }
  });

  it("deletes the token on Sign out and on Remove", async () => {
    const { a, c, token } = account();
    const { hermes, connection } = await signIn(c, lan, a);
    await signOut(hermes, connection, a);
    expect(token.routes).toBeUndefined();
    const deletes = token.deletes;
    await removeConnection(connection, a, async () => {});
    expect(token.deletes).toBe(deletes + 1);
  });

  it("a password sign-in deletes a saved token, and clears the method", async () => {
    const { a, c, token } = account();
    await (await signIn(c, lan, a)).hermes.close();
    const pw: Account = { ...a, connect: async () => connect(new FakeHermes().openPipe, "default") };
    await (await signIn(a.connections.get(c.id)!, { ...lan, method: undefined, token: undefined, username: "liam", password: "hunter2" }, pw)).hermes.close();
    expect(token.routes).toBeUndefined();
    expect(a.connections.get(c.id)?.method).toBeUndefined();
  });
});
