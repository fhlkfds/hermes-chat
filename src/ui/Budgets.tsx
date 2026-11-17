// Usage → Budgets (ADR 0190): the limits kept on this computer for this connection, what each has spent in its period,
// where it is heading and the chats behind it. Everything shown comes from the connection's budget watch
// (budgetWatch.ts): this tab reads nothing from Hermes itself and holds no copy of the budgets.
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { CircleAlert, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  BUDGET_NOTES,
  amountLabel,
  draftOf,
  scopeLabel,
  spentLabel,
  windowLabel,
  type Budget,
  type BudgetReading,
  type BudgetScope,
  type BudgetWindow,
  type Every,
  type Forecast,
  type Limit,
  type ReadReading,
  type Spent,
  type Unreadable,
} from "../hermes/budgets";
import type { BudgetWatch } from "../hermes/budgetWatch";
import type { Project } from "../hermes/projects";
import type { UsageChat } from "../hermes/usageAnalytics";
import { errorText } from "../hermes/values";
import { Spinner } from "./bits";
import { useLocale, type Formats } from "../i18n/locale";

const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const EVERY_LABEL: Record<Every, string> = { day: "Daily", week: "Weekly", month: "Monthly" };

type ScopeKind = BudgetScope["kind"];
type Form = { id?: Budget["id"]; kind: ScopeKind; profile: string; project: string; model: string; every: Every; unit: Limit["unit"]; amount: string };

export type BudgetsProps = {
  /** This connection's budget watch; none while it isn't live. */
  watch?: BudgetWatch;
  /** The profile the app shows: its projects are the ones known here. */
  profile: string;
  listProfiles: () => Promise<string[]>;
  projects: Project[];
  connected: boolean;
  /** Opens a chat of the shown profile. */
  onOpenChat: (chat: UsageChat) => void;
  now?: () => number;
  /** The clock a new budget runs on: this computer's zone. */
  zone?: string;
};

export function Budgets({ watch, ...props }: BudgetsProps) {
  if (!watch) return <div className="empty-hint jobs-empty">Budgets show once this connection is open.</div>;
  return <BudgetsOf watch={watch} {...props} />;
}

