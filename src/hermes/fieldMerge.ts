// Saving fields another client may have changed meanwhile (ADR 0187): each edit carries the value the owner was shown
// and the value they asked for, and a field is written only where Hermes still has what the owner was shown. Pure: the
// transport (`Hermes.editBot`) and `ProfilesApi.edit` read, send and read back around it.
import type { ProfileFailure } from "./profiles";

/** One field the owner changed: the value they were shown (`from`), and the value they asked for (`to`). */
export type Edit<V> = { from: V; to: V };

/** The fields one save changes. A field left out is never compared and never sent. */
export type Edits<F> = { [K in keyof F]?: Edit<F[K]> };

/** How each field's values compare, normalisation included (trim, a colour's case). One table per field family. */
export type Same<F> = { [K in keyof F]: (a: F[K], b: F[K]) => boolean };

/**
 * What became of one edited field. `saved`: Hermes has `to` now. `changedElsewhere`: Hermes had moved off `from`, so
 * nothing was written for it; `theirs` is Hermes's value, for the dialog to show. `failed`: Hermes's own words.
 */
export type FieldOutcome<V> = { kind: "saved" } | { kind: "changedElsewhere"; theirs: V } | { kind: "failed"; failure: ProfileFailure };

export type Outcomes<F> = { [K in keyof F]?: FieldOutcome<F[K]> };

/**
 * A save's answer: one outcome per edit sent in, and Hermes's values read back after it. `now` holds only the fields
 * that read covered, and is absent when it failed.
 */
export type EditResult<F> = { fields: Outcomes<F>; now?: Partial<F> };

/** What one attempt sends, and the fields it already settled without sending (converged, or changed elsewhere). */
export type Plan<F> = { write: Partial<F>; settled: Outcomes<F> };

const keysOf = <T extends object>(o: T) => Object.keys(o) as (keyof T)[];

/** The edits a form holds: each field whose input differs from its base. */
export function editsOf<F extends object>(base: F, form: F, same: Same<F>): Edits<F> {
  const edits: Edits<F> = {};
  for (const k of keysOf(same)) if (!same[k](base[k], form[k])) edits[k] = { from: base[k], to: form[k] };
  return edits;
}

/**
 * The conflict rule, per edited field, against `theirs`, what Hermes has now:
 *   theirs = to   → settled `saved`, nothing sent (a lost write landed, or someone made the same change)
 *   theirs = from → written
 *   otherwise     → settled `changedElsewhere { theirs }`, nothing sent
 * Always planned against the edit's `from`, never against an earlier attempt's read, so a retry can't turn a change
 * made between attempts into an overwrite.
 */
export function plan<F extends object>(edits: Edits<F>, theirs: F, same: Same<F>): Plan<F> {
  const write: Partial<F> = {};
  const settled: Outcomes<F> = {};
  for (const k of keysOf(edits)) {
    const e = edits[k];
    if (!e) continue;
    if (same[k](theirs[k], e.to)) settled[k] = { kind: "saved" };
    else if (same[k](theirs[k], e.from)) write[k] = e.to;
    else settled[k] = { kind: "changedElsewhere", theirs: theirs[k] };
  }
  return { write, settled };
}

/**
 * Settles each outcome against the read-back `now`, so a save run twice, or one whose answer was lost, ends the same:
 *   failed `lost` and now = to → saved
 *   saved and now ≠ to         → changedElsewhere { theirs: now } (someone wrote after us; theirs is shown, not ours)
 *   anything else              → unchanged
 * A field `now` doesn't cover keeps its outcome. `respelt`: fields Hermes stores in its own spelling (a model's
 * provider becomes its canonical id), so a saved one can't be judged by whether `now` equals `to`, and stays saved.
 */
export function settle<F extends object>(outcomes: Outcomes<F>, edits: Edits<F>, now: Partial<F> | undefined, same: Same<F>, respelt: readonly (keyof F)[] = []): Outcomes<F> {
  if (!now) return outcomes;
  const out: Outcomes<F> = {};
  for (const k of keysOf(outcomes)) {
    const o = outcomes[k];
    const e = edits[k];
    if (!o) continue;
    out[k] = o;
    if (!e || !(k in now)) continue;
    const theirs = now[k] as F[typeof k];
    const landed = same[k](theirs, e.to);
    if (o.kind === "failed" && o.failure.kind === "lost" && landed) out[k] = { kind: "saved" };
    else if (o.kind === "saved" && !landed && !respelt.includes(k)) out[k] = { kind: "changedElsewhere", theirs };
  }
  return out;
}

/**
 * The dialog's next base and inputs after a save. The base only moves to a value the owner has been shown, so a later
 * Save still checks against what they saw:
 *   not edited, or saved → base = input = now[k]   (the input shows it)
 *   changedElsewhere     → base = theirs, input kept (the note shows theirs; Save again is an informed overwrite)
 *   failed               → both unchanged          (nothing newer was shown)
 * A saved field `now` doesn't cover takes the owner's own value as its base.
 */
export function rebase<F extends object>(base: F, form: F, result: EditResult<F>): { base: F; form: F } {
  const next = { base: { ...base }, form: { ...form } };
  for (const k of keysOf(base)) {
    const o = result.fields[k];
    if (o?.kind === "failed") continue;
    if (o?.kind === "changedElsewhere") next.base[k] = o.theirs;
    else if (result.now && k in result.now) next.base[k] = next.form[k] = result.now[k] as F[typeof k];
    else if (o) next.base[k] = form[k];
  }
  return next;
}

/** Whether every edit of a save came back `saved`. */
export const allSaved = <F extends object>(result: EditResult<F>) => Object.values<FieldOutcome<unknown> | undefined>(result.fields).every((o) => o?.kind === "saved");
