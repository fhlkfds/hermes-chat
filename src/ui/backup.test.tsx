// @vitest-environment jsdom
// The Backup dialogs with the archive side replaced: export shows what's in it and what never is, and saves only where
// the owner picks; restore shows the schema, places and per-category plan before anything is written, refuses
// damaged and newer backups, waits for running replies, and reports what was restored or failed.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CATEGORY_IDS, makeBackup, type BackupEnv, type Entry, type PickedBackup } from "../hermes/backup";
import { draftKey, drafts } from "../hermes/drafts";
import { storageDefaultsFile } from "../hermes/projectDefaults";
import { ExportDialog, RestoreDialog, type BackupWiring } from "./Backup";

beforeAll(() => {
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(cleanup);

const conn = { mode: "ssh" as const, sshTarget: "liam@hermes.lan", url: "", username: "liam" };

/** `writes`: how many writes succeed before every later one is refused, as a full store does. */
function store(writes = Infinity): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      if (writes-- <= 0) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      m.set(k, v);
    },
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}
const envOf = (s: Storage): BackupEnv => ({ storage: s, tags: storageDefaultsFile(() => s, "hermes-chat.tags"), defaults: storageDefaultsFile(() => s) });

function setUp(opts: { picks?: (PickedBackup | null)[]; busy?: string; recovery?: () => Promise<string>; storage?: Storage } = {}) {
  const storage = opts.storage ?? store();
  const env = envOf(storage);
  const saved: { entries: Entry[]; name: string }[] = [];
  const reload = vi.fn();
  const onClose = vi.fn();
  const wiring: BackupWiring = {
    env,
    connection: { mode: "ssh", target: "liam@hermes.lan", username: "liam" },
    profiles: async () => ["default", "work"],
    profile: "default",
    busy: opts.busy ? () => opts.busy : undefined,
    reload,
    archive: {
      save: async (entries, name) => (saved.push({ entries, name }), "/home/liam/hermes-chat-backup-2026-11-04.zip"),
      pick: async () => opts.picks?.shift() ?? null,
      saveRecovery: opts.recovery ?? (async () => "/home/liam/.local/share/hermes-chat/backups/recovery-1.zip"),
    },
  };
  return { storage, env, wiring, saved, reload, onClose };
}

async function backupWith(fill: (s: Storage) => void): Promise<PickedBackup> {
  const s = store();
  fill(s);
  return { name: "b.zip", path: "/home/liam/b.zip", bytes: 4096, entries: await makeBackup(envOf(s), CATEGORY_IDS) };
}