function BudgetsOf({ watch, profile, listProfiles, projects, connected, onOpenChat, zone = HERE }: BudgetsProps & { watch: BudgetWatch }) {
  const { fmt } = useLocale();
  const board = useSyncExternalStore(watch.subscribe, watch.getSnapshot);
  const [profiles, setProfiles] = useState<string[]>([profile]);
  const [form, setForm] = useState<Form>();
  const [formError, setFormError] = useState<string>();
  const [removeError, setRemoveError] = useState<string>();

  // Fresh figures on opening the tab: a check younger than half a minute answers it.
  useEffect(() => void watch.check(), [watch]);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    listProfiles().then(
      (names) => live && setProfiles(names.includes(profile) ? names : [profile, ...names]),
      () => {},
    );
    return () => void (live = false);
  }, [listProfiles, profile, connected]);

  const open = (f: Partial<Form>) => {
    setFormError(undefined);
    setForm({ kind: "profile", profile, project: projects.find((p) => !p.archived)?.id ?? "", model: "", every: "day", unit: "usd", amount: "", ...f });
  };
  const edit = (b: Budget) =>
    open({
      id: b.id,
      kind: b.scope.kind,
      ...(b.scope.kind === "profile" || b.scope.kind === "project" ? { profile: b.scope.profile } : {}),
      ...(b.scope.kind === "project" ? { project: b.scope.project } : {}),
      ...(b.scope.kind === "model" ? { model: b.scope.model } : {}),
      every: b.period.every,
      unit: b.limit.unit,
      amount: String(b.limit.amount),
    });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const scope: BudgetScope =
      form.kind === "server"
        ? { kind: "server" }
        : form.kind === "profile"
          ? { kind: "profile", profile: form.profile }
          : form.kind === "project"
            ? { kind: "project", profile: form.profile, project: form.project }
            : { kind: "model", model: form.model };
    const old = form.id ? board.budgets.find((b) => b.id === form.id) : undefined;
    const d = draftOf({ scope, every: form.every, zone: old?.period.zone ?? zone, unit: form.unit, amount: form.amount, id: form.id });
    if ("error" in d) return setFormError(d.error);
    // A save storage refuses keeps the form open, with why.
    try {
      const checked = watch.save(d);
      setForm(undefined);
      await checked;
    } catch (err) {
      setFormError(errorText(err));
    }
  };

  const state = board.state;
  const status = !connected
    ? "Not connected to Hermes: budgets aren't checked until it is."
    : state === "reading"
      ? "Checking…"
      : typeof state === "object"
        ? `Couldn't check: ${state.failed}`
        : board.readAt !== undefined
          ? `Checked ${fmt.time(board.readAt)} · every 5 minutes while connected`
          : board.budgets.length
            ? "Not checked yet."
            : "";

  return (
    <>
      <p className="muted">
        Limits on what Hermes records for this server, kept on this computer. Each budget shows what it has spent, where it is heading and the chats
        behind it, and the app tells you when it reaches 50, 80 and 100%.
      </p>
      <div className="usage-status">
        <span role="status" aria-live="polite" className={`muted small${typeof state === "object" ? " usage-error" : ""}`}>
          {status}
        </span>
        {state === "reading" && <Spinner />}
        <span className="usage-status-actions">
          <button className="btn" disabled={!connected || state === "reading" || !board.budgets.length} onClick={() => void watch.check({ force: true })}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="btn primary" disabled={!!form} onClick={() => open({})}>
            <Plus size={14} /> Add budget
          </button>
        </span>
      </div>

      {form && (
        <BudgetForm
          form={form}
          error={formError}
          profiles={profiles}
          profile={profile}
          projects={projects}
          projectName={watch.projectName}
          onChange={(f) => setForm({ ...form, ...f })}
          onSave={save}
          onCancel={() => setForm(undefined)}
        />
      )}

      {removeError && (
        <p className="usage-error" role="alert">
          Couldn't remove the budget: {removeError}
        </p>
      )}
      {!board.budgets.length && !form && <div className="empty-hint jobs-empty">No budgets yet. Add one to set a daily, weekly or monthly limit.</div>}
      <ul className="budget-list">
        {board.budgets.map((b) => {
          const r = board.readings.find((x) => x.budget.id === b.id);
          return (
            <li key={b.id}>
              <BudgetCard
                budget={b}
                reading={r}
                fmt={fmt}
                shownProfile={profile}
                projectName={watch.projectName}
                onEdit={() => edit(b)}
                onRemove={() => {
                  try {
                    watch.remove(b.id);
                  } catch (err) {
                    setRemoveError(errorText(err));
                  }
                }}
                onTokenBudget={() =>
                  open({
                    kind: b.scope.kind,
                    ...((b.scope.kind === "profile" || b.scope.kind === "project") && { profile: b.scope.profile }),
                    ...(b.scope.kind === "model" && { model: b.scope.model }),
                    ...(b.scope.kind === "project" && { project: b.scope.project }),
                    every: b.period.every,
                    unit: "tokens",
                  })
                }
                onOpenChat={onOpenChat}
              />
            </li>
          );
        })}
      </ul>

      <section className="usage-section budget-notes" aria-labelledby="budget-notes">
        <h2 id="budget-notes">How budgets count</h2>
        <ul className="usage-note">
          {BUDGET_NOTES.map((n) => (
            <li key={n}>{n}</li>
          ))}
          <li>
            Days start at midnight on this computer's clock when a budget is made ({zone}), and weeks start on Monday. A model budget counts the last 24
            hours, 7 days or 30 days, the only periods Hermes's per-model sums give.
          </li>
          <li>No brakes yet: a budget warns, and stops nothing.</li>
        </ul>
      </section>
    </>
  );
}

