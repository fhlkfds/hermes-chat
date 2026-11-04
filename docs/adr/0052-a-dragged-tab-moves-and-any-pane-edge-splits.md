# A dragged tab moves, onto any of a pane's four edges or along its strip

ADR 0046 let a chat be dragged from the chat list, or a tab from the other pane, onto a pane's tab strip, middle, right
quarter or bottom quarter. Dragging a tab from its own strip did not behave as tabs do elsewhere (#166). Tried in the
running app before this change:

- A tab dropped on its own pane's right or bottom edge split the chat area, but the tab stayed in the first pane too:
  the chat was copied, not moved.
- A tab dropped on another pane's strip, or a split pane's edge, was copied into the other pane as well.
- The left and top edges did nothing a tab could use: they counted as the middle, which for a tab of that pane only
  switched to it.
- A tab dropped along its own strip did not move; tabs could not be put in order.
- The hint over the middle, "Open in a new tab", was squeezed into a 220-pixel column at the pane's left: its class
  `tab` picked up the tab rule. It also showed for a tab over its own pane, where nothing would happen.

## Decisions

- **A tab moves; a chat from the list opens.** A dragged tab leaves the pane it was in. A chat dragged from the chat
  list opens, as before, and may be shown in both panes (ADR 0010). If the pane a tab lands in already has a tab for
  that chat, it switches to it, so no pane is left with two.
- **All four edges.** Each pane has a drop zone on each edge: the quarter of the pane nearest it, the nearest edge at
  a corner. The middle and the tab strip add a tab.
- **One pane: split and move.** On an edge of the only pane, the chat area splits that way and the chat goes into the
  new pane on that side: left and right side by side, top and bottom one above the other. If it was the pane's only tab,
  the pane it left keeps a New chat tab, as closing its last tab does (ADR 0046).
- **Two panes: beside the pane under the pointer.** There are still at most two panes. On an edge with two panes, the
  panes turn that way and the chat is shown in the pane on that side of the one it was dropped on, which is the other
  pane. The hint says it that way: "Move below this pane".
- **A pane's only tab.** Dropped on the other pane's strip or middle, the pane it leaves closes and the chat joins the
  other pane's tabs. Dropped on an edge, its whole pane moves to that side ("Move this pane down"), so nothing reloads.
  The only pane's only tab is the one-pane case above.
- **Along the strip.** A tab dropped on its own strip moves before the tab whose middle is right of the pointer, and is
  shown. A bar marks the place while dragging. A chat from the list, or a tab from the other pane, dropped on a strip
  lands at the place marked, too. Dropped where it already is, nothing changes and nothing is marked.
- **The New chat tab** can be dragged along its strip only: a pane has at most one, and its unstarted chat belongs to
  that pane.
- **A drop that changes nothing has no hint.** The hint, the mark and the drop all come from one function
  (`tabMoves.ts` `moveTab`), which returns nothing for such a drop; the pointer shows the drop is refused.
- **The keyboard way.** Every drag of a tab has one, as ADR 0046 requires:
  - Ctrl+Shift+PageUp and Ctrl+Shift+PageDown move the active pane's shown tab one place along its strip, as in a
    browser. Focus on the tab follows it.
  - A tab's menu, opened by a right-click, the Menu key or Shift+F10 on a focused tab, has Move tab left and right,
    Move to (or Merge into) the other pane, each edge of the tab's own pane with the wording its hint would use, each
    edge of the other pane ("Move this pane below the left pane", as a drop there keeps the tab in its pane and puts
    the pane on that side), and Close tab. Each item runs the same drop as the drag it stands for. Items that would do the same thing are offered
    once.
- **The source travels beside the drag data.** HTML5 drag data can be read only on drop, and the hint must know before
  then whether the drag is a tab and from which pane, or which chat a list row carries (a chat already shown there
  would change nothing, so gets no hint). Tabs add an `application/x-hermes-tab` type; the tab's pane, or the row's
  chat, is kept in a module variable, used only while the drag carries the matching type.

## Considered options

- **A copy left behind when splitting**, as before. Rejected: it is what the owner reported as wrong, and editors and
  browsers move a dragged tab.
- **Edges with two panes said by final pane name** ("Move to the bottom pane"). Rejected after trying it: on a tab in
  the bottom pane, "Move to the bottom pane" read as nothing at all, though the tab went to the other pane, which then
  became the bottom one.
- **The only pane's only tab refusing an edge.** Rejected: an editor allows it and leaves an empty group; here the New
  chat tab is that empty group.
- **Pointer-event dragging** for smoother tab reordering. Not built; ADR 0046's HTML5 drag and drop works with WebKitGTK
  and keeps list rows and tabs on one mechanism.
- **Keyboard shortcuts for the edges** (Ctrl+Alt+arrows, as an editor has). Not built: desktops often bind those keys
  to switch workspaces. The tab menu reaches every edge.

## Consequences

- A tab moved to a pane, or a pane moved to another side, keeps its pane's scroll, find bar and attachments when the
  pane is kept; only a pane closed by its last tab leaving is lost, as closing that tab would lose it.
- When the panes swap sides, React moves one pane's DOM, so the browser may reset that pane's scroll position.
- In a narrow pane, the tab strip's horizontal scrollbar sits over the lower edge of the tabs; a press there drags the
  scrollbar, not the tab. Unchanged by this ADR.
