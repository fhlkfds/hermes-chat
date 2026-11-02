// @vitest-environment jsdom
// Keyboard paths through the signed-in app, driven the way the owner would drive them, against a fake Hermes. Each
// test checks what reached Hermes (answers, interrupts, deletes), not which handler ran.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const focused = () => document.activeElement;
const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const interrupts = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.interrupt");
const prompts = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit");
const deletes = (server: FakeHermes) => server.restRequests.filter((r) => r.method === "DELETE");

/** Lets Hermes's answers land and React render them. */
const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));

/** Signed in with two Active chats and the draft on screen, focus in its composer. */
async function signedIn() {
  const server = new FakeHermes();
  server.sessions = [
    row("backup", 1, { pinned: true, title: "Nightly backup" }),
    row("nas", 2, { pinned: true, title: "NAS disks", source: "telegram" }),
  ];
  server.transcripts = {
    backup: [
      { role: "user", text: "Why did the backup fail?" },
      { role: "assistant", text: "The restic repo was locked." },
    ],
    nas: [{ role: "user", text: "How full is the NAS?" }],
  };
  const hermes = await connect(server.openPipe);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await screen.findByRole("button", { name: /Nightly backup/ });
  await settle(hermes);
  return { server, hermes, user };
}

/** A new chat whose reply is running, focus in its composer. */
async function replying() {
  const s = await signedIn();
  await s.user.type(composer(), "Clean up the logs{Enter}");
  await waitFor(() => expect(prompts(s.server)).toHaveLength(1));
  const runtime = String(prompts(s.server)[0].params.session_id);
  act(() => s.server.event(runtime, "message.start"));
  await settle(s.hermes);
  return { ...s, runtime };
}

/** A reply waiting on an Approval card, focus in the composer. */
async function waiting() {
  const s = await replying();
  let id: string | undefined;
  act(() => void ({ id } = s.server.askApproval(s.runtime)));
  await screen.findByRole("button", { name: "Approve once" });
  await settle(s.hermes);
  return { ...s, approvalId: id! };
}

/** Nothing answered, the card still waiting, and the reply still running. */
async function untouched({ server, hermes }: { server: FakeHermes; hermes: Hermes }) {
  await settle(hermes);
  expect(server.responses).toEqual([]);
  expect(server.openRequests.size).toBe(1);
  expect(interrupts(server)).toEqual([]);
  expect(button("Approve once")).toBeTruthy();
}

