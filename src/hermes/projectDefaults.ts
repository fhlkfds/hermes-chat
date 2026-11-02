// A project's defaults for its new chats (GLOSSARY.md "Project defaults", ADR 0014): instructions, a model with its
// reasoning effort, and a working folder on the server. Hermes keeps projects, but has nowhere to keep these (its
// `projects.update` takes only a name, description, icon, colour and board), so this computer keeps them, beside which
// chats are in each project (projectLinks.ts), for each connection and profile.
//
// A new chat takes each value from the first of: what the owner chose for that chat, the project's default, and the
// profile's own. The defaults go to Hermes only when a chat starts, through `session.create`: `model`, `provider` and
// `reasoning_effort`; `cwd` with `cwd_explicit`; and the instructions as one hidden seeded message (`messages` with
// `display_kind: "hidden"`), since `session.create` has no instructions field. Changing a default never changes a chat
// that has started.
import { findOption, isEffort, shortName, type Effort, type ModelCatalog, type ModelPick } from "./models";

/**
 * One project's defaults as this computer keeps them. `rev` counts the saves, so a save made from a screen opened
 * before another save is refused rather than overwriting it. A field left out is inherited from the profile.
 */
export type ProjectDefaults = { rev: number; instructions?: string; model?: ModelPick; folder?: string };

/** The defaults the owner edits: everything but the revision. */
export type DefaultsDraft = Omit<ProjectDefaults, "rev">;

/** The longest instructions kept. They go to the model with every new chat's first message, so a novel is a mistake. */
export const INSTRUCTIONS_MAX = 20_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v : undefined);

/** A stored model pick, checked; undefined if it isn't one. */
function toPick(v: unknown): ModelPick | undefined {
  if (!isObj(v)) return undefined;
  const provider = str(v.provider, 200);
  const model = str(v.model, 200);
  if (!provider || !model) return undefined;
  return { provider, model, ...(isEffort(v.effort) && { effort: v.effort }) };
}

/** One project's stored defaults, checked; anything that isn't valid is left out, and inherits. */
export function toDefaults(v: unknown): ProjectDefaults | undefined {
  if (!isObj(v) || !Number.isSafeInteger(v.rev) || (v.rev as number) < 1) return undefined;
  const instructions = str(v.instructions, INSTRUCTIONS_MAX);
  const model = toPick(v.model);
  const folder = typeof v.folder === "string" && v.folder.startsWith("/") && v.folder.length <= 4096 ? v.folder : undefined;
  return { rev: v.rev as number, ...(instructions && { instructions }), ...(model && { model }), ...(folder && { folder }) };
}

/** What is wrong with the draft, if anything, said to the owner. */
export function draftProblem(d: DefaultsDraft): string | undefined {
  const n = d.instructions?.trim().length ?? 0;
  if (n > INSTRUCTIONS_MAX) return `Keep the instructions under ${INSTRUCTIONS_MAX.toLocaleString("en")} characters; they're ${n.toLocaleString("en")}.`;
  return undefined;
}

/** The draft as it is kept: blank instructions are none, and effort is kept only with a model. Never throws. */
export function cleanDraft(d: DefaultsDraft): DefaultsDraft {
  const instructions = d.instructions?.trim() ? d.instructions.trim() : undefined;
  return {
    ...(instructions && { instructions }),
    ...(d.model && { model: { provider: d.model.provider, model: d.model.model, ...(d.model.effort && { effort: d.model.effort }) } }),
    ...(d.folder && { folder: d.folder }),
  };
}

export const sameDraft = (a: DefaultsDraft, b: DefaultsDraft) => JSON.stringify(cleanDraft(a)) === JSON.stringify(cleanDraft(b));

/** Another save landed since the defaults being edited were read. `saved`: the defaults as they are kept now. */
export class DefaultsConflict extends Error {
  constructor(readonly saved: ProjectDefaults | undefined) {
    super("These defaults were changed elsewhere since you opened them, for example in another Hermes Chat window.");
  }
}

/** The stored document was written by a newer Hermes Chat, whose defaults this version might not keep whole. */
export class NewerDefaultsError extends Error {
  constructor() {
    super("A newer version of Hermes Chat saved these projects. Update this one to change the defaults.");
  }
}

/** Where a new chat's value comes from: chosen for it, the project's default, the owner's model pick, or the profile. */
export type Origin = "chat" | "project" | "pick" | "profile";
/** A value and where it comes from. `value` undefined: Hermes's own for the profile, which this app doesn't read. */
export type Resolved<T> = { value?: T; from: Origin };

/** What a new chat starts with, and where each value comes from. */
export type NewChatSettings = {
  model: Resolved<ModelPick>;
  effort: Resolved<Effort>;
  instructions: Resolved<string>;
  folder: Resolved<string>;
  /** The project whose defaults apply, if any. */
  project?: string;
};

/**
 * What a new chat starts with. `chosen`: a model the owner picked for this chat, in its New chat pane. `project`: the
 * shown project and its defaults. `sticky`: the composer's Model pick, which is the profile's model until the owner
 * picks another. `profilePick` and `profileEffort`: the profile's own model and effort, as Hermes listed them.
 */
export function resolveNewChat(o: {
  chosen?: ModelPick;
  project?: { name: string; defaults?: ProjectDefaults };
  sticky?: ModelPick;
  profilePick?: ModelPick;
  profileEffort?: Effort;
}): NewChatSettings {
  const d = o.project?.defaults;
  const s = o.sticky;
  const asProfile = !s || (s.provider === o.profilePick?.provider && s.model === o.profilePick.model && (!s.effort || s.effort === o.profileEffort));
  const fromSticky: Origin = asProfile ? "profile" : "pick";
  const model: Resolved<ModelPick> = o.chosen
    ? { value: o.chosen, from: "chat" }
    : d?.model
      ? { value: d.model, from: "project" }
      : { value: o.sticky ?? o.profilePick, from: fromSticky };
  const effort: Resolved<Effort> = model.value?.effort ? { value: model.value.effort, from: model.from } : { value: o.profileEffort, from: "profile" };
  return {
    model,
    effort,
    instructions: d?.instructions ? { value: d.instructions, from: "project" } : { from: "profile" },
    folder: d?.folder ? { value: d.folder, from: "project" } : { from: "profile" },
    ...(o.project && { project: o.project.name }),
  };
}

/**
 * Why a chat can't start on these settings, if it can't: a project's default model Hermes doesn't offer now. A
 * model is never swapped for another on the owner's behalf.
 */
export function modelProblem(s: NewChatSettings, catalog?: ModelCatalog): string | undefined {
  const pick = s.model.value;
  if (s.model.from !== "project" || !pick || catalog?.source !== "server") return undefined;
  const option = findOption(catalog, pick);
  const what = `The project's default model, ${shortName(pick.model)} (${pick.provider}),`;
  if (!option) return `${what} isn't offered by Hermes in this profile now. Pick a model for this chat, or change the project's defaults.`;
  if (!option.available) return `${what} can't be used now: Hermes lists it as unavailable. Pick a model for this chat, or change the project's defaults.`;
  return undefined;
}

/**
 * The hidden message that carries a project's instructions into a new chat. The model reads it before the owner's
 * first message, as part of the conversation, not as the system prompt; the owner doesn't see it in any Hermes client.
 */
export const instructionsMessage = (project: string, text: string) =>
  `Instructions for this chat from the project "${project}". Follow them unless a later message says otherwise.\n\n${text}`;
