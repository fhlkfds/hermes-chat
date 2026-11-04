// Setup: the first-run flow that connects Hermes Chat to a Hermes server (ADR 0009). It tests a sign-in before
// keeping it, explains a failed test in terms of what to fix, and lists the model providers whose API key the owner
// can give the server. The Rust side does the testing (`hermes_probe`) and the key saving (`hermes_save_provider_key`).
import type { SavedSignIn } from "./account";
import type { Route } from "./pipe";
import type { SignInDetails } from "./tauriPipe";
import { isUnsecure } from "./unsecure";

/**
 * How far a connection test got: the address or SSH tunnel, the dashboard's port, the sign-in, then the chat
 * connection. `cancelled`: the owner stopped it. Mirrors `transport::Stage` in Rust.
 */
export type Stage = "address" | "reach" | "sign-in" | "chat" | "cancelled";
export const STAGES = ["address", "reach", "sign-in", "chat"] as const satisfies readonly Stage[];

/** A connection test that went through, as Rust reports it: the raw `GET /api/status` body and first `/api/ws` frame. */
export type Probed = { route: Route; status?: string | null; ready: string };

/** A connection test that failed, as Rust reports it. */
export type ProbeFailure = { stage: Stage; message: string; status?: string | null };

/** Runs connection tests. `run` rejects with a `ProbeFailure`; `cancel` stops the test under way. */
export type Probe = { run(d: SignInDetails, profile: string): Promise<Probed>; cancel(): void };

/** What a connection test found. A failure names the stage it stopped at, what went wrong, and what to try. */
export type TestOutcome =
  | { ok: true; route: Route; unsecure: boolean; version?: string }
  | { ok: false; stage: Stage; problem: string; detail?: string; fixes: string[] };

/** What the dashboard says about itself before anyone signs in (`GET /api/status`). */
export type DashboardStatus = { version?: string; authRequired?: boolean; authProviders?: string[] };

/** The sign-in method Hermes Chat uses (`PASSWORD_PROVIDER` in transport.rs). */
const PASSWORD_PROVIDER = "basic";

/**
 * Whether this computer has a connection set up already, from the sign-in saved beside the keyring. An install
 * that has one never sees the first-run setup again: launch signs in, or the sign-in screen asks for the password.
 */
export const isSetUp = (saved: SavedSignIn) => !!(saved.sshTarget.trim() || saved.url.trim() || saved.username.trim());

/** The fields setup still needs before it can test, in words; empty when it can test. */
export function missing(d: SignInDetails): string[] {
  const out: string[] = [];
  if (!(d.mode === "ssh" ? d.sshTarget : d.url).trim()) out.push(d.mode === "ssh" ? "the SSH target" : "the dashboard URL");
  if (!d.username.trim()) out.push("the dashboard username");
  if (!d.password) out.push("the dashboard password");
  return out;
}

export function readStatus(raw?: string | null): DashboardStatus | undefined {
  if (!raw) return;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return;
  const o = v as Record<string, unknown>;
  // A Hermes dashboard's status always carries its version or its auth gate; anything else is another server.
  if (typeof o.version !== "string" && typeof o.auth_required !== "boolean") return;
  return {
    version: typeof o.version === "string" ? o.version : undefined,
    authRequired: typeof o.auth_required === "boolean" ? o.auth_required : undefined,
    authProviders: Array.isArray(o.auth_providers) ? o.auth_providers.filter((p): p is string => typeof p === "string") : undefined,
  };
}

/** Why the first frame isn't a legacy `gateway.ready` (the generation Hermes Chat speaks, ADR 0003); none when it is. */
function notReady(frame: string): ProbeFailure | undefined {
  let f: { method?: unknown; params?: { type?: unknown; payload?: { session_authority?: unknown } } };
  try {
    f = JSON.parse(frame);
  } catch {
    return { stage: "chat", message: "Hermes's first message on the chat connection wasn't JSON." };
  }
  if (f?.method !== "event" || f.params?.type !== "gateway.ready")
    return { stage: "chat", message: "Hermes's first message on the chat connection wasn't gateway.ready." };
  if (f.params.payload?.session_authority)
    return { stage: "chat", message: "This Hermes server speaks the canonical session protocol, which Hermes Chat doesn't support yet." };
}

const asFailure = (e: unknown): ProbeFailure =>
  e && typeof e === "object" && "stage" in e && "message" in e
    ? (e as ProbeFailure)
    : { stage: "address", message: e instanceof Error ? e.message : String(e) };