describe("Approval card by keyboard", () => {
  it("is reached with Shift+Tab from the composer, and Enter on Approve once approves the command once", async () => {
    const s = await waiting();
    expect(focused()).toBe(composer());

    await s.user.tab({ shift: true });
    expect(focused()).toBe(button("Deny"));
    await s.user.tab({ shift: true });
    expect(focused()).toBe(button("Always allow…"));
    await s.user.tab({ shift: true });
    expect(focused()).toBe(button("Allow for this chat…"));
    await s.user.tab({ shift: true });
    expect(focused()).toBe(button("Approve once"));
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);

    expect(s.server.responses).toEqual([{ jsonrpc: "2.0", id: s.approvalId, result: { choice: "once", all: false } }]);
    expect(screen.getByText("Approved once")).toBeTruthy();
    // Focus stays on the answered card, so the owner keeps their place, and Tab carries on to the composer.
    expect(focused()?.classList.contains("approval")).toBe(true);
    await s.user.tab();
    expect(focused()).toBe(composer());
  });

  it("denies with Space on a focused Deny", async () => {
    const s = await waiting();
    await s.user.tab({ shift: true });
    await s.user.keyboard(" ");
    await settle(s.hermes);
    expect(s.server.responses.map((r) => r.result)).toEqual([{ choice: "deny", all: false }]);
    expect(screen.getByText("Denied")).toBeTruthy();
  });

  it("is never answered by Escape, and Escape doesn't stop the reply", async () => {
    const s = await waiting();
    button("Approve once").focus();
    await s.user.keyboard("{Escape}");
    await untouched(s);
    expect(focused()).toBe(button("Approve once"));
  });

  it("is never answered by bare number or letter keys, wherever focus is", async () => {
    const s = await waiting();
    button("Approve once").focus();
    await s.user.keyboard("1234yna");
    button("Deny").focus();
    await s.user.keyboard("1234yna");
    (focused() as HTMLElement).blur();
    expect(focused()).toBe(document.body);
    await s.user.keyboard("1234yna{Enter}{Escape}");
    await untouched(s);
  });

  it("is never answered by typing in the composer, Enter included", async () => {
    const s = await waiting();
    await s.user.type(composer(), "1y{Enter}");
    await untouched(s);
    expect(composer().value).toBe("1y");
    expect(prompts(s.server)).toHaveLength(1);
  });

  it("is never answered by IME composition in the composer", async () => {
    const s = await waiting();
    fireEvent.compositionStart(composer());
    fireEvent.keyDown(composer(), { key: "Enter", isComposing: true, keyCode: 229 });
    fireEvent.keyDown(composer(), { key: "1", isComposing: true, keyCode: 229 });
    fireEvent.compositionEnd(composer());
    await untouched(s);
    expect(prompts(s.server)).toHaveLength(1);
  });

  it("keeps focus on the card when Hermes stops waiting while Approve once has focus, so Enter answers nothing", async () => {
    const s = await waiting();
    button("Approve once").focus();
    act(() => s.server.cancelRequest(s.approvalId, "timeout"));
    await settle(s.hermes);

    expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();
    expect(focused()?.classList.contains("approval")).toBe(true);
    await s.user.keyboard("{Enter} 1");
    await settle(s.hermes);
    expect(s.server.responses).toEqual([]);
    expect(interrupts(s.server)).toEqual([]);
  });

  it("asks again before a broader grant: Back takes focus, and going back keeps focus on the card", async () => {
    const s = await waiting();
    button("Allow for this chat…").focus();
    await s.user.keyboard("{Enter}");
    expect(focused()).toBe(button("Back"));
    await s.user.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(focused()?.classList.contains("approval")).toBe(true);
    await untouched(s);

    button("Allow for this chat…").focus();
    await s.user.keyboard("{Enter}");
    await s.user.tab({ shift: true });
    expect(focused()).toBe(button("Yes, allow for this chat"));
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(s.server.responses.map((r) => (r.result as { choice: string }).choice)).toEqual(["session"]);
    expect(focused()?.classList.contains("approval")).toBe(true);
  });

  it("keeps Approve once focusable but inert while offline", async () => {
    const s = await waiting();
    button("Approve once").focus();
    act(() => s.server.drop());
    await waitFor(() => expect(button("Approve once").getAttribute("aria-disabled")).toBe("true"));
    expect(focused()).toBe(button("Approve once"));
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(s.server.responses).toEqual([]);
    // Nothing was even tried: a refused answer would have left an error in the chat.
    expect(screen.queryByText(/Couldn't answer Hermes/)).toBeNull();
    expect(screen.getByText("Hermes wants to run a command")).toBeTruthy();
  });
});

describe("Interrupting by keyboard", () => {
  it("never stops a running reply on Escape, from the composer or anywhere else", async () => {
    const s = await replying();
    await s.user.keyboard("{Escape}");
    (focused() as HTMLElement).blur();
    await s.user.keyboard("{Escape}");
    await settle(s.hermes);
    expect(interrupts(s.server)).toEqual([]);
    expect(button("Stop")).toBeTruthy();
  });

  it("never stops a running reply on Escape in the find bar", async () => {
    const s = await replying();
    await s.user.keyboard("{Control>}f{/Control}");
    await waitFor(() => expect(focused()).toBe(screen.getByPlaceholderText("Find in chat")));
    await s.user.keyboard("{Escape}");
    await settle(s.hermes);
    expect(screen.queryByPlaceholderText("Find in chat")).toBeNull();
    expect(interrupts(s.server)).toEqual([]);
  });

  it("stops the reply with Enter on the focused Stop button", async () => {
    const s = await replying();
    await s.user.tab(); // Attach files
    await s.user.tab();
    expect(focused()).toBe(button(/^Model:/));
    await s.user.tab();
    expect(focused()).toBe(button(/^Reasoning effort:/));
    await s.user.tab();
    expect(focused()).toBe(button("Stop"));
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(interrupts(s.server).map((r) => r.params)).toEqual([{ session_id: s.runtime }]);
  });
});

describe("Composer by keyboard", () => {
  it("doesn't send on the Enter that confirms an IME candidate, and sends on the next one", async () => {
    const s = await signedIn();
    await s.user.type(composer(), "nihao");
    fireEvent.compositionStart(composer());
    fireEvent.keyDown(composer(), { key: "Enter", isComposing: true, keyCode: 229 });
    fireEvent.compositionEnd(composer());
    await settle(s.hermes);
    expect(prompts(s.server)).toEqual([]);

    await s.user.keyboard("{Enter}");
    await waitFor(() => expect(prompts(s.server).map((r) => r.params.text)).toEqual(["nihao"]));
  });

  it("still puts a new line on Shift+Enter", async () => {
    const s = await signedIn();
    await s.user.type(composer(), "one{Shift>}{Enter}{/Shift}two");
    expect(composer().value).toBe("one\ntwo");
    expect(prompts(s.server)).toEqual([]);
  });
});

describe("Search palette by keyboard", () => {
  it("opens on Ctrl+K from the composer, and Escape closes it with focus back in the composer", async () => {
    const s = await signedIn();
    await s.user.keyboard("{Control>}k{/Control}");
    const input = screen.getByPlaceholderText("Search all chats, including Settled");
    expect(focused()).toBe(input);
    await s.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
    expect(focused()).toBe(composer());
  });

  it("closes on Ctrl+K again, with focus back where it was", async () => {
    const s = await signedIn();
    await s.user.keyboard("{Control>}k{/Control}");
    await s.user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
    expect(focused()).toBe(composer());
  });

  it("closes on Escape from a focused result too", async () => {
    const s = await signedIn();
    await s.user.keyboard("{Control>}k{/Control}");
    await s.user.keyboard("backup");
    const hit = await screen.findByRole("button", { name: /Nightly backup.*Why did the backup fail/ });
    await s.user.tab();
    expect(focused()).toBe(screen.getByRole("checkbox", { name: "Include archived" }));
    await s.user.tab();
    expect(focused()).toBe(hit);
    await s.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
    expect(focused()).toBe(composer());
  });

  it("opens the picked chat on Enter", async () => {
    const s = await signedIn();
    await s.user.keyboard("{Control>}k{/Control}");
    await s.user.keyboard("restic");
    await screen.findByRole("button", { name: /Nightly backup.*restic/ });
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
    expect(s.server.requests.filter((r) => r.method === "session.resume").map((r) => r.params.session_id)).toEqual(["backup"]);
  });

  it("never answers a waiting card while typing or pressing Enter in it", async () => {
    const s = await waiting();
    await s.user.keyboard("{Control>}k{/Control}");
    await s.user.keyboard("1{Enter}y{Enter}");
    fireEvent.keyDown(focused()!, { key: "Enter", isComposing: true, keyCode: 229 });
    await s.user.keyboard("{Escape}");
    await untouched(s);
    expect(focused()).toBe(composer());
  });
});

describe("Profile menu by keyboard", () => {
  const profileButton = () => button(/default/);

  it("opens on Enter at its filter, and Escape closes it with focus back on the profile button", async () => {
    const s = await signedIn();
    profileButton().focus();
    await s.user.keyboard("{Enter}");
    expect(focused()).toBe(screen.getByPlaceholderText("Filter profiles"));
    await s.user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Profiles" })).toBeNull();
    expect(focused()).toBe(profileButton());
  });

  it("closes on Escape from a focused option too", async () => {
    const s = await signedIn();
    profileButton().focus();
    await s.user.keyboard("{Enter}");
    await screen.findByRole("option", { name: "default" });
    await s.user.tab();
    expect(focused()).toBe(screen.getByRole("option", { name: "default" }));
    await s.user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Profiles" })).toBeNull();
    expect(focused()).toBe(profileButton());
  });

  it("never answers a waiting card while typing or pressing Enter in it", async () => {
    const s = await waiting();
    profileButton().focus();
    await s.user.keyboard("{Enter}");
    await s.user.keyboard("1{Enter}");
    await s.user.keyboard("{Escape}");
    await untouched(s);
  });
});

describe("Chat list by keyboard", () => {
  const rowButton = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) });

  it("reaches each chat with Tab, and Enter opens it", async () => {
    const s = await signedIn();
    button(/default/).focus();
    await s.user.tab();
    expect(focused()).toBe(button("Archived chats"));
    // The project switcher sits under the profile's name, before the chats.
    await s.user.tab();
    expect(focused()).toBe(button(/All chats/));
    await s.user.tab();
    expect(focused()).toBe(rowButton("Nightly backup"));
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(s.server.requests.filter((r) => r.method === "session.resume").map((r) => r.params.session_id)).toEqual(["backup"]);
    expect(rowButton("Nightly backup").getAttribute("aria-current")).toBe("true");
  });

  it("moves between chats with the arrow keys without opening them", async () => {
    const s = await signedIn();
    rowButton("Nightly backup").focus();
    await s.user.keyboard("{ArrowDown}");
    expect(focused()).toBe(rowButton("NAS disks"));
    await s.user.keyboard("{ArrowDown}");
    expect(focused()).toBe(rowButton("NAS disks"));
    await s.user.keyboard("{ArrowUp}");
    expect(focused()).toBe(rowButton("Nightly backup"));
    await settle(s.hermes);
    expect(s.server.requests.filter((r) => r.method === "session.resume")).toEqual([]);
  });

  it("reaches Settle, Archive and Delete with Tab; Escape or Cancel keeps the chat with focus back on Delete", async () => {
    const s = await signedIn();
    rowButton("Nightly backup").focus();
    await s.user.tab();
    expect(focused()).toBe(screen.getAllByRole("button", { name: "Settle" })[0]);
    await s.user.tab();
    expect(focused()).toBe(screen.getAllByRole("button", { name: /^Archive:/ })[0]);
    await s.user.tab();
    const trash = screen.getAllByRole("button", { name: "Delete" })[0];
    expect(focused()).toBe(trash);

    await s.user.keyboard("{Enter}");
    expect(focused()).toBe(button("Cancel"));
    await s.user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(focused()).toBe(screen.getAllByRole("button", { name: "Delete" })[0]);
    await settle(s.hermes);
    expect(deletes(s.server)).toEqual([]);

    await s.user.keyboard("{Enter}");
    await s.user.keyboard("{Enter}"); // on the focused Cancel
    expect(focused()).toBe(screen.getAllByRole("button", { name: "Delete" })[0]);
    await settle(s.hermes);
    expect(deletes(s.server)).toEqual([]);

    await s.user.keyboard("{Enter}");
    await s.user.tab({ shift: true });
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(deletes(s.server).map((r) => r.path)).toEqual(["/api/sessions/backup"]);
  });

  it("opens a chat's menu from the keyboard; Escape closes it, and renaming from it, with focus back on the chat", async () => {
    const s = await signedIn();
    // The Menu key or Shift+F10 fires contextmenu on the focused chat, with no pointer position.
    rowButton("Nightly backup").focus();
    fireEvent.contextMenu(rowButton("Nightly backup"));
    expect(focused()).toBe(screen.getByRole("menuitem", { name: "Rename…" }));
    await s.user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(focused()).toBe(rowButton("Nightly backup"));

    fireEvent.contextMenu(rowButton("Nightly backup"));
    await s.user.keyboard("{Enter}");
    expect(focused()).toBe(screen.getByRole("textbox", { name: "Chat title" }));
    await s.user.keyboard("Restic backup{Enter}");
    await waitFor(() => expect(focused()).toBe(rowButton("Restic backup")));
    expect(s.server.restRequests.filter((r) => r.method === "PATCH").map((r) => r.body?.title)).toEqual(["Restic backup"]);
  });
});

