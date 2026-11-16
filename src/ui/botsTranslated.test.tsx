// @vitest-environment jsdom
// The Bots view is a converted screen (ADR 0100): every word on it, its row menu and Edit bot comes from the catalogue.
// Rendered under the pseudo-locale, which marks each catalogue string, so a literal left in stands out. Bot names,
// descriptions and message previews are data, marked translate="no". The Clone dialog it opens isn't converted yet,
// and isn't opened here. All data is synthetic.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useSyncExternalStore } from "react";
import { afterEach, beforeAll, expect, it } from "vitest";
import { BOT_CHAT_TITLE } from "../hermes/bots";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { LocaleContext } from "../i18n/locale";
import { pseudoLocale, untranslated } from "../i18n/pseudo";
import { Bots } from "./Bots";
import type { ProfilesWiring } from "./ProfileSettings";

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
});

const p = pseudoLocale();

function View({ hermes, wiring }: { hermes: Hermes; wiring: Omit<ProfilesWiring, "showTab"> }) {
  const snap = useSyncExternalStore(hermes.subscribe, hermes.getSnapshot);
  // One `load` for the view's life, as the app gives it: a new one would start its roster poll again.
  const load = useCallback(() => hermes.bots(), [hermes]);
  return (
    <LocaleContext value={p}>
      <Bots
        server="hermes.example"
        profile="default"
        connected
        last={snap.bots}
        pictures={snap.botPictures}
        load={load}
        activity={(b) => (b.profile === "scribe" ? "replying" : undefined)}
        leaving={p.profiles.leaving.reply("default")}
        onOpen={() => {}}
        onNewChat={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
        profiles={wiring}
        botEdit={{ look: (name) => hermes.botLook(name), edit: (name, edits) => hermes.editBot(name, edits) }}
        onProfileSettings={() => {}}
      />
    </LocaleContext>
  );
}

it("shows only catalogue words in the list, a row's menu, Edit bot with a field changed elsewhere, and Delete", { timeout: 30_000 }, async () => {
  const server = new FakeHermes();
  const ago = Date.now() / 1000 - 7200;
  server.otherProfiles = {
    scribe: [row("scribe-bot", 2, { title: BOT_CHAT_TITLE, hidden: true, last_active: ago })],
    ops: [row("ops-side", 3, { title: "Deploy log", last_active: ago })],
    quiet: [row("quiet-bot", 4, { title: BOT_CHAT_TITLE, hidden: true, last_active: ago })],
  };
  server.transcripts = { "scribe-bot": [{ role: "assistant", text: "Release notes drafted." }] };
  server.profileMeta = {
    scribe: { description: "Writes release notes", ui_meta: { "hermes-bots": { title: "Scribe", color: "#44aa77", pinned: true } } },
    quiet: { ui_meta: { "hermes-bots": { hidden: true } } },
  };
  server.botAvatars = { scribe: "data:image/png;base64,iVBORw0KGgo=" };
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  await hermes.sync();
  const wiring: Omit<ProfilesWiring, "showTab"> = {
    api: hermes.manageProfiles,
    clone: hermes.profileClone,
    capabilities: hermes.capabilities,
    inUse: "default",
    connected: true,
    unread: () => undefined,
    catalog: async () => [{ slug: "openai", name: "OpenAI", models: ["gpt-6.1"], caps: {} }],
    busy: () => undefined,
    lostMessages: () => 1,
    jobCount: async () => 1,
    leaving: p.profiles.leaving.reply("default"),
    switchTo: async () => true,
    local: { pending: () => undefined, note: () => {}, clear: () => {}, renamed: async () => {}, deleted: async () => {} },
    copyText: async () => {},
  };
  const user = userEvent.setup();
  render(<View hermes={hermes} wiring={wiring} />);
  const view = await screen.findByRole("dialog", { name: p.bots.title });
  await waitFor(() => expect(view.querySelectorAll(".bots-row")).toHaveLength(3));
  await user.click(within(view).getByRole("button", { name: p.bots.hidden(1) }));
  expect(view.querySelectorAll(".bots-row")).toHaveLength(4);
  expect(untranslated(document.body)).toEqual([]);

  await user.type(within(view).getByLabelText(p.bots.search), "zzz");
  expect(within(view).getByText(p.bots.noMatch("zzz"))).toBeTruthy();
  expect(untranslated(document.body)).toEqual([]);
  await user.clear(within(view).getByLabelText(p.bots.search));

  // A row in another profile asks first while something would be left behind.
  await user.click(view.querySelector<HTMLElement>('.bots-row[data-profile="ops"] .bots-open')!);
  expect(screen.getByRole("alertdialog", { name: p.bots.switchTitle("ops") })).toBeTruthy();
  expect(untranslated(document.body)).toEqual([]);
  await user.keyboard("{Escape}");

  // Default's menu says why it can't be deleted.
  await user.click(within(view).getByRole("button", { name: p.bots.moreFor("Hermes") }));
  expect(within(screen.getByRole("menu")).getByText(p.profiles.builtInKept)).toBeTruthy();
  expect(untranslated(document.body)).toEqual([]);
  await user.keyboard("{Escape}");

  await user.click(within(view).getByRole("button", { name: p.bots.moreFor("Scribe") }));
  expect(untranslated(document.body)).toEqual([]);
  await user.click(screen.getByRole("menuitem", { name: p.bots.menu.edit }));
  const edit = await screen.findByRole("dialog", { name: p.bots.editTitle("Scribe") });
  expect(untranslated(document.body)).toEqual([]);
  server.writeBotAsOtherClient("scribe", { title: "Quill", color: null });
  server.botAvatars.scribe = "data:image/png;base64,iVBORw0KGgoA";
  await user.type(within(edit).getByLabelText(p.profiles.form.botName), " II");
  await user.click(within(edit).getByRole("button", { name: p.profiles.form.colorClear }));
  await user.click(within(edit).getByRole("button", { name: p.profiles.form.pictureRemove }));
  await user.click(within(edit).getByRole("button", { name: new RegExp(p.profiles.form.save.replace(/[⟦⟧]/g, "\\$&")) }));
  expect(await within(edit).findByText(p.profiles.form.changedElsewhere("Quill"))).toBeTruthy();
  expect(within(edit).getByText(p.profiles.form.changedPicture, { exact: false })).toBeTruthy();
  expect(untranslated(document.body)).toEqual([]);
  await user.click(within(edit).getByRole("button", { name: p.common.cancel }));
  expect(untranslated(document.body)).toEqual([]);
  await user.click(screen.getByRole("button", { name: p.profiles.form.discard }));

  await user.click(within(view).getByRole("button", { name: p.bots.moreFor("Quill") }));
  await user.click(screen.getByRole("menuitem", { name: p.bots.menu.delete }));
  const del = await screen.findByRole("alertdialog");
  await waitFor(() => expect(within(del).getByText(p.profiles.del.jobsCount(1))).toBeTruthy());
  expect(untranslated(document.body)).toEqual([]);
  await user.click(within(del).getByRole("button", { name: p.common.cancel }));

  await user.click(within(view).getByRole("button", { name: p.bots.newBot }));
  await screen.findByRole("dialog", { name: p.bots.newBot });
  expect(untranslated(document.body)).toEqual([]);
  await act(async () => {});
});
