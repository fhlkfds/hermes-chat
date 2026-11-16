// The Bots view (ADR 0066): one row per bot, which is a Hermes profile, with its picture, name, description, its Bot
// Chat's last message and what it is doing. A row opens the bot's Bot Chat, found by title every time (bots.ts); the
// pen beside it starts an ordinary chat in the bot's profile. The same rows (`BotList`) fill the chat list panel while
// a Bot Chat is open (bot mode). New bot makes a profile through Settings → Profiles' New profile form, and the new
// bot's row is shown once the roster is read again (ADR 0164). In the Bots view each row has a menu (ADR 0187): Edit
// bot, Clone, Pin, Hide and Delete, through Settings → Profiles' own dialogs and `Hermes.editBot`, which never writes
// over a change made elsewhere. Every word comes from the catalogue (ADR 0100).
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Copy, EyeOff, Eye, Loader, MoreHorizontal, Pencil, Pin, PinOff, Plus, RefreshCw, Search, Settings2, ShieldAlert, SquarePen, Trash2, X } from "lucide-react";
import { BotModeUnsupportedError, type Bot, type BotActivity, type BotLook } from "../hermes/bots";
import type { EditResult, Edits } from "../hermes/fieldMerge";
import { PROFILE_ROUTES, profileFailure, type ProfileAction, type ProfileRow } from "../hermes/profiles";
import { composing, useReturnFocus } from "./bits";
import { Menu } from "./ChatMenu";
import { CloneProfileDialog } from "./CloneProfile";
import { pick } from "./keybindings";
import { CopyButton, DeleteProfile, MenuEntry, ProfileForm, blocked, failureText, useSwitchTo, type FormResult, type ProfilesWiring } from "./ProfileSettings";
import { useLocale, type Locale } from "../i18n/locale";

/** How often the roster is read again while the view is open. Hermes's desktop polls every 5 seconds; this is enough. */
export const BOTS_REFRESH_MS = 15_000;

const NO_SUBSCRIBE = () => () => {};
const NO_SNAPSHOT = () => undefined;

/** How long ago, as the view writes it: "now" for under a minute in a row, "just now" in a sentence. */
const agoText = (l: Locale, at: number, justNow: string) => {
  const age = l.fmt.age(at);
  return age === l.time.now ? justNow : l.bots.ago(age);
};

/** What the Bots view needs to change a bot's look: `Hermes.botLook` to open Edit bot on, and `Hermes.editBot`. */
export type BotEditWiring = {
  look: (profile: string) => Promise<BotLook | undefined>;
  edit: (profile: string, edits: Edits<BotLook>) => Promise<EditResult<BotLook>>;
};

/** A dialog a bot's menu opened, on the profile's row as `GET /api/profiles` listed it just before. */
type BotDialog =
  | { kind: "edit"; bot: Bot; row: ProfileRow; rows: ProfileRow[]; look: BotLook }
  | { kind: "delete"; row: ProfileRow }
  | { kind: "clone"; source: string };

/** What the view says above the list after something happened. `focus`: the profile whose row takes focus once listed. `command`: a command to copy. */
type BotsNote = { text: string; warn: boolean; focus?: string; command?: string };

/**
 * `last`: the roster as last read, and when, shown until `load` reads it again (`Hermes.bots`). `pictures`: each bot's
 * picture, by profile. `activity`: what the bot is doing in its Bot Chat. `leaving`: what switching away from the shown
 * profile leaves behind, asked about before a row in another profile opens. `onUnsupported`: this Hermes turned out to
 * have no Bot Mode. `profiles`: Settings → Profiles' wiring, for New bot and each row's menu; without it there is
 * neither. `botEdit`: the menu's Edit bot, Pin and Hide. `onProfileSettings`: shows Settings → Profiles or Persona on a
 * profile.
 */
