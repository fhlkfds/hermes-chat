// Settings → Profiles (ADR 0156): every Hermes profile on the server, made, renamed, described, given a model and
// deleted through Hermes's own profile routes. Nothing on the server is written by this app directly, and nothing is
// written to find out what the server has.
//
// At the deployed `f0d94882` (`hermes_cli/web_routers/profiles.py`, `hermes_cli/profiles.py`):
// - `GET /api/profiles` lists each profile (`_profile_to_dict`): its id, whether it is Hermes's built-in `default`, its
//   model and provider, its description and whether Hermes wrote that itself, a display name, its skill count, whether
//   a gateway serves it, and the distribution it came from.
// - `POST /api/profiles` builds a profile in a hidden staging folder and renames it into place, so a refusal leaves
//   nothing. It refuses an invalid, reserved, taken or `default` name with 400, and reports a model it couldn't set as
//   `model_set: false` with `model_error` rather than failing.
// - `PATCH /api/profiles/{name}` `{new_name}` stops a running gateway (polling up to 10 s), renames the folder and
//   answers the new id. For `default` it only sets a display name, and the id stays `default`.
// - `PUT /api/profiles/{name}/description` `{description}` stores it as the owner's (`description_auto: false`).
// - `POST /api/profiles/{name}/describe-auto` `{overwrite}` has Hermes write one with an LLM, up to 60 s. A failure is
//   `ok: false` with a `reason`, not an HTTP error.
// - `PUT /api/profiles/{name}/model` `{provider, model}` writes that profile's config.yaml, whichever profile is shown.
// - `DELETE /api/profiles/{name}` stops a running gateway (up to 10 s) and removes the folder. It refuses `default`
//   (400). It can answer `ok` with `settlement_pending: true` and a `retry_command`: the folder is gone, but Hermes
//   hasn't finished settling the profile's identity, and a second delete would 404.
import { CapabilityUnsupportedError, RouteMissingError } from "./capabilities";
import { plan, settle, type EditResult, type Edits, type FieldOutcome, type Outcomes, type Same } from "./fieldMerge";
import { deadline } from "./persona";
import { RestError, type RestMethod } from "./pipe";
import { isObj } from "./values";

/** A profile as `GET /api/profiles` lists it. */
export type ProfileRow = {
  /** Hermes's id for it, the folder's name. `default` is Hermes's built-in profile. */
  name: string;
  isDefault?: boolean;
  /** A name to show in place of the id; Hermes sets one only for `default`, whose id can't change. */
  displayName?: string;
  model?: string;
  provider?: string;
  description: string;
  /** Hermes wrote the description itself (`describe-auto`). */
  descriptionAuto?: boolean;
  skillCount?: number;
  gatewayRunning?: boolean;
  /** The profile distribution it was installed from. */
  distribution?: string;
};

/** Hermes's profile ids (`hermes_constants.PROFILE_ID_RE`). */
export const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Names Hermes refuses for a new profile (`_RESERVED_NAMES`, and `default`). */
export const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set(["hermes", "default", "test", "tmp", "root", "sudo"]);
/** The longest display name Hermes keeps for `default` (`set_profile_display_name`). */
export const DISPLAY_NAME_MAX = 64;

/** Why a name can't be a new profile's id: none given, not an id, kept by Hermes, or another profile's. */
export type NameIssue = "empty" | "invalid" | "reserved" | "taken";

/** Why `name` can't be a new profile's id, against the profiles Hermes listed; undefined when it can. `except`: the profile being renamed. */
export function nameIssue(name: string, profiles: readonly Pick<ProfileRow, "name">[], except?: string): NameIssue | undefined {
  if (!name) return "empty";
  if (!PROFILE_ID.test(name)) return "invalid";
  if (RESERVED_PROFILE_NAMES.has(name)) return "reserved";
  if (name !== except && profiles.some((p) => p.name === name)) return "taken";
  return undefined;
}