/** Tests `d` with `probe` and explains the result. Never rejects. */
export async function testConnection(probe: Probe, d: SignInDetails, profile = "default"): Promise<TestOutcome> {
  let probed: Probed;
  try {
    probed = await probe.run(d, profile);
  } catch (e) {
    return explain(asFailure(e), d);
  }
  const wrong = notReady(probed.ready);
  if (wrong) return explain({ ...wrong, status: probed.status }, d);
  return { ok: true, route: probed.route, unsecure: isUnsecure(probed.route), version: readStatus(probed.status)?.version };
}

/** The host and port a URL names, for messages; the text as typed if it isn't a URL. */
function hostOf(url: string): string {
  try {
    const u = new URL(url.trim());
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url.trim();
  }
}

/** The host part of an SSH target, `user@host` or an alias. */
const sshHost = (target: string) => target.trim().replace(/^.*@/, "");

/**
 * A failed test in the owner's words: `problem` says what went wrong, `detail` is the error as Rust gave it when that
 * adds anything, and `fixes` are what to try. Hints follow the messages Rust and OpenSSH write, and fall back to
 * general advice for the stage when nothing matches.
 */
export function explain(f: ProbeFailure, d: SignInDetails): TestOutcome & { ok: false } {
  const m = f.message;
  const has = (re: RegExp) => re.test(m);
  const ssh = d.mode === "ssh";
  const status = readStatus(f.status);
  // `detail` null: the problem says it all.
  const out = (problem: string, fixes: string[], detail: string | null = m) => ({
    ok: false as const,
    stage: f.stage,
    problem,
    detail: detail === null || detail === problem ? undefined : detail,
    fixes,
  });
  const checkSsh = `Check it from a terminal: ssh -o BatchMode=yes ${d.sshTarget.trim() || "<target>"} true`;
  const turnedAway = () =>
    out(`Something in front of the dashboard at ${hostOf(d.url)} turned Hermes Chat away.`, [
      d.headers?.length
        ? "Check the extra request headers' names and values, on the Server step. A Cloudflare Access service token needs CF-Access-Client-Id and CF-Access-Client-Secret."
        : "If a gateway such as Cloudflare Access is in front of the dashboard, add the headers it needs under Extra request headers, on the Server step. A service token needs CF-Access-Client-Id and CF-Access-Client-Secret.",
      "Or connect over SSH, which goes straight to the dashboard.",
    ]);
  // With extra request headers, Rust hides a refusal's body, or a close reason, that may repeat them, as a gateway's
  // can. Past the first request such a refusal is most likely the gateway's too, so the stage's own hints wouldn't
  // help.
  const hidden = "\\(not shown, as it may repeat your extra request headers\\)";
  if (!ssh && d.headers?.length && has(new RegExp(`answered (401|403|407): ${hidden}|closed by the server \\(\\d+ ${hidden}\\)`)))
    return turnedAway();

  switch (f.stage) {
    case "cancelled":
      return out("The test was stopped.", [], null);
    case "address":
      if (ssh) {
        if (has(/Enter an SSH target/)) return out(m, []);
        if (has(/Couldn't start ssh/)) return out("Hermes Chat couldn't run ssh on this computer.", ["Install OpenSSH: sudo pacman -S openssh"]);
        if (has(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/))
          return out("The server's SSH host key doesn't match the one this computer knows.", [
            "Make sure this is the right server. If its key changed on purpose, remove the old one with " +
              `ssh-keygen -R ${sshHost(d.sshTarget)} and try again.`,
          ]);
        if (has(/Permission denied|publickey|Too many authentication failures/))
          return out("The server didn't accept your SSH key.", [
            "Hermes Chat runs ssh without prompts, so your key has to work without a passphrase prompt. Add it to your SSH agent with ssh-add.",
            "Check the user name in the target, for example liam@hermes.",
            checkSsh,
          ]);
        if (has(/Could not resolve hostname|Name or service not known/))
          return out(`This computer couldn't find the host "${sshHost(d.sshTarget)}".`, [
            "Check the host name, or the Host alias in ~/.ssh/config.",
            "A Tailscale name needs Tailscale running on this computer.",
          ]);
        if (has(/Connection refused/))
          return out("The server refused the SSH connection.", ["Check that the SSH server is running on it, and the port if it isn't 22."]);
        if (has(/timed out|No route to host|Network is unreachable|didn't open the tunnel/))
          return out("The server didn't answer over SSH.", [
            "Check that the server is on, and that this computer can reach it: the same network, or Tailscale running.",
            checkSsh,
          ]);
        return out("SSH couldn't open the tunnel to the server.", [checkSsh]);
      }
      if (has(/Enter the dashboard's URL/)) return out(m, []);
      if (has(/couldn't look up/))
        return out(`This computer couldn't find "${hostOf(d.url)}".`, [
          "Check the host name in the URL.",
          "A Tailscale name, such as hermes, needs Tailscale running on this computer.",
        ]);
      return out("Hermes Chat couldn't use this address.", ["Check the URL, for example http://hermes:9119."]);

    case "reach":
      if (has(/didn't answer within/))
        return out(
          ssh ? "The tunnel opened, but the dashboard didn't answer." : `Nothing answered at ${hostOf(d.url)} in time.`,
          ssh
            ? ["Check that hermes dashboard is running on the server, on port 9119."]
            : ["Check the port: the dashboard listens on 9119 unless it was started with another.", "Check that no firewall drops the connection."],
        );
      if (has(/certificate|tls|ssl|handshake/i))
        return out("This computer doesn't trust the server's HTTPS certificate.", [
          "Use a certificate from a trusted authority, or connect over SSH, or over Tailscale with http://.",
        ]);
      if (!ssh && has(/another site/))
        return out(`The dashboard's address sent Hermes Chat on to another site.`, [
          "If a gateway such as Cloudflare Access is in front of the dashboard, add the headers it needs under Extra request headers, on the Server step.",
          "Or connect over SSH, which goes straight to the dashboard.",
        ]);
      if (!ssh && has(/answered (401|403)/)) return turnedAway();
      if (ssh)
        return out("The tunnel opened, but nothing answered on the server's port 9119.", [
          "Start the dashboard on the server: hermes dashboard",
        ]);
      if (has(/refused/i))
        return out(`Nothing is listening at ${hostOf(d.url)}.`, [
          "Check the port: the dashboard listens on 9119 unless it was started with another.",
          "Check that hermes dashboard is running, and listening on an address this computer can reach (for example --host 0.0.0.0, or the server's Tailscale address).",
        ]);
      return out(`Hermes Chat couldn't reach the dashboard at ${hostOf(d.url)}.`, [
        "Check the address and port, and that this computer can reach the server.",
      ]);

    case "sign-in":
      if (has(/Wrong username or password/))
        return out("The dashboard turned down the username or password.", [
          "Use the Hermes dashboard's username and password, not your SSH or computer login. They're set under dashboard.basic_auth in the server's Hermes config.",
        ], null);
      if (has(/Too many sign-in attempts/)) return out(m, ["Wait a minute, then try again."], null);
      if (status?.authProviders && !status.authProviders.includes(PASSWORD_PROVIDER))
        return out("This dashboard doesn't offer username and password sign-in, which Hermes Chat uses.", [
          `It offers: ${status.authProviders.join(", ") || "nothing"}.`,
          "Set a dashboard username and password under dashboard.basic_auth in the server's Hermes config, then restart the dashboard.",
        ]);
      if (!status && has(/answered (404|405)/))
        return out("Something answered at this address, but it isn't a Hermes dashboard.", [
          ssh ? "Check that port 9119 on the server is the Hermes dashboard." : "Check the port: the dashboard listens on 9119 unless it was started with another.",
        ]);
      if (has(/answered 503/)) return out("The dashboard's sign-in isn't available right now.", ["Try again in a moment."]);
      if (has(/didn't answer within/)) return out("The dashboard didn't answer the sign-in in time.", ["Try again."]);
      return out("The dashboard's sign-in failed.", ["Try again. If it keeps failing, check the dashboard's log on the server."]);

    case "chat":
      if (has(/canonical session protocol/))
        return out("Hermes Chat can't talk to this server yet.", ["This server uses Hermes's newer session protocol. Hermes Chat speaks only the legacy one."], null);
      if (has(/chat connection failed/))
        return out("Signed in, but the chat connection failed.", [
          "If a reverse proxy sits in front of the dashboard, make sure it passes WebSocket connections to /api/ws.",
        ]);
      return out("Signed in, but Hermes didn't get ready.", ["Try again. If it keeps failing, check the dashboard's log on the server."]);
  }
}

/**
 * Why a real sign-in (at launch, or switching connection) failed, explained as a failed test is. Rust gives a sign-in
 * only its message, so the stage is read from that.
 */
export function explainSignIn(message: string, d: SignInDetails): Extract<TestOutcome, { ok: false }> {
  const stage: Stage = /Wrong username or password|Too many sign-in attempts|sign-in/i.test(message)
    ? "sign-in"
    : /canonical session protocol|chat connection|ready/i.test(message)
      ? "chat"
      : /^SSH|ssh |Couldn't start ssh|couldn't look up|Enter the/i.test(message)
        ? "address"
        : "reach";
  return explain({ stage, message }, d) as Extract<TestOutcome, { ok: false }>;
}

/** What each stage of a test checks, for the checklist setup shows. */
export function stageLabel(stage: Stage, mode: SignInDetails["mode"]): string {
  switch (stage) {
    case "address":
      return mode === "ssh" ? "Open an SSH tunnel to the server" : "Find the server";
    case "reach":
      return "Reach the Hermes dashboard";
    case "sign-in":
      return "Sign in to the dashboard";
    case "chat":
      return "Open the chat connection";
    case "cancelled":
      return "Stopped";
  }
}

// ---------- model provider keys ----------

/**
 * A model provider whose API key Hermes keeps in the profile's `.env` on the server. `envVar`: where it goes.
 * `isSet`: Hermes has a key for it already, shown only as `preview`, which the server redacts.
 */
export type ProviderKey = { provider: string; label: string; envVar: string; isSet: boolean; preview?: string; url?: string };

/**
 * What setup shows about model providers for a profile. `keys`: the providers a key can be pasted for, best known
 * first. `ready`: the providers Hermes can use now, by name, from its model list. `unsupported`: why this server
 * can't take a key from Hermes Chat.
 */
export type ProviderSetup = { keys: ProviderKey[]; ready: string[]; unsupported?: string };

/** What became of a saved key (`transport::SavedKey`). `verified`: the provider accepted it; otherwise Hermes
 * couldn't check it. Hermes's own message isn't passed on, as a provider's can quote part of the key. */
export type SavedKey = { verified: boolean };

/** The providers most owners start with, listed first. */
const FEATURED = ["openrouter", "anthropic", "openai-api", "gemini", "deepseek", "xai"];

type EnvRow = {
  is_set?: unknown;
  redacted_value?: unknown;
  url?: unknown;
  is_password?: unknown;
  channel_managed?: unknown;
  provider?: unknown;
  provider_label?: unknown;
  provider_primary?: unknown;
  provider_profiles?: unknown;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * The provider keys `GET /api/env` lists (`hermes_cli/web_routers/config_env.py` at the deployed `bf0203a`): one per
 * provider, its primary secret. A credential that serves several providers is listed once for each. Messaging
 * tokens, base URLs and custom variables aren't provider keys.
 */
export function providerKeys(env: unknown): ProviderKey[] {
  const rows = env && typeof env === "object" && !Array.isArray(env) ? Object.entries(env as Record<string, EnvRow>) : [];
  const byProvider = new Map<string, ProviderKey & { primary: boolean }>();
  const offer = (provider: string, label: string, envVar: string, row: EnvRow, primary: boolean) => {
    if (!provider) return;
    const have = byProvider.get(provider);
    const isSet = row.is_set === true || !!have?.isSet;
    if (have && (have.primary || !primary)) return void (have.isSet = isSet);
    byProvider.set(provider, {
      provider,
      label: label || provider,
      envVar,
      isSet,
      preview: str(row.redacted_value) || undefined,
      url: str(row.url) || undefined,
      primary,
    });
  };
  for (const [envVar, row] of rows) {
    if (!row || row.is_password !== true || row.channel_managed === true) continue;
    offer(str(row.provider), str(row.provider_label), envVar, row, row.provider_primary === true);
    for (const p of Array.isArray(row.provider_profiles) ? (row.provider_profiles as Record<string, unknown>[]) : [])
      offer(str(p?.provider), str(p?.provider_label), envVar, { ...row, url: p?.url ?? row.url }, p?.primary === true);
  }
  const rank = (p: ProviderKey) => (FEATURED.includes(p.provider) ? FEATURED.indexOf(p.provider) : FEATURED.length);
  return [...byProvider.values()]
    .map(({ primary: _primary, ...k }) => k)
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/** The providers Hermes's model list (`model.options`) says it can use now, by name. */
export function readyProviders(options: unknown): string[] {
  const providers = (options as { providers?: unknown } | undefined)?.providers;
  if (!Array.isArray(providers)) return [];
  return providers
    .filter((p) => p && typeof p === "object" && (p as { authenticated?: unknown }).authenticated === true)
    .map((p) => str((p as { name?: unknown }).name) || str((p as { slug?: unknown }).slug))
    .filter(Boolean);
}