export function Bots({
  server,
  profile,
  connected,
  last,
  pictures,
  load,
  activity,
  leaving,
  onOpen,
  onNewChat,
  onRefresh,
  onClose,
  onUnsupported,
  profiles,
  botEdit,
  onProfileSettings,
}: {
  server: string;
  profile: string;
  connected: boolean;
  last?: { roster: Bot[]; at: number };
  pictures: Record<string, string>;
  load: () => Promise<unknown>;
  activity: (bot: Bot, roster: readonly Bot[]) => BotActivity;
  leaving?: string;
  onOpen: (bot: Bot) => void;
  onNewChat: (bot: Bot) => void;
  onRefresh: () => void;
  onClose: () => void;
  onUnsupported?: (why: string) => void;
  profiles?: Omit<ProfilesWiring, "showTab">;
  botEdit?: BotEditWiring;
  onProfileSettings?: (name: string, tab: "profiles" | "persona") => void;
}) {
  const l = useLocale();
  const w = l.bots;
  const bots = last?.roster;
  const [error, setError] = useState<string>();
  /** This Hermes turned out to have no Bot Mode, and why. */
  const [unsupported, setUnsupported] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLElement>(null);
  const headId = useId();
  const reads = useRef(0);
  /** New bot's form is open. */
  const [making, setMaking] = useState(false);
  /** What the last New bot or menu action did. */
  const [made, setMade] = useState<BotsNote>();
  const newBtn = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ bot: Bot; x: number; y: number }>();
  const [dialog, setDialog] = useState<BotDialog>();
  /** What had focus when the menu opened, a button of the bot's row, where its dialog puts focus back. */
  const menuFrom = useRef<HTMLElement | null>(null);
  const { switchTo, question } = useSwitchTo(profiles ?? { switchTo: async () => false });
  // Drawn again when the server is found to lack a route or method.
  const store = profiles?.capabilities;
  useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIBE, store?.getSnapshot ?? NO_SNAPSHOT);
  const lacking = (a: ProfileAction) => !!store?.lacksAction("profiles", a);
  const newWhy = !connected ? w.notConnected : lacking("create") ? w.noCreateRoute(PROFILE_ROUTES.create) : undefined;
  useReturnFocus();

  const read = async () => {
    const n = ++reads.current;
    setLoading(true);
    try {
      await load();
      if (n !== reads.current) return;
      setError(undefined);
    } catch (e) {
      if (n !== reads.current) return;
      if (e instanceof BotModeUnsupportedError) {
        setUnsupported(e.message);
        onUnsupported?.(e.message);
      } else setError((e as Error).message);
    } finally {
      if (n === reads.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!connected || unsupported) return;
    void read();
    const every = setInterval(() => void read(), BOTS_REFRESH_MS);
    return () => clearInterval(every);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `read` is new every render, so listing it would restart the poll on every render
  }, [connected, load, unsupported]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const at = e.target;
      if (at instanceof Node && !root.current?.contains(at) && !(at instanceof Element && at.closest(".bots-btn"))) onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);

  // The bot New bot made takes focus once the roster lists it.
  const focus = made?.focus;
  useEffect(() => {
    if (!focus || !bots?.some((b) => b.profile === focus)) return;
    const open = root.current?.querySelector<HTMLElement>(`.bots-row[data-profile="${CSS.escape(focus)}"] .bots-open`);
    open?.focus();
    open?.scrollIntoView({ block: "nearest" });
    setMade((m) => m && { ...m, focus: undefined });
  }, [focus, bots]);

  const onMade = (result: FormResult) => {
    setMaking(false);
    const name = result.select;
    const said = result.notice?.text ?? (name ? l.profiles.created(name) : "");
    setMade({ text: w.made(said).trim(), warn: result.notice?.tone === "warn", focus: name });
    // A search could hide the new bot's row; it is shown once made.
    if (name) setQuery("");
    void read();
  };

  /** Opens `dialog` on the bot's profile as Hermes lists it now, which Edit and Delete show and check against. */
  const open = async (bot: Bot, kind: "edit" | "delete") => {
    if (!profiles) return;
    setMade(undefined);
    try {
      const [rows, look] = await Promise.all([profiles.api.list(), kind === "edit" ? botEdit?.look(bot.profile) : undefined]);
      const row = rows.find((r) => r.name === bot.profile);
      if (!row || (kind === "edit" && !look)) {
        setMade({ text: l.profiles.form.gone(bot.profile), warn: true });
        return void read();
      }
      setDialog(kind === "edit" ? { kind, bot, row, rows, look: look! } : { kind, row });
    } catch (e) {
      setMade({ text: w.openFailed(bot.name, failureText(l, profileFailure(e, "botLook"), bot.profile)), warn: true });
    }
  };

  /** Pin, Unpin, Hide or Show: the row is what the owner saw, so its value is what the change is checked against. */
  const toggle = async (bot: Bot, key: "pinned" | "hidden") => {
    if (!botEdit) return;
    setMade(undefined);
    const saved = await botEdit.edit(bot.profile, { [key]: { from: bot[key], to: !bot[key] } });
    const outcome = saved.fields[key];
    if (outcome?.kind === "failed") setMade({ text: w.notChanged(bot.name, failureText(l, outcome.failure, bot.profile)), warn: true });
    // A bot just hidden leaves the list for the Hidden in Hermes fold, and takes the focus with it.
    requestAnimationFrame(() => {
      if (!root.current || root.current.contains(document.activeElement)) return;
      (root.current.querySelector<HTMLElement>(".bots-hidden-toggle") ?? root.current.querySelector<HTMLElement>(".bots-close"))?.focus();
    });
  };

  const closeDialog = (note?: BotsNote) => {
    setDialog(undefined);
    if (note) setMade(note);
    void read();
  };

  // Focus goes to the first bot once the list is read, or to Close when there is none to show, so Escape closes it.
  const first = useRef(true);
  useEffect(() => {
    if (!(bots || unsupported) || !first.current) return;
    first.current = false;
    (root.current?.querySelector<HTMLElement>(".bots-open") ?? root.current?.querySelector<HTMLElement>(".bots-close"))?.focus();
  }, [bots, unsupported]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // A row's menu takes its own Escape (it prevents the default): that closes the menu, not the view.
    if (composing(e) || e.key !== "Escape" || e.defaultPrevented) return;
    e.stopPropagation();
    onClose();
  };

  const lookWhy = blocked(l, connected, lacking, "botLook");

  return (
    <section ref={root} className="inbox bots" role="dialog" aria-labelledby={headId} onKeyDown={onKeyDown}>
      <header className="inbox-head">
        <div className="inbox-heading">
          <h2 id={headId}>{w.title}</h2>
          <span className="inbox-server" title={w.serverTitle} translate="no">
            {server}
          </span>
        </div>
        {profiles && !unsupported && (
          <button
            ref={newBtn}
            className="icon-btn bots-make"
            title={newWhy ?? w.newBot}
            aria-label={w.newBot}
            disabled={!!newWhy}
            onClick={() => {
              // Focus is the form's now: a roster that arrives later doesn't move it to the first bot.
              first.current = false;
              setMade(undefined);
              setMaking(true);
            }}
          >
            <Plus size={16} />
          </button>
        )}
        <button
          className="icon-btn"
          title={w.checkNow}
          aria-label={w.checkNow}
          onClick={() => {
            onRefresh();
            void read();
          }}
          disabled={!connected || loading || !!unsupported}
        >
          <RefreshCw size={15} />
        </button>
        <button className="icon-btn bots-close" title={w.closeTitle} aria-label={w.close} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <p className="inbox-note bots-about">
        {w.about}
        {profiles && !unsupported && ` ${w.aboutNew}`}
        {profiles && botEdit && !unsupported && ` ${w.aboutMenu}`}
      </p>
      {made && (
        <p className={`inbox-note bots-note bots-made${made.warn ? " err" : ""}`} role="status">
          {made.text}
          {made.command && profiles && (
            <>
              {" "}
              <code translate="no">{made.command}</code> <CopyButton text={made.command} copy={profiles.copyText} />
            </>
          )}
        </p>
      )}
      {unsupported && (
        <p className="inbox-note bots-note err" role="alert">
          {w.noButton(unsupported)}
        </p>
      )}
      {!unsupported && (error || !connected) && (
        <p className={`inbox-note bots-note ${error ? "err" : ""}`} role={error ? "alert" : undefined}>
          {!connected ? w.notConnected : w.readFailed(error ?? "")}
          {last ? ` ${w.asOf(agoText(l, last.at, w.justNow))}` : ""}
        </p>
      )}
      {!unsupported && bots && (
        <div className="model-search">
          <Search size={14} aria-hidden />
          <input placeholder={w.search} aria-label={w.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}
      {!unsupported && (
        <BotList
          bots={bots}
          query={query}
          busy={loading}
          pictures={pictures}
          activity={activity}
          profile={profile}
          leaving={leaving}
          onOpen={onOpen}
          onNewChat={onNewChat}
          onMenu={
            profiles &&
            ((bot, x, y) => {
              menuFrom.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              setMenu({ bot, x, y });
            })
          }
        />
      )}
      {!bots && !error && !unsupported && connected && <div className="empty-hint inbox-empty">{w.reading}</div>}
      {menu && profiles && (
        <Menu label={w.moreFor(menu.bot.name)} x={menu.x} y={menu.y} onClose={() => setMenu(undefined)}>
          {botEdit && (
            <MenuEntry
              icon={<Pencil size={15} />}
              label={w.menu.edit}
              why={!connected ? l.profiles.notConnected : undefined}
              onPick={() => {
                setMenu(undefined);
                void open(menu.bot, "edit");
              }}
            />
          )}
          {profiles.clone && (
            <MenuEntry
              icon={<Copy size={15} />}
              label={w.menu.clone}
              why={blocked(l, connected, lacking, "create")}
              onPick={() => {
                setMenu(undefined);
                setMade(undefined);
                setDialog({ kind: "clone", source: menu.bot.profile });
              }}
            />
          )}
          {botEdit && (
            <>
              <div className="menu-sep" role="separator" />
              <MenuEntry
                icon={menu.bot.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                label={menu.bot.pinned ? w.menu.unpin : w.menu.pin}
                why={lookWhy}
                onPick={() => {
                  setMenu(undefined);
                  void toggle(menu.bot, "pinned");
                }}
              />
              <MenuEntry
                icon={menu.bot.hidden ? <Eye size={15} /> : <EyeOff size={15} />}
                label={menu.bot.hidden ? w.menu.show : w.menu.hide}
                why={lookWhy}
                onPick={() => {
                  setMenu(undefined);
                  void toggle(menu.bot, "hidden");
                }}
              />
            </>
          )}
          {onProfileSettings && (
            <>
              <div className="menu-sep" role="separator" />
              <MenuEntry
                icon={<Settings2 size={15} />}
                label={w.menu.settings}
                onPick={() => {
                  setMenu(undefined);
                  onProfileSettings(menu.bot.profile, "profiles");
                }}
              />
            </>
          )}
          <div className="menu-sep" role="separator" />
          <MenuEntry
            icon={<Trash2 size={15} />}
            label={w.menu.delete}
            danger
            why={menu.bot.isDefault ? l.profiles.builtInKept : blocked(l, connected, lacking, "remove")}
            onPick={() => {
              setMenu(undefined);
              void open(menu.bot, "delete");
            }}
          />
        </Menu>
      )}
      {making && profiles && (
        <ProfileForm
          wiring={profiles}
          rows={bots?.map((b) => ({ name: b.profile }))}
          lacking={lacking}
          returnTo={newBtn}
          heading={w.newBot}
          createLabel={w.createBot}
          noEdit
          onDone={onMade}
          onClose={() => setMaking(false)}
        />
      )}
      {dialog?.kind === "edit" && profiles && botEdit && (
        <ProfileForm
          wiring={profiles}
          row={dialog.row}
          rows={dialog.rows}
          lacking={lacking}
          returnTo={menuFrom}
          heading={w.editTitle(dialog.bot.name)}
          bot={{ look: dialog.look, edit: botEdit.edit }}
          onPersona={onProfileSettings && ((name) => onProfileSettings(name, "persona"))}
          onDone={(result) => closeDialog({ text: result.notice?.text ?? "", warn: result.notice?.tone === "warn", focus: result.select })}
          // Closed without finishing: what saved meanwhile shows in the rows.
          onClose={() => closeDialog()}
        />
      )}
      {dialog?.kind === "delete" && profiles && (
        <DeleteProfile
          wiring={profiles}
          row={dialog.row}
          returnTo={menuFrom}
          switchAway={() => switchTo("default", true)}
          onDone={(n) => {
            closeDialog({ text: n.text, warn: n.tone !== "muted", command: n.command });
            // The deleted bot's row is gone, and the focus with it.
            root.current?.querySelector<HTMLElement>(".bots-close")?.focus();
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "clone" && profiles?.clone && (
        <CloneProfileDialog
          api={profiles.clone}
          current={dialog.source}
          returnTo={menuFrom}
          onClose={() => closeDialog()}
          onMade={() => void read()}
          onOpen={(name) => {
            closeDialog();
            void switchTo(name).then((switched) => switched && onClose());
          }}
        />
      )}
      {question}
    </section>
  );
}

/**
 * The bots' rows, in the Bots view and in the chat list panel's bot mode: pinned first, hidden ones behind a
 * disclosure, Up and Down between them. A row in another profile than `profile` asks first while `leaving` says what
 * switching leaves behind. `current`: the profile of the bot whose Bot Chat is open. `query`: show only the bots whose name
 * holds it, in any case.
 */
export function BotList({
  bots,
  query = "",
  busy,
  pictures,
  activity,
  profile,
  current,
  leaving,
  onOpen,
  onNewChat,
  onMenu,
}: {
  bots?: Bot[];
  query?: string;
  busy?: boolean;
  pictures: Record<string, string>;
  activity: (bot: Bot, roster: readonly Bot[]) => BotActivity;
  profile: string;
  current?: string;
  leaving?: string;
  onOpen: (bot: Bot) => void;
  onNewChat: (bot: Bot) => void;
  /** Opens a bot's menu at a point of the window; without it the rows have no menu. */
  onMenu?: (bot: Bot, x: number, y: number) => void;
}) {
  const l = useLocale();
  const w = l.bots;
  const [showHidden, setShowHidden] = useState(false);
  const [asking, setAsking] = useState<{ bot: Bot; then: "open" | "new" }>();

  const go = (bot: Bot, then: "open" | "new") => {
    if (bot.profile !== profile && leaving) return setAsking({ bot, then });
    setAsking(undefined);
    (then === "open" ? onOpen : onNewChat)(bot);
  };

  // Escape takes the question away wherever focus is, before it closes the Bots view or reaches anything else.
  useEffect(() => {
    if (!asking) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopPropagation();
      setAsking(undefined);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [asking]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // WebKitGTK sends no contextmenu event for Shift+F10, so the menu's keys are read here, from any button of a row.
    if (onMenu && pick(e, "chatRow") === "rowMenu") {
      const li = document.activeElement?.closest<HTMLElement>(".bots-row");
      const bot = bots?.find((b) => b.profile === li?.dataset.profile);
      if (!li || !bot) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      return onMenu(bot, r.left + 24, r.bottom);
    }
    if (composing(e) || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".bots-open"));
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    rows[at + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
  };

  // Pinned bots first, then Hermes's order. Hidden ones wait behind a disclosure, as in Hermes's own list.
  const q = query.trim().toLowerCase();
  const matching = (bots ?? []).filter((b) => b.name.toLowerCase().includes(q));
  const shown = matching.filter((b) => !b.hidden).sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const hidden = matching.filter((b) => b.hidden);
  const row = (b: Bot) => (
    <Row
      key={b.profile}
      bot={b}
      picture={pictures[b.profile]}
      activity={activity(b, bots ?? [])}
      shown={b.profile === profile}
      current={b.profile === current}
      onOpen={() => go(b, "open")}
      onNewChat={() => go(b, "new")}
      onMenu={onMenu && ((x, y) => onMenu(b, x, y))}
    />
  );

  return (
    <>
      {asking && (
        <div
          className="confirm inbox-leave"
          role="alertdialog"
          aria-label={w.switchTitle(asking.bot.profile)}
        >
          <span>{leaving}</span>
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={() => setAsking(undefined)}>
              {w.stay}
            </button>
            <button
              className="btn primary"
              onClick={() => {
                setAsking(undefined);
                (asking.then === "open" ? onOpen : onNewChat)(asking.bot);
              }}
            >
              {w.switchTo(asking.bot.profile)}
            </button>
          </div>
        </div>
      )}
      <ul className="inbox-list bots-list" aria-label={w.list} aria-busy={!bots && busy} onKeyDown={onKeyDown}>
        {shown.map(row)}
        {hidden.length > 0 && (
          <li className="bots-hidden">
            <button className="bots-hidden-toggle" aria-expanded={showHidden} onClick={() => setShowHidden((s) => !s)}>
              {showHidden ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
              {w.hidden(hidden.length)}
            </button>
          </li>
        )}
        {showHidden && hidden.map(row)}
      </ul>
      {bots && q && !matching.length && <div className="empty-hint inbox-empty">{w.noMatch(query.trim())}</div>}
    </>
  );
}

function Row({
  bot: b,
  picture,
  activity,
  shown,
  current,
  onOpen,
  onNewChat,
  onMenu,
}: {
  bot: Bot;
  picture?: string;
  activity: BotActivity;
  shown: boolean;
  current: boolean;
  onOpen: () => void;
  onNewChat: () => void;
  onMenu?: (x: number, y: number) => void;
}) {
  const l = useLocale();
  const w = l.bots;
  const more = useRef<HTMLButtonElement>(null);
  const preview = b.botChat?.preview || (b.botChat ? w.noMessages : w.noBotChat);
  const when = b.lastActive ? agoText(l, b.lastActive, l.time.now) : "";
  const state = activity === "replying" ? w.replying : activity === "needs-you" ? w.needsYou : undefined;
  const label = w.rowLabel(
    [
      b.profile !== b.name.toLowerCase() ? w.rowProfile(b.name, b.profile) : b.name,
      state,
      b.description,
      b.botChat?.preview ? w.rowLast(b.botChat.preview) : preview,
      when && w.rowActive(when),
      shown && w.rowShown,
    ].filter((part): part is string => !!part),
  );
  return (
    <li
      data-profile={b.profile}
      className={`inbox-row bots-row${activity ? ` is-${activity}` : ""}${b.hidden ? " is-hidden" : ""}${current ? " is-current" : ""}`}
      onContextMenu={
        onMenu &&
        ((e) => {
          e.preventDefault();
          onMenu(e.clientX, e.clientY);
        })
      }
    >
      <button className="bots-open" aria-label={label} aria-current={current || undefined} onClick={onOpen}>
        <span className={`bots-face${b.color ? " has-color" : ""}`} style={b.color ? { background: b.color } : undefined} aria-hidden translate="no">
          {picture ? <img src={picture} alt="" /> : (b.name.trim()[0] ?? "?").toUpperCase()}
        </span>
        <span className="bots-text">
          <span className="inbox-line">
            <span className="bots-name" translate="no">
              {b.name}
            </span>
            {state ? (
              <span className={`bots-activity is-${activity}`}>
                {activity === "needs-you" ? <ShieldAlert size={12} aria-hidden /> : <Loader size={12} aria-hidden />}
                {state}
              </span>
            ) : (
              when && (
                <time className="inbox-time" dateTime={new Date(b.lastActive).toISOString()} title={l.fmt.dateTime(b.lastActive)}>
                  {when}
                </time>
              )
            )}
          </span>
          {b.description && (
            <span className="bots-desc" translate="no">
              {b.description}
            </span>
          )}
          <span className={`bots-preview${b.botChat?.preview ? "" : " is-empty"}`} translate={b.botChat?.preview ? "no" : undefined}>
            {preview}
          </span>
        </span>
      </button>
      <button className="icon-btn bots-new" title={w.newChat(b.name)} aria-label={w.newChat(b.name)} onClick={onNewChat}>
        <SquarePen size={14} />
      </button>
      {onMenu && (
        <button
          ref={more}
          className="icon-btn bots-more"
          title={w.moreFor(b.name)}
          aria-label={w.moreFor(b.name)}
          aria-haspopup="menu"
          onClick={() => {
            const r = more.current!.getBoundingClientRect();
            onMenu(r.left, r.bottom);
          }}
        >
          <MoreHorizontal size={15} />
        </button>
      )}
    </li>
  );
}