/** `nameIssue` in the Clone profile dialog's English words; undefined when the name can be the clone's. */
export function nameProblem(name: string, profiles: readonly Pick<ProfileRow, "name">[]): string | undefined {
  switch (nameIssue(name, profiles)) {
    case "empty":
      return "Name the new profile.";
    case "invalid":
      return "Use lowercase letters, digits, - and _, starting with a letter or digit, up to 64 characters.";
    case "reserved":
      return `Hermes keeps the name ${name} for itself. Pick another.`;
    case "taken":
      return `There's already a profile named ${name}. Pick another name: a clone never replaces a profile.`;
    case undefined:
      return undefined;
  }
}

/** What the screen calls a profile: its display name, if Hermes keeps one, with the id after it. */
export const shownName = (p: Pick<ProfileRow, "name" | "displayName">) => (p.displayName && p.displayName !== p.name ? `${p.displayName} (${p.name})` : p.name);

const trimmedNonBlank = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** One `GET /api/profiles` row, or nothing for a row without a name Hermes's profile routes would take. */
export function toProfileRow(r: unknown): ProfileRow | undefined {
  if (!isObj(r)) return undefined;
  const name = trimmedNonBlank(r.name);
  if (!name || (name !== "default" && !PROFILE_ID.test(name))) return undefined;
  const count = typeof r.skill_count === "number" && Number.isSafeInteger(r.skill_count) && r.skill_count >= 0 ? r.skill_count : undefined;
  return {
    name,
    ...((r.is_default === true || name === "default") && { isDefault: true }),
    ...(trimmedNonBlank(r.display_name) && { displayName: trimmedNonBlank(r.display_name) }),
    ...(trimmedNonBlank(r.model) && { model: trimmedNonBlank(r.model) }),
    ...(trimmedNonBlank(r.provider) && { provider: trimmedNonBlank(r.provider) }),
    description: typeof r.description === "string" ? r.description.trim() : "",
    ...(r.description_auto === true && { descriptionAuto: true }),
    ...(count !== undefined && { skillCount: count }),
    ...(r.gateway_running === true && { gatewayRunning: true }),
    ...(trimmedNonBlank(r.distribution_name) && { distribution: trimmedNonBlank(r.distribution_name) }),
  };
}

/** The rows of a `GET /api/profiles` answer, in Hermes's order; none for an answer of another shape. */
export const toProfileRows = (res: unknown): ProfileRow[] => (isObj(res) && Array.isArray(res.profiles) ? res.profiles.flatMap((r) => toProfileRow(r) ?? []) : []);

/**
 * The rows of a `GET /api/profiles` answer, refusing one of another shape: such an answer says nothing about which
 * profiles Hermes has, so it must never read as "none" (a delete settled by the list would count as done).
 */
export function readProfileRows(res: unknown): ProfileRow[] {
  if (!isObj(res) || !Array.isArray(res.profiles)) throw new Error("Hermes answered the profile list with something this app doesn't read.");
  return toProfileRows(res);
}

/**
 * Each change Settings → Profiles and the Bots view make, by the Hermes route or JSON-RPC method it goes through.
 * `botLook` writes the Bot Mode block and `botPicture` the profile's avatar (ADR 0188).
 */
export type ProfileAction = "create" | "rename" | "describe" | "describeAuto" | "setModel" | "remove" | "botLook" | "botPicture";

/** Each action's route or method, as Hermes declares it, for the note on a server without it. */
export const PROFILE_ROUTES: Record<ProfileAction, string> = {
  create: "POST /api/profiles",
  rename: "PATCH /api/profiles/{name}",
  describe: "PUT /api/profiles/{name}/description",
  describeAuto: "POST /api/profiles/{name}/describe-auto",
  setModel: "PUT /api/profiles/{name}/model",
  remove: "DELETE /api/profiles/{name}",
  botLook: "profiles.configure",
  botPicture: "profiles.set_asset",
};

