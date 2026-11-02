// Settings → Model: the main model, subagents, auxiliary (helper task) models and the guardrails, as Hermes has them
// for the profile shown. Edits are one draft held here until a part is applied; leaving Settings drops it without
// asking, as the official desktop app does. Reads and writes: modelSettings.ts.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleDollarSign, Pin, RotateCcw, ShieldAlert, TriangleAlert } from "lucide-react";
import {
  AUX_AUTO,
  AUX_INHERIT,
  EFFORT_LEVELS,
  EFFORT_OFF,
  SUBAGENT_ROUTES,
  auxChanged,
  auxPinWarning,
  auxProblem,
  chooseAuxProvider,
  chooseProvider,
  chooseRoute,
  draftFrom,
  mainChanged,
  mainProblem,
  pinnedElsewhere,
  subagentChanged,
  subagentProblem,
  type AuxTask,
  type CatalogProvider,
  type Draft,
  type ModelSettings as Settings,
  type ModelSettingsApi,
  type PinnedWarning,
  type SubagentRoute,
} from "../hermes/modelSettings";

const EFFORT_LABEL: Record<string, string> = {
  [EFFORT_OFF]: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
const ROUTE_LABEL: Record<SubagentRoute, string> = {
  inherit: "Inherit from main agent",
  "parent-model": "Use parent model",
  "custom-model": "Custom model (use parent credentials)",
  provider: "Another provider and model",
};

type Part = "main" | "subagent" | "auxiliary";
/** A guardrail waiting for the owner's answer before the main model is applied. */
type Ask =
  | { kind: "pinned"; warning: PinnedWarning }
  | { kind: "expensive"; part: "main"; message: string }
  /** `confirmed`: the helper tasks to send confirmed on Switch anyway, this one among them. */
  | { kind: "expensive"; part: "auxiliary"; message: string; task: string; confirmed: string[] };
const askPart = (a: Ask): Part => (a.kind === "pinned" ? "main" : a.part);

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
const providerName = (providers: CatalogProvider[], slug: string) => providers.find((p) => p.slug === slug)?.name ?? slug;

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field model-field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** The catalog's providers; one Hermes has that the catalog no longer lists stays on offer. */
function ProviderSelect({ label, value, providers, onChange }: { label: string; value: string; providers: CatalogProvider[]; onChange: (slug: string) => void }) {
  const listed = providers.some((p) => p.slug === value);
  return (
    <select className="select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {!value && (
        <option value="" disabled>
          Choose a provider…
        </option>
      )}
      {value && !listed && <option value={value}>{value}</option>}
      {providers.map((p) => (
        <option key={p.slug} value={p.slug}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

/** The provider's models. Empty until one is picked: switching provider never keeps the old provider's model. */
function ModelSelect({ label, value, provider, providers, onChange }: { label: string; value: string; provider: string; providers: CatalogProvider[]; onChange: (m: string) => void }) {
  const models = providers.find((p) => p.slug === provider)?.models ?? [];
  return (
    <select className="select" aria-label={label} value={value} disabled={!provider} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled>
        {provider ? "Choose a model…" : "Choose a provider first"}
      </option>
      {value && !models.includes(value) && <option value={value}>{value}</option>}
      {models.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

function EffortSelect({ label, value, first, disabled, onChange }: { label: string; value: string; first: [string, string]; disabled?: boolean; onChange: (e: string) => void }) {
  return (
    <select className="select" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value={first[0]}>{first[1]}</option>
      <option value={EFFORT_OFF}>Off</option>
      {EFFORT_LEVELS.map((l) => (
        <option key={l} value={l}>
          {EFFORT_LABEL[l]}
        </option>
      ))}
    </select>
  );
}

/** A part's state and its Discard and Apply, or the guardrail asked in their place. */
function ApplyRow({
  name,
  changed,
  problem,
  error,
  done,
  busy,
  disabled,
  ask,
  onDiscard,
  onApply,
}: {
  name: string;
  changed: boolean;
  problem?: string;
  error?: string;
  done?: boolean;
  busy: boolean;
  disabled: boolean;
  ask?: ReactNode;
  onDiscard: () => void;
  onApply: () => void;
}) {
  const note = error ?? (changed ? (problem ?? "Not applied yet.") : done ? "Applied. New chats use it." : "Same as Hermes.");
  return (
    <div className="settings-row model-apply">
      <div className={`small ${error || (changed && problem) ? "sign-in-error" : "muted"}`} role={error ? "alert" : undefined}>
        {note}
      </div>
      {ask ?? (
        <div className="confirm-actions">
          <button className="btn" disabled={!changed || busy} onClick={onDiscard} aria-label={`Discard ${name} changes`}>
            <RotateCcw size={14} /> Discard
          </button>
          <button className="btn primary" disabled={!changed || !!problem || busy || disabled} onClick={onApply} aria-label={`Apply ${name}`}>
            {busy ? "Applying…" : "Apply"}
          </button>
        </div>
      )}
    </div>
  );
}

export function ModelSettings({ api, profile, connected }: { api: ModelSettingsApi; profile: string; connected: boolean }) {
  const [saved, setSaved] = useState<Settings>();
  const [draft, setDraft] = useState<Draft>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<Part>();
  const [errors, setErrors] = useState<Partial<Record<Part, string>>>({});
  const [done, setDone] = useState<Partial<Record<Part, boolean>>>({});
  const [ask, setAsk] = useState<Ask>();
  /** An Apply is under way. A ref, not just `busy`, so a second click before the next render can't start another. */
  const applying = useRef(false);

  const loaded = saved !== undefined;
  useEffect(() => {
    if (!connected || loaded) return;
    let live = true;
    api.load().then(
      (s) => {
        if (!live) return;
        setSaved(s);
        setDraft(draftFrom(s));
      },
      (e) => live && setLoadError(messageOf(e)),
    );
    return () => void (live = false);
  }, [api, connected, loaded, attempt]);

  if (!saved || !draft) {
    return (
      <section>
        <h2>Main model</h2>
        <div className="settings-row">
          <div className={`small ${loadError ? "sign-in-error" : "muted"}`} role={loadError ? "alert" : undefined}>
            {loadError ? `Couldn't read the model setup: ${loadError}` : connected ? "Reading the model setup from Hermes…" : "Connect to Hermes to see the model setup."}
          </div>
          {loadError && (
            <button
              className="btn"
              onClick={() => {
                setLoadError(undefined);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          )}
        </div>
      </section>
    );
  }

  const providers = saved.providers;
  const edit = (part: Part, change: (d: Draft) => Draft) => {
    setDraft((d) => d && change(d));
    setDone((x) => ({ ...x, [part]: false }));
    setErrors((x) => ({ ...x, [part]: undefined }));
    setAsk((a) => (a && askPart(a) === part ? undefined : a));
  };
  const discard = (part: Part) => edit(part, (d) => ({ ...d, [part]: draftFrom(saved)[part] }));

  /**
   * Applies one part, then reads Hermes back. One Apply runs at a time, and every control is disabled meanwhile, so no
   * edit made during it is overwritten. Once it's all written, that part's draft becomes what Hermes now has; the other
   * parts' drafts are kept. When a guardrail stopped it part way, or a write failed after earlier ones landed, Hermes is
   * still read back, so the screen compares the draft with what Hermes really has.
   */
  const apply = async (part: Part, write: () => Promise<boolean>) => {
    if (applying.current) return;
    applying.current = true;
    setBusy(part);
    setErrors((x) => ({ ...x, [part]: undefined }));
    try {
      const all = await write();
      const fresh = await api.load();
      setSaved(fresh);
      if (!all) return;
      setDraft((d) => d && { ...d, [part]: draftFrom(fresh)[part] });
      setDone((x) => ({ ...x, [part]: true }));
    } catch (e) {
      setErrors((x) => ({ ...x, [part]: messageOf(e) }));
      try {
        setSaved(await api.load());
      } catch {
        // The write's error is the one to show; the next Apply reads Hermes again.
      }
    } finally {
      applying.current = false;
      setBusy(undefined);
    }
  };

  /** Asks the pinned-helpers guardrail first; Hermes answers the expensive-model one, having written nothing. */
  const applyMain = (answered: { pinned?: boolean; expensive?: boolean } = {}) => {
    if (applying.current) return;
    const pinned = answered.pinned || answered.expensive ? undefined : auxPinWarning(saved, draft);
    if (pinned) return setAsk({ kind: "pinned", warning: pinned });
    setAsk(undefined);
    void apply("main", async () => {
      const r = await api.applyMain(saved, draft, answered.expensive);
      if (!r.applied) setAsk({ kind: "expensive", part: "main", message: r.expensive });
      return r.applied;
    });
  };
  const applyAuxiliary = (confirmed: string[] = []) => {
    if (applying.current) return;
    setAsk(undefined);
    void apply("auxiliary", async () => {
      const r = await api.applyAuxiliary(saved, draft, confirmed);
      if (!r.applied) setAsk({ kind: "expensive", part: "auxiliary", message: r.expensive, task: r.task, confirmed: [...confirmed, r.task] });
      return r.applied;
    });
  };
  /** Keep current: the flagged model goes back to what Hermes has; nothing was written for it. */
  const keepCurrent = (a: Ask) => {
    setAsk(undefined);
    if (a.kind !== "expensive") return;
    if (a.part === "main") setDraft((d) => d && { ...d, main: { ...d.main, provider: saved.main.provider, model: saved.main.model } });
    else setDraft((d) => d && { ...d, auxiliary: { ...d.auxiliary, [a.task]: draftFrom(saved).auxiliary[a.task] } });
  };
  const expensiveNode = (a: Ask | undefined, part: Part) =>
    a?.kind === "expensive" && a.part === part ? (
      <div className="confirm" role="alertdialog" aria-label="Expensive model">
        <span className="confirm-msg">
          <ShieldAlert size={12} />{" "}
          {a.part === "main"
            ? `Switch the main model to ${draft.main.model}?`
            : `Use ${draft.auxiliary[a.task]?.model} for ${saved.auxiliary.find((t) => t.task === a.task)?.label ?? a.task}?`}
        </span>
        <span className="confirm-detail">{a.message}</span>
        <div className="confirm-actions">
          <button className="btn" onClick={() => keepCurrent(a)}>
            Keep current
          </button>
          <button className="btn danger" onClick={() => (a.part === "main" ? applyMain({ expensive: true }) : applyAuxiliary(a.confirmed))}>
            Switch anyway
          </button>
        </div>
      </div>
    ) : undefined;

  const m = draft.main;
  const caps = providers.find((p) => p.slug === m.provider)?.caps[m.model];
  const sub = draft.subagent;
  const auxEdited = auxChanged(saved, draft);
  const auxProblems = auxEdited.map((t) => auxProblem(t, draft.auxiliary[t.task])).filter((p): p is string => !!p);
  // Every task with a provider of its own: moving the main model off that provider would leave it behind.
  const pins = pinnedElsewhere(saved.auxiliary, "");
  const pinnedBy = [...new Set(pins.map((t) => t.provider))];

  const askNode =
    ask?.kind === "pinned" ? (
      <div className="confirm" role="alertdialog" aria-label="Auxiliary models still pinned">
        <span className="confirm-msg">
          <TriangleAlert size={12} /> Auxiliary models still pinned to {list(ask.warning.providers.map((p) => providerName(providers, p)))} — apply anyway?
        </span>
        <span>
          {list(ask.warning.tasks.map((t) => t.label))} will keep running there, not on {m.model}. Change them under Auxiliary models to move them
          too.
        </span>
        <div className="confirm-actions">
          <button className="btn" onClick={() => setAsk(undefined)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => applyMain({ pinned: true })}>
            Apply anyway
          </button>
        </div>
      </div>
    ) : (
      expensiveNode(ask, "main")
    );

  return (
    // Disabled while an Apply runs: every select, input and button, guardrail answers included.
    <fieldset className="model-fieldset" disabled={busy !== undefined}>
      <section>
        <h2>Main model</h2>
        <p className="muted">
          The model new chats on the <span className="mono">{profile}</span> profile start with; chats already open keep theirs. Changes stay on this
          screen until you apply them, and leaving Settings drops them.
        </p>
        <div className="model-grid">
          <Field label="Provider">
            <ProviderSelect label="Main provider" value={m.provider} providers={providers} onChange={(p) => edit("main", (d) => ({ ...d, main: chooseProvider(d.main, p) }))} />
          </Field>
          <Field label="Model">
            <ModelSelect
              label="Main model"
              value={m.model}
              provider={m.provider}
              providers={providers}
              onChange={(model) => edit("main", (d) => ({ ...d, main: { ...d.main, model } }))}
            />
          </Field>
          <Field label="Reasoning effort" hint={caps && !caps.reasoning ? "This model doesn't reason." : undefined}>
            <EffortSelect
              label="Main reasoning effort"
              value={m.effort}
              first={["", "Hermes default"]}
              onChange={(effort) => edit("main", (d) => ({ ...d, main: { ...d.main, effort } }))}
            />
          </Field>
          <Field label="Speed" hint={caps && !caps.fast && !m.fast ? "This model has no fast mode." : "Priority processing, where the provider bills more for it."}>
            <span className="check">
              <input
                type="checkbox"
                aria-label="Fast mode"
                checked={m.fast}
                disabled={!!caps && !caps.fast && !m.fast}
                onChange={(e) => edit("main", (d) => ({ ...d, main: { ...d.main, fast: e.target.checked } }))}
              />
              Fast mode
            </span>
          </Field>
        </div>
        <ApplyRow
          name="main model"
          changed={mainChanged(saved, draft)}
          problem={mainProblem(draft)}
          error={errors.main}
          done={done.main}
          busy={busy === "main"}
          disabled={!connected || busy !== undefined}
          ask={askNode}
          onDiscard={() => discard("main")}
          onApply={() => applyMain()}
        />
      </section>

      <section>
        <h2>Subagents</h2>
        <p className="muted">
          The helpers Hermes starts with <span className="mono">delegate_task</span> to work on part of a job. By default they run on the main agent's
          model.
        </p>
        <div className="model-card" role="group" aria-label="Default subagent">
          <div className="appearance-title">Default subagent</div>
          <div className="model-grid">
            <Field label="Route">
              <select
                className="select"
                aria-label="Subagent route"
                value={sub.route}
                onChange={(e) => {
                  const route = SUBAGENT_ROUTES.find((r) => r === e.target.value) ?? "inherit";
                  edit("subagent", (d) => ({ ...d, subagent: chooseRoute(d.subagent, route) }));
                }}
              >
                {SUBAGENT_ROUTES.map((r) => (
                  <option key={r} value={r}>
                    {ROUTE_LABEL[r]}
                  </option>
                ))}
              </select>
            </Field>
            {(sub.route === "parent-model" || sub.route === "provider") && (
              <Field label="Provider">
                <ProviderSelect
                  label="Subagent provider"
                  value={sub.provider}
                  providers={providers}
                  onChange={(p) => edit("subagent", (d) => ({ ...d, subagent: chooseProvider(d.subagent, p) }))}
                />
              </Field>
            )}
            {(sub.route === "custom-model" || sub.route === "provider") && (
              <Field label="Model">
                <ModelSelect
                  label="Subagent model"
                  value={sub.model}
                  provider={sub.route === "custom-model" ? saved.main.provider : sub.provider}
                  providers={providers}
                  onChange={(model) => edit("subagent", (d) => ({ ...d, subagent: { ...d.subagent, model } }))}
                />
              </Field>
            )}
          </div>
          <p className="muted small model-note">
            {sub.route === "inherit"
              ? `Subagents run on the main agent's provider and model, ${saved.main.model}.`
              : sub.route === "parent-model"
                ? `Subagents run the main agent's model, ${saved.main.model}, on the provider chosen here. That provider must offer it.`
                : sub.route === "custom-model"
                  ? `Subagents run the model chosen here on the main agent's provider, ${providerName(providers, saved.main.provider)}, with its credentials.`
                  : "Subagents run on a provider and model of their own."}
          </p>
          <div className="model-grid four">
            <Field label="Turn limit">
              <input
                type="number"
                min={1}
                aria-label="Subagent turn limit"
                value={sub.maxIterations}
                onChange={(e) => edit("subagent", (d) => ({ ...d, subagent: { ...d.subagent, maxIterations: e.target.value } }))}
              />
            </Field>
            <Field label="Concurrency">
              <input
                type="number"
                min={1}
                aria-label="Subagent concurrency"
                value={sub.maxConcurrent}
                onChange={(e) => edit("subagent", (d) => ({ ...d, subagent: { ...d.subagent, maxConcurrent: e.target.value } }))}
              />
            </Field>
            <Field label="Timeout (s)" hint="0: no limit">
              <input
                type="number"
                min={0}
                aria-label="Subagent timeout in seconds"
                value={sub.timeoutSeconds}
                onChange={(e) => edit("subagent", (d) => ({ ...d, subagent: { ...d.subagent, timeoutSeconds: e.target.value } }))}
              />
            </Field>
            <Field label="Reasoning effort">
              <EffortSelect
                label="Subagent reasoning effort"
                value={sub.effort}
                first={["", "Inherit"]}
                onChange={(effort) => edit("subagent", (d) => ({ ...d, subagent: { ...d.subagent, effort } }))}
              />
            </Field>
          </div>
        </div>
        {saved.subagent.directEndpoint && (
          <p className="muted small model-note">
            <TriangleAlert size={12} /> A direct endpoint is set for subagents in Hermes's config, and it takes precedence over the route here. Hermes
            Chat leaves it as it is.
          </p>
        )}
        {saved.namedRoutes > 0 && (
          <p className="muted small model-note">
            {saved.namedRoutes} named {saved.namedRoutes === 1 ? "route" : "routes"} from the advanced-delegation plugin {saved.namedRoutes === 1 ? "is" : "are"}{" "}
            set too; edit them in the official Hermes app.
          </p>
        )}
        <ApplyRow
          name="subagent"
          changed={subagentChanged(saved, sub)}
          problem={subagentProblem(sub)}
          error={errors.subagent}
          done={done.subagent}
          busy={busy === "subagent"}
          disabled={!connected || busy !== undefined}
          onDiscard={() => discard("subagent")}
          onApply={() => void apply("subagent", async () => (await api.applySubagent(saved, sub), true))}
        />
      </section>

      <section>
        <h2>Auxiliary models</h2>
        <p className="muted">
          Helper tasks Hermes runs beside a chat. Each runs on the main model unless it's given one of its own, so cheap helpers can run cheap.
        </p>
        <div className="aux-list">
          {saved.auxiliary.map((t: AuxTask) => {
            const a = draft.auxiliary[t.task];
            const auto = a.provider === AUX_AUTO;
            return (
              <div className="aux-row" key={t.task} role="group" aria-label={t.label}>
                <div className="aux-head">
                  <div className="aux-label">
                    <span className="appearance-title">{t.label}</span>
                    <span className="muted small">{t.hint}</span>
                  </div>
                  <EffortSelect
                    label={`${t.label} effort`}
                    value={a.effort}
                    first={[AUX_INHERIT, "inherit · main model effort"]}
                    onChange={(effort) => edit("auxiliary", (d) => ({ ...d, auxiliary: { ...d.auxiliary, [t.task]: { ...a, effort } } }))}
                  />
                </div>
                <div className="aux-pickers">
                  <select
                    className="select"
                    aria-label={`${t.label} provider`}
                    value={a.provider}
                    onChange={(e) => edit("auxiliary", (d) => ({ ...d, auxiliary: { ...d.auxiliary, [t.task]: chooseAuxProvider(a, e.target.value) } }))}
                  >
                    <option value={AUX_AUTO}>auto · use main model</option>
                    {!auto && !providers.some((p) => p.slug === a.provider) && <option value={a.provider}>{a.provider}</option>}
                    {providers.map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {auto ? (
                    <select className="select" aria-label={`${t.label} model`} value="" disabled>
                      <option value="">{saved.main.model || "main model"}</option>
                    </select>
                  ) : (
                    <ModelSelect
                      label={`${t.label} model`}
                      value={a.model}
                      provider={a.provider}
                      providers={providers}
                      onChange={(model) => edit("auxiliary", (d) => ({ ...d, auxiliary: { ...d.auxiliary, [t.task]: { ...a, model } } }))}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <ApplyRow
          name="auxiliary models"
          changed={auxEdited.length > 0}
          problem={auxProblems[0]}
          error={errors.auxiliary}
          done={done.auxiliary}
          busy={busy === "auxiliary"}
          disabled={!connected || busy !== undefined}
          onDiscard={() => discard("auxiliary")}
          ask={expensiveNode(ask, "auxiliary")}
          onApply={() => applyAuxiliary()}
        />
      </section>

      <section>
        <h2>Guardrails</h2>
        <p className="muted">Checked when you apply a main model, before anything is written.</p>
        <div className="guard">
          <div className="appearance-title">
            <Pin size={13} /> Pinned helper tasks
          </div>
          <div className="muted small">
            {pins.length
              ? `${list(pins.map((t) => t.label))} ${pins.length === 1 ? "is" : "are"} pinned to ${list(pinnedBy.map((p) => providerName(providers, p)))}. Moving the main model to another provider asks first, since they'd keep running there.`
              : "No helper task is pinned to a provider of its own, so they all follow the main model."}
          </div>
        </div>
        <div className="guard">
          <div className="appearance-title">
            <CircleDollarSign size={13} /> Expensive models
          </div>
          <div className="muted small">
            Hermes checks the price of the main model you apply. If it's above Hermes's safety threshold, nothing is switched until you choose Switch
            anyway or Keep current.
          </div>
        </div>
      </section>
    </fieldset>
  );
}