function BudgetForm({
  form,
  error,
  profiles,
  profile,
  projects,
  projectName,
  onChange,
  onSave,
  onCancel,
}: {
  form: Form;
  error?: string;
  profiles: string[];
  profile: string;
  projects: Project[];
  projectName: (profile: string, project: string) => string | undefined;
  onChange: (f: Partial<Form>) => void;
  onSave: (e: FormEvent) => void;
  onCancel: () => void;
}) {
  const editing = !!form.id;
  return (
    <form className="budget-form" onSubmit={onSave} aria-label={editing ? "Edit budget" : "New budget"}>
      <div className="usage-filters">
        <label>
          <span>For</span>
          {/* A project is picked from the shown profile's, so it is that profile's project. */}
          <select
            value={form.kind}
            disabled={editing}
            onChange={(e) => onChange({ kind: e.target.value as ScopeKind, ...(e.target.value === "project" && { profile, project: projects.find((p) => !p.archived)?.id ?? "" }) })}
          >
            <option value="server">This server</option>
            <option value="profile">A profile</option>
            <option value="project">A project</option>
            <option value="model">A model</option>
          </select>
        </label>
        {form.kind === "profile" && (
          <label>
            <span>Profile</span>
            <select value={form.profile} disabled={editing} onChange={(e) => onChange({ profile: e.target.value })}>
              {profiles.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
        )}
        {form.kind === "project" && form.profile !== profile && (
          <label>
            <span>Project in {form.profile}</span>
            <select value={form.project} disabled>
              <option value={form.project}>{projectName(form.profile, form.project) ?? form.project}</option>
            </select>
          </label>
        )}
        {form.kind === "project" && form.profile === profile && (
          <label>
            <span>Project in {profile}</span>
            <select value={form.project} disabled={editing} onChange={(e) => onChange({ project: e.target.value })}>
              {!projects.length && <option value="">No projects</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.archived ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {form.kind === "model" && (
          <label>
            <span>Model, as Hermes names it</span>
            <input value={form.model} disabled={editing} placeholder="gpt-5" onChange={(e) => onChange({ model: e.target.value })} />
          </label>
        )}
        <label>
          <span>{form.kind === "model" ? "Over the last" : "Every"}</span>
          <select value={form.every} onChange={(e) => onChange({ every: e.target.value as Every })}>
            <option value="day">{form.kind === "model" ? "24 hours" : "Day"}</option>
            <option value="week">{form.kind === "model" ? "7 days" : "Week"}</option>
            <option value="month">{form.kind === "model" ? "30 days" : "Month"}</option>
          </select>
        </label>
        <label>
          <span>In</span>
          <select value={form.unit} onChange={(e) => onChange({ unit: e.target.value as Limit["unit"] })}>
            <option value="usd">Dollars</option>
            <option value="tokens">Tokens</option>
          </select>
        </label>
        <label>
          <span>Limit</span>
          <input
            value={form.amount}
            inputMode="decimal"
            placeholder={form.unit === "usd" ? "$10" : "2M"}
            aria-invalid={!!error}
            onChange={(e) => onChange({ amount: e.target.value })}
            autoFocus
          />
        </label>
      </div>
      {error && <p className="usage-error">{error}</p>}
      {form.kind === "project" && <p className="usage-note">A project budget counts the chats this computer files in the project.</p>}
      <div className="budget-form-actions">
        <button className="btn primary" type="submit">
          {editing ? "Save" : "Add budget"}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function periodText(w: BudgetWindow, fmt: Formats): string {
  if (w.kind === "rolling") return `Rolling · ${windowLabel(w)}`;
  return `${EVERY_LABEL[w.every]} · ${windowLabel(w)}, until ${fmt.dateTime(w.to)}`;
}

function forecastText(f: Forecast, spent: Spent, limit: Limit, w: BudgetWindow, fmt: Formats): string {
  const end = w.every === "day" ? "the day" : `the ${w.every}`;
  switch (f.kind) {
    case "projected":
      return `At this pace, ${f.atLeast ? "at least " : ""}${amountLabel(f.total, limit.unit)} by the end of ${end} (${pct(f.share)} of the limit)${
        f.reachesAt !== undefined ? `, reaching the limit about ${fmt.dateTime(f.reachesAt)}` : ""
      }.`;
    case "over":
      return `Over the limit. At this pace, ${f.atLeast ? "at least " : ""}${amountLabel(f.total, limit.unit)} by the end of ${end}.`;
    case "none":
      return f.why === "too-early"
        ? `A forecast starts at ${fmt.dateTime(f.from!)}, once enough of ${end} has passed.`
        : f.why === "rolling"
          ? "No forecast: a model budget counts a stretch that moves with the clock, so it has no end to project to."
          : spent.tokens > 0
            ? "Nothing Hermes could price yet, so no forecast."
            : "Nothing spent yet, so no forecast.";
  }
}

function unreadableText(why: Unreadable): string {
  switch (why.kind) {
    case "profile-failed":
      return `Couldn't read Hermes for it: ${why.error}`;
    case "models-unsupported":
      return "This Hermes has no per-model sums (GET /api/analytics/models), so a model budget can't be counted. Updating Hermes on the server adds them.";
    case "models-failed":
      return `Couldn't read Hermes's per-model sums: ${why.error}`;
    case "project-gone":
      return "This project is gone, so nothing counts toward it.";
  }
}

function BudgetCard({
  budget,
  reading,
  fmt,
  shownProfile,
  projectName,
  onEdit,
  onRemove,
  onTokenBudget,
  onOpenChat,
}: {
  budget: Budget;
  reading?: BudgetReading;
  fmt: Formats;
  shownProfile: string;
  projectName: (profile: string, project: string) => string | undefined;
  onEdit: () => void;
  onRemove: () => void;
  onTokenBudget: () => void;
  onOpenChat: (chat: UsageChat) => void;
}) {
  const title = scopeLabel(budget.scope, projectName);
  const r = reading?.state === "read" ? reading : undefined;
  const label = r && spentLabel(r.spent, budget.limit);
  const tone = r?.level === 100 ? "bad" : r?.level === 80 ? "warn" : "";
  return (
    <article className={`budget-card ${tone}`} aria-label={`${title}, ${EVERY_LABEL[budget.period.every].toLowerCase()} budget`}>
      <header className="budget-head">
        <div>
          <h2>{title}</h2>
          <p className="muted small">{reading ? periodText(reading.window, fmt) : `${EVERY_LABEL[budget.period.every]} limit of ${amountLabel(budget.limit.amount, budget.limit.unit)}`}</p>
        </div>
        <span className="budget-actions">
          <button className="icon-btn" aria-label="Edit budget" title="Edit" onClick={onEdit}>
            <Pencil size={14} />
          </button>
          <button className="icon-btn" aria-label="Remove budget" title="Remove" onClick={onRemove}>
            <Trash2 size={14} />
          </button>
        </span>
      </header>
      {!reading && <p className="usage-note">Not checked yet.</p>}
      {reading?.state === "unreadable" && (
        <p className="usage-error">
          <CircleAlert size={13} /> {unreadableText(reading.why)}
        </p>
      )}
      {r && label && (
        <>
          <div className="budget-figure">
            <span className="budget-spent">{label.short}</span>
            <span className="budget-share">{pct(r.spent.share)}</span>
          </div>
          <div
            className="budget-meter"
            role="meter"
            aria-label="Share of the limit spent"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.round(r.spent.share * 100))}
          >
            <span className="budget-meter-fill" style={{ width: `${Math.min(100, r.spent.share * 100)}%` }} />
            <span className="budget-tick" style={{ left: "50%" }} />
            <span className="budget-tick" style={{ left: "80%" }} />
          </div>
          {r.spent.unit === "usd" && <p className="muted small">{`${fmtTokens(r.spent.tokens)} tokens used.`}</p>}
          <p className="budget-forecast">{forecastText(r.forecast, r.spent, budget.limit, r.window, fmt)}</p>
          {label.detail.length > 0 && (
            <ul className="usage-note budget-gaps">
              {label.detail.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
          {r.spent.gaps.some((g) => g.kind === "unpriced") && (
            <button className="btn small" onClick={onTokenBudget}>
              Add a token budget for this
            </button>
          )}
          <TopChats r={r} fmt={fmt} shownProfile={shownProfile} onOpenChat={onOpenChat} />
        </>
      )}
    </article>
  );
}

const fmtTokens = (n: number) => amountLabel(n, "tokens").replace(/ tokens$/, "");

function TopChats({ r, fmt, shownProfile, onOpenChat }: { r: ReadReading; fmt: Formats; shownProfile: string; onOpenChat: (chat: UsageChat) => void }) {
  const { top, budget } = r;
  if (!top.chats.length) return <p className="usage-note">No chats {r.window.kind === "rolling" ? "in this stretch" : "started in this period"} yet.</p>;
  const several = budget.scope.kind === "server" || budget.scope.kind === "model";
  return (
    <div className="budget-top">
      <h3>Top chats</h3>
      <ol>
        {top.chats.map((t) => (
          <li key={`${t.chat.profile}\n${t.chat.id}`}>
            {t.chat.profile === shownProfile ? (
              <button className="link budget-chat" onClick={() => onOpenChat(t.chat)}>
                {t.chat.title}
              </button>
            ) : (
              <span className="budget-chat">{t.chat.title}</span>
            )}
            <span className="muted small">
              {several ? `${t.chat.profile} · ` : ""}started {fmt.dateTime(t.chat.startedAt)}
            </span>
            <span className="budget-chat-amount">
              {amountLabel(t.counted, budget.limit.unit)}
              {top.basis === "exact" && t.share > 0 ? ` · ${pct(t.share)}` : ""}
            </span>
          </li>
        ))}
      </ol>
      {top.more > 0 && <p className="usage-note">and {fmt.number(top.more)} more.</p>}
      {top.basis === "last-model" && (
        <p className="usage-note">Hermes names only the model a chat used last, so these are the chats that ended on this model. One that switched models may be missing, or shown whole.</p>
      )}
    </div>
  );
}