/**
 * How a profile call failed. `unsent`: it certainly didn't reach Hermes (not connected, or refused before sending).
 * `noRoute`: this Hermes has no route for it. `gone`: Hermes has no such profile. `refused`: Hermes refused it and
 * changed nothing; `status` is its HTTP status or JSON-RPC code and `detail` its reason, 0 and "" when it gave none.
 * `lost`: no answer came, or Hermes failed partway (a timeout, a dropped connection, a 5xx), so it may or may not have
 * happened. `contended`: Hermes kept changing the bot's Bot Mode settings through every attempt, so nothing was
 * written. `noCheck`: this Hermes reports no revision to check a Bot Mode write against, so nothing was sent.
 */
export type ProfileFailure =
  | { kind: "unsent"; message: string }
  | { kind: "noRoute"; action: ProfileAction }
  | { kind: "gone"; detail: string }
  | { kind: "refused"; status: number; detail: string }
  | { kind: "lost"; message: string }
  | { kind: "contended" }
  | { kind: "noCheck" };

function failureWords(f: ProfileFailure): string {
  switch (f.kind) {
    case "noRoute":
      return `This Hermes server has no route for ${PROFILE_ROUTES[f.action]}.`;
    case "gone":
      return f.detail;
    case "refused":
      return f.detail || "Hermes didn't save it, and didn't say why.";
    case "unsent":
    case "lost":
      return f.message;
    case "contended":
      return "Hermes kept changing this bot while it saved, so nothing was written.";
    case "noCheck":
      return "This Hermes can't check a bot's settings for changes made elsewhere, so nothing was sent.";
  }
}

export class ProfileError extends Error {
  constructor(readonly failure: ProfileFailure) {
    super(failureWords(failure));
  }
}

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** JSON-RPC "method not found", and `profiles.*`'s code for a profile Hermes doesn't have (`_resolve_profile`). */
const NO_SUCH_METHOD = -32601;
const NO_SUCH_PROFILE = 4064;