describe("Existing shortcuts", () => {
  it("opens find in chat on Ctrl+F from the composer", async () => {
    const s = await signedIn();
    await s.user.keyboard("{Control>}f{/Control}");
    await waitFor(() => expect(focused()).toBe(screen.getByPlaceholderText("Find in chat")));
    await s.user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText("Find in chat")).toBeNull();
  });

  it("starts a new chat on Ctrl+N and hides and shows the list on Ctrl+B", async () => {
    const s = await signedIn();
    rowButton("Nightly backup").click();
    await settle(s.hermes);
    await s.user.keyboard("{Control>}n{/Control}");
    expect(screen.getByText("New chat", { selector: ".chat-title span" })).toBeTruthy();
    await s.user.keyboard("{Control>}b{/Control}");
    expect(screen.queryByRole("button", { name: /Nightly backup/ })).toBeNull();
    await s.user.keyboard("{Control>}b{/Control}");
    expect(screen.getByRole("button", { name: /Nightly backup/ })).toBeTruthy();
  });

  it("ignores Ctrl+K while an IME is composing", async () => {
    await signedIn();
    fireEvent.keyDown(composer(), { key: "k", ctrlKey: true, isComposing: true, keyCode: 229 });
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
  });

  function rowButton(title: string) {
    return screen.getByRole("button", { name: new RegExp(`^${title}`) });
  }
});