describe("Export backup", () => {
  it("shows what it holds and what never is, then saves where the owner picks", async () => {
    const t = setUp();
    drafts(t.storage).set(draftKey(conn, "default", "chat-a"), "A draft");
    render(<ExportDialog wiring={t.wiring} onClose={t.onClose} />);
    const dialog = await screen.findByRole("dialog", { name: "Export backup" });
    expect((within(dialog).getByRole("checkbox", { name: /Drafts \(1\)/ }) as HTMLInputElement).checked).toBe(true);
    expect(dialog.textContent).toContain("It holds personal and chat data");
    expect(dialog.textContent).toContain("ssh liam@hermes.lan as liam, default");
    expect(within(dialog).getByText(/Passwords, extra request header values/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Settings/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Choose where to save…" }));
    await screen.findByText(/Saved the backup to/);
    expect(t.saved[0].name).toMatch(/^hermes-chat-backup-\d{4}-\d\d-\d\d\.zip$/);
    expect(t.saved[0].entries.map((e) => e.name)).not.toContain("settings.json");
    expect(t.saved[0].entries.map((e) => e.name)).toContain("drafts.json");
  });
});

describe("Restore a backup", () => {
  it("previews counts, schema, places and policies, restores, and reports", async () => {
    const picked = await backupWith((s) => {
      drafts(s).set(draftKey(conn, "default", "chat-a"), "From the backup");
      drafts(s).set(draftKey(conn, "work", "chat-w"), "Work");
    });
    const t = setUp({ picks: [picked] });
    drafts(t.storage).set(draftKey(conn, "default", "chat-a"), "Newer here");
    render(<RestoreDialog wiring={t.wiring} onClose={t.onClose} />);
    await userEvent.click(await screen.findByRole("button", { name: "Choose backup…" }));
    const dialog = await screen.findByRole("dialog", { name: "Restore a backup" });
    await within(dialog).findByText(/every file matches its checksum/);
    expect(dialog.textContent).toContain("version 1");
    const places = within(dialog).getByRole("table", { name: "Where each connection and profile goes" });
    expect(within(places).getAllByRole("combobox").map((c) => (c as HTMLSelectElement).value)).toEqual(["default", "work"]);
    const what = within(dialog).getByRole("table", { name: "What is restored" });
    const draftsRow = within(what).getByText("Drafts").closest("tr")!;
    expect(draftsRow.textContent).toContain("1 added; 1 conflicting, this computer's kept.");
    // Nothing is written by the preview.
    expect(drafts(t.storage).get(draftKey(conn, "work", "chat-w"))).toBe("");

    await userEvent.selectOptions(within(draftsRow).getByRole("combobox"), "replace");
    expect(draftsRow.textContent).toContain("1 added; 1 replacing this computer's.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    await within(dialog).findByText(/Restored the backup/);
    expect(dialog.textContent).toContain("recovery-1.zip");
    const report = within(dialog).getByRole("table", { name: "What was restored" });
    expect(within(report).getByText("Drafts").closest("tr")!.textContent).toContain("Restored");
    // Escape can't close it over a store the app hasn't reread: Reload is the way out.
    await userEvent.keyboard("{Escape}");
    expect(t.onClose).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Reload Hermes Chat" }));
    expect(t.reload).toHaveBeenCalled();
    expect(drafts(t.storage).get(draftKey(conn, "default", "chat-a"))).toBe("From the backup");
  });

  it("says what Replace removes for a category the backup holds none of", async () => {
    const picked = await backupWith((s) => drafts(s).set(draftKey(conn, "default", "c"), "x"));
    const t = setUp({ picks: [picked] });
    t.env.tags = storageDefaultsFile(() => t.storage, "hermes-chat.tags");
    t.storage.setItem("hermes-chat.tags", JSON.stringify({ v: 1, scopes: { '["ssh","liam@hermes.lan","liam","default"]': { tags: [{ id: "t", name: "Mine" }], chats: {}, filters: [] } } }));
    render(<RestoreDialog wiring={t.wiring} onClose={t.onClose} />);
    await userEvent.click(await screen.findByRole("button", { name: "Choose backup…" }));
    const what = await screen.findByRole("table", { name: "What is restored" });
    const row = within(what).getByText("Tags and Saved filters").closest("tr")!;
    expect(row.textContent).toContain("None in the backup.");
    await userEvent.selectOptions(within(row).getByRole("combobox"), "replace");
    expect(row.textContent).toContain("1 of this computer's removed.");
  });

  it("asks where an unknown connection goes, and waits for running replies", async () => {
    const other = { mode: "url" as const, sshTarget: "", url: "https://old.example.com", username: "liam" };
    const picked = await backupWith((s) => drafts(s).set(draftKey(other, "default", "c"), "Old server"));
    const t = setUp({ picks: [picked], busy: "A reply is running or an Approval is waiting." });
    render(<RestoreDialog wiring={t.wiring} onClose={t.onClose} />);
    await userEvent.click(await screen.findByRole("button", { name: "Choose backup…" }));
    const map = await screen.findByRole("combobox", { name: /Restore https:\/\/old.example.com as liam, profile default, into/ });
    expect((map as HTMLSelectElement).value).toBe("?");
    expect(screen.getByRole("alert").textContent).toContain("Choose where each connection and profile");
    expect((screen.getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.selectOptions(map, "work");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("A reply is running"));
    expect((screen.getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses a damaged or newer backup with nothing written, and stays usable", async () => {
    const good = await backupWith((s) => drafts(s).set(draftKey(conn, "default", "c"), "x"));
    const damaged = { ...good, entries: good.entries.map((e) => (e.name === "drafts.json" ? { ...e, text: e.text.replace('"x"', '"y"') } : e)) };
    const newer = { ...good, entries: good.entries.map((e) => (e.name === "manifest.json" ? { ...e, text: e.text.replace('"schema": 1', '"schema": 7') } : e)) };
    const t = setUp({ picks: [damaged, newer] });
    render(<RestoreDialog wiring={t.wiring} onClose={t.onClose} />);
    await userEvent.click(await screen.findByRole("button", { name: "Choose backup…" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Nothing was restored. drafts.json doesn't match its checksum");
    await userEvent.click(screen.getByRole("button", { name: "Choose backup…" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("A newer Hermes Chat made it (backup schema 7)"));
    expect(t.storage.length).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(t.onClose).toHaveBeenCalled();
  });

  it("says when a failed write couldn't be undone, and requires Reload", async () => {
    const picked = await backupWith((s) => {
      drafts(s).set(draftKey(conn, "default", "c"), "From the backup");
      drafts(s).set(draftKey(conn, "default", "d"), "Also from the backup");
    });
    // One write: the draft here, then the store is full.
    const t = setUp({ picks: [picked], storage: store(1) });
    drafts(t.storage).set(draftKey(conn, "default", "mine"), "Mine");
    render(<RestoreDialog wiring={t.wiring} onClose={t.onClose} />);
    await userEvent.click(await screen.findByRole("button", { name: "Choose backup…" }));
    const what = await screen.findByRole("table", { name: "What is restored" });
    await userEvent.selectOptions(within(within(what).getByText("Drafts").closest("tr")!).getByRole("combobox"), "replace");
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Drafts couldn't be put back fully after the write failed.");
    expect(screen.getByRole("status").textContent).toContain("Nothing was restored.");
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reload Hermes Chat" }));
    expect(t.reload).toHaveBeenCalled();
  });

  it("writes nothing when the recovery backup can't be saved", async () => {
    const picked = await backupWith((s) => drafts(s).set(draftKey(conn, "default", "c"), "x"));
    const t = setUp({ picks: [picked], recovery: () => Promise.reject(new Error("No space left on device")) });
    render(<RestoreDialog wiring={t.wiring} onClose={t.onClose} />);
    await userEvent.click(await screen.findByRole("button", { name: "Choose backup…" }));
    await userEvent.click(await screen.findByRole("button", { name: "Restore" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't save a recovery backup first (No space left on device), so nothing was restored.");
    expect(t.storage.length).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(t.onClose).toHaveBeenCalled();
  });
});