/** Sorts a failed call to `action`'s route or method. */
export function profileFailure(e: unknown, action: ProfileAction): ProfileFailure {
  if (e instanceof ProfileError) return e.failure;
  if (e instanceof RouteMissingError) return { kind: "noRoute", action };
  if (e instanceof CapabilityUnsupportedError) return { kind: "unsent", message: e.message };
  // A JSON-RPC error. Hermes's 4xxx codes refuse the request and change nothing; a 5xxx is a failure partway.
  const code = isObj(e) && typeof e.code === "number" ? e.code : undefined;
  if (code === NO_SUCH_METHOD) return { kind: "noRoute", action };
  if (code === NO_SUCH_PROFILE) return { kind: "gone", detail: said(e) };
  if (code !== undefined && code >= 4000 && code < 5000) return { kind: "refused", status: code, detail: said(e) };
  if (e instanceof RestError) {
    const detail = e.detail;
    if (e.status === 405 || (e.status === 404 && /^(not found$|no such api endpoint\b)/i.test(detail))) return { kind: "noRoute", action };
    if (e.status === 404) return { kind: "gone", detail };
    if (e.status >= 400 && e.status < 500) return { kind: "refused", status: e.status, detail: detail || `Hermes answered ${e.status}.` };
    return { kind: "lost", message: `Hermes answered ${e.status}${detail ? `: ${detail}` : "."}` };
  }
  const message = said(e);
  if (/^Not connected to Hermes|^The chat connection is closed|^Highwing doesn't relay/.test(message)) return { kind: "unsent", message };
  return { kind: "lost", message };
}

/**
 * How long each call may go unanswered. A rename and a delete first stop the profile's gateway, which Hermes waits up
 * to 10 s for; describing one is an LLM call Hermes gives 60 s; a create seeds skills in a subprocess.
 */
export const PROFILE_TIMEOUTS = { readMs: 30_000, createMs: 120_000, renameMs: 60_000, writeMs: 30_000, describeAutoMs: 90_000, removeMs: 60_000 };

/**
 * The profile fields Edit saves through REST: the description, and the main model. `model` is null for a profile with
 * none; a row with only one of the pair keeps it, the other as "".
 */
export type ProfileFields = { description: string; model: { provider: string; model: string } | null };

/**
 * Hermes keeps a description with its outer whitespace trimmed and nothing else changed. A model is compared as
 * `GET /api/profiles` reports it: `PUT …/model` stores the provider under its canonical id, whatever spelling it took.
 */
export const PROFILE_FIELDS_SAME: Same<ProfileFields> = {
  description: (a, b) => a.trim() === b.trim(),
  model: (a, b) => (a?.provider.trim() ?? "") === (b?.provider.trim() ?? "") && (a?.model.trim() ?? "") === (b?.model.trim() ?? ""),
};

/** A listed profile's description and model, as `ProfilesApi.edit` compares them. */
export const profileFieldsOf = (row: Pick<ProfileRow, "description" | "model" | "provider">): ProfileFields => ({
  description: row.description,
  model: row.provider || row.model ? { provider: row.provider ?? "", model: row.model ?? "" } : null,
});

/** What a create answered. `modelError`: why Hermes didn't set the model it was given, in its words. */
export type Created = { name: string; answered: boolean; modelSet: boolean; modelError?: string };

/** How a delete ended: gone, with Hermes still settling its identity (`retryCommand`), or already gone before. */
export type Removed = { kind: "deleted" } | { kind: "settling"; retryCommand?: string } | { kind: "alreadyGone" };

/** What a rename answered: the profile's id after it, and for `default`, the display name it now has. */
export type Renamed = { name: string; displayName?: string };

/** Lists, makes, renames, describes, sets the model of and deletes profiles for Settings → Profiles. Every call names its profile. */
export class ProfilesApi {
  constructor(
    private rest: (method: RestMethod, pathAndQuery: string, body?: unknown) => Promise<unknown>,
    private timeouts = PROFILE_TIMEOUTS,
  ) {}

  private path(name: string, rest = "") {
    if (name !== "default" && !PROFILE_ID.test(name)) throw new ProfileError({ kind: "unsent", message: `"${name}" isn't a Hermes profile name.` });
    return `api/profiles/${encodeURIComponent(name)}${rest}`;
  }

  private async call(action: ProfileAction, method: RestMethod, path: string, body: unknown, ms: number, what: string): Promise<Record<string, unknown>> {
    try {
      const res = await deadline(this.rest(method, path, body), ms, what);
      if (!isObj(res) || res.ok !== true) throw new ProfileError({ kind: "lost", message: `Hermes didn't say it was done ${what}.` });
      return res;
    } catch (e) {
      throw new ProfileError(profileFailure(e, action));
    }
  }

  /** Every profile Hermes has, in its order. */
  async list(): Promise<ProfileRow[]> {
    try {
      return readProfileRows(await deadline(this.rest("GET", "api/profiles"), this.timeouts.readMs, "listing profiles"));
    } catch (e) {
      throw new ProfileError(profileFailure(e, "create"));
    }
  }

  /**
   * Makes a blank profile: Hermes's empty `.env` and built-in skills, with only what's given. A lost answer is settled by
   * the list: listed means made (`answered: false`, since whether the model was set is then unknown).
   */
  async create(fields: { name: string; description?: string; provider?: string; model?: string; soul?: string }): Promise<Created> {
    const { name } = fields;
    if (name === "default" || !PROFILE_ID.test(name)) throw new ProfileError({ kind: "unsent", message: `"${name}" isn't a name Hermes takes for a new profile.` });
    const body = {
      name,
      ...(fields.description?.trim() && { description: fields.description.trim() }),
      ...(fields.provider && fields.model && { provider: fields.provider, model: fields.model }),
      ...(fields.soul !== undefined && { soul: fields.soul }),
    };
    try {
      const res = await this.call("create", "POST", "api/profiles", body, this.timeouts.createMs, `creating ${name}`);
      const wanted = !!(body.provider && body.model);
      return { name, answered: true, modelSet: !wanted || res.model_set === true, ...(wanted && res.model_set !== true && { modelError: trimmedNonBlank(res.model_error) }) };
    } catch (e) {
      if (!(e instanceof ProfileError) || e.failure.kind !== "lost") throw e;
      if (await this.listed(name)) return { name, answered: false, modelSet: false };
      throw e;
    }
  }

  /**
   * Renames `name` to `to`; for `default`, sets its display name to `to` instead. A lost answer is settled by the list:
   * `name` gone and `to` there means renamed.
   */
  async rename(name: string, to: string): Promise<Renamed> {
    const path = this.path(name);
    if (name !== "default" && (to === "default" || !PROFILE_ID.test(to))) throw new ProfileError({ kind: "unsent", message: `"${to}" isn't a name Hermes takes for a profile.` });
    try {
      const res = await this.call("rename", "PATCH", path, { new_name: to }, this.timeouts.renameMs, `renaming ${name}`);
      if (name === "default") return { name: "default", displayName: typeof res.display_name === "string" ? res.display_name : to.trim() };
      return { name: trimmedNonBlank(res.name) ?? to };
    } catch (e) {
      if (!(e instanceof ProfileError) || e.failure.kind !== "lost" || name === "default") throw e;
      const names = await this.names();
      if (names && !names.has(name) && names.has(to)) return { name: to };
      throw e;
    }
  }

  /** Sets `name`'s description as the owner's own. Answers the text Hermes kept. */
  async describe(name: string, description: string): Promise<string> {
    const res = await this.call("describe", "PUT", this.path(name, "/description"), { description }, this.timeouts.writeMs, `saving ${name}'s description`);
    return typeof res.description === "string" ? res.description : description.trim();
  }

  /** Has Hermes write a description of `name`, replacing any. Saves it on the server; `ok: false` says why it couldn't. */
  async describeAuto(name: string): Promise<{ ok: true; description: string } | { ok: false; reason: string }> {
    const path = this.path(name, "/describe-auto");
    let res: unknown;
    try {
      res = await deadline(this.rest("POST", path, { overwrite: true }), this.timeouts.describeAutoMs, `describing ${name}`);
    } catch (e) {
      throw new ProfileError(profileFailure(e, "describeAuto"));
    }
    if (!isObj(res)) throw new ProfileError({ kind: "lost", message: `Hermes didn't answer describing ${name}.` });
    if (res.ok === true && typeof res.description === "string") return { ok: true, description: res.description };
    return { ok: false, reason: trimmedNonBlank(res.reason) ?? "Hermes didn't say why." };
  }

  /** Sets `name`'s main model, whichever profile the app shows. */
  async setModel(name: string, provider: string, model: string): Promise<void> {
    await this.call("setModel", "PUT", this.path(name, "/model"), { provider, model }, this.timeouts.writeMs, `setting ${name}'s model`);
  }

  /**
   * Saves `edits` to `name`'s description and model, each only where Hermes still has what the owner was shown
   * (fieldMerge.ts `plan`, ADR 0188). It reads the list first and again after, and writes through `describe` and
   * `setModel`. Hermes has no compare-and-swap on these routes, so a change that lands between that read and the write
   * is overwritten, as with the persona (ADR 0014). Never rejects: a failure is that field's outcome.
   */
  async edit(name: string, edits: Edits<ProfileFields>): Promise<EditResult<ProfileFields>> {
    const failed = <V>(failure: ProfileFailure): FieldOutcome<V> => ({ kind: "failed", failure });
    const all = (failure: ProfileFailure): EditResult<ProfileFields> => ({
      fields: { ...(edits.description && { description: failed(failure) }), ...(edits.model && { model: failed(failure) }) },
    });
    const held = (rows: ProfileRow[]) => rows.find((r) => r.name === name);
    let row: ProfileRow | undefined;
    try {
      row = held(await this.list());
    } catch (e) {
      return all(profileFailure(e, "describe"));
    }
    if (!row) return all({ kind: "gone", detail: `Hermes lists no profile named ${name}.` });
    const { write, settled } = plan(edits, profileFieldsOf(row), PROFILE_FIELDS_SAME);
    const fields: Outcomes<ProfileFields> = { ...settled };
    const saved = { kind: "saved" } as const;
    if (write.description !== undefined)
      fields.description = await this.describe(name, write.description).then(
        () => saved,
        (e: unknown) => failed(profileFailure(e, "describe")),
      );
    if (write.model)
      fields.model = await this.setModel(name, write.model.provider, write.model.model.trim()).then(
        () => saved,
        (e: unknown) => failed(profileFailure(e, "setModel")),
      );
    else if (write.model === null) fields.model = failed({ kind: "unsent", message: "Hermes has no route that takes a profile's model away." });
    const back = await this.list().then(held, () => undefined);
    const now = back && profileFieldsOf(back);
    // Hermes stores a provider under its canonical id ("Stub" reads back "custom:stub") and the model name as sent.
    const landedAs = { model: (a: ProfileFields["model"], b: ProfileFields["model"]) => (a?.model.trim() ?? "") === (b?.model.trim() ?? "") };
    return { fields: settle(fields, edits, now, PROFILE_FIELDS_SAME, landedAs), ...(now && { now }) };
  }

  /**
   * Deletes `name` on the server. A 404 means another client deleted it already; a lost answer is settled by the list.
   * Never `default`.
   */
  async remove(name: string): Promise<Removed> {
    if (name === "default") throw new ProfileError({ kind: "refused", status: 400, detail: "Hermes's built-in profile can't be deleted." });
    try {
      const res = await this.call("remove", "DELETE", this.path(name), undefined, this.timeouts.removeMs, `deleting ${name}`);
      return res.settlement_pending === true ? { kind: "settling", retryCommand: trimmedNonBlank(res.retry_command) } : { kind: "deleted" };
    } catch (e) {
      if (!(e instanceof ProfileError)) throw e;
      if (e.failure.kind === "gone") return { kind: "alreadyGone" };
      if (e.failure.kind === "lost" && (await this.listed(name)) === false) return { kind: "deleted" };
      throw e;
    }
  }

  /**
   * How many chats `name` has, archived ones included, as Hermes counts them (`GET /api/sessions` `total`); undefined
   * when it can't say, such as for a profile whose chat store isn't started.
   */
  async chatCount(name: string): Promise<number | undefined> {
    if (name !== "default" && !PROFILE_ID.test(name)) return undefined;
    const query = new URLSearchParams({ profile: name, limit: "1", offset: "0", archived: "include" });
    try {
      const res = await deadline(this.rest("GET", `api/sessions?${query}`), this.timeouts.readMs, `counting ${name}'s chats`);
      return isObj(res) && typeof res.total === "number" && Number.isSafeInteger(res.total) && res.total >= 0 ? res.total : undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether Hermes lists `name` now; undefined when the list can't be read. */
  private async listed(name: string): Promise<boolean | undefined> {
    return (await this.names())?.has(name);
  }

  /**
   * Every name Hermes lists, to settle a change whose answer was lost; undefined unless every row of the list names
   * its profile, since a row this app can't read might be the very profile in question.
   */
  private async names(): Promise<Set<string> | undefined> {
    try {
      const res = await deadline(this.rest("GET", "api/profiles"), this.timeouts.readMs, "listing profiles");
      if (!isObj(res) || !Array.isArray(res.profiles)) return undefined;
      const names = res.profiles.map((r) => (isObj(r) && typeof r.name === "string" ? r.name : undefined));
      return names.every((n): n is string => n !== undefined) ? new Set(names) : undefined;
    } catch {
      return undefined;
    }
  }
}
