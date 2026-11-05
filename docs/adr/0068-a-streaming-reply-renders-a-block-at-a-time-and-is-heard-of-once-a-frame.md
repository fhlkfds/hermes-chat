# A streaming reply renders a block at a time, and is heard of once a frame

Issue #224: a reply with several code blocks lagged while it streamed in, and got worse with each block. Every `message.delta` gave the reply a new text, and `Markdown` parsed and highlighted all of it again. Untagged code had its language guessed again on every delta, by running every grammar over it. The `components` map was a new object on each render, so React saw a new `pre` component and rebuilt every code block's DOM, and each `CodeBlock` then rendered twice to find its language. Every delta was its own update of the whole app. The 2026-11-02 fix (2fd448d) memoized the other messages in the transcript; the cost sat in the reply still streaming.

## Decisions

- **Code blocks stay mounted.** The `components` map and the plugin lists are module constants (`src/ui/Markdown.tsx`). A code block reads its language from its `<code>` element's class, in the same render.
- **While a reply streams, it renders a top-level block at a time.** `Markdown` takes `streaming` (ChatPane passes the live reply's). From the first streamed delta, for as long as it stays mounted, the text is split into its top-level blocks (`src/ui/markdownBlocks.ts`), and each block is its own memoized part, keyed by position. A delta parses only the block that changed, which is the last one.
  - Blocks are found with the parser and GFM extensions that render them (micromark through `mdast-util-from-markdown`), never by hand. Each split carries on from the last: only the last two blocks are parsed again, since added text can make the last block part of the one before (a paragraph `2` becomes the next list item once `.` comes) but can't change how an earlier block's first line reads.
  - A block's text ends at its last line, so the blank lines that come before the next block don't change a finished one.
  - A reply that defines a link reference or footnote is rendered in one piece, since a definition can change any block.
  - Between blocks goes the `"\n"` the one-piece render puts between top-level elements, so a finished reply's HTML is the same as before. A message that never streamed renders in one piece, as before.
- **Code still coming in is plain until it is finished.** In the reply's last block, while it streams, code with nothing after it and its fence not yet closed (or indented code) isn't highlighted, and an untagged block's language isn't guessed. It is highlighted once, when its closing fence comes, when a block starts after it, or when the reply ends. It keeps the `hljs` class meanwhile, so its base colour doesn't change.
- **Highlighting is cached** by the code's classes and text (`src/ui/markdownPipeline.ts`), least recently used first out past 500,000 characters of code. Each block is highlighted on its own. A cached result is copied into the tree, so find-in-chat marks never reach the cache. This also spares highlighting again when the find query changes, and when the same chat shows in both panes.
- **The app hears of streamed deltas once a frame.** `message.delta` and `reasoning.delta` change the transport's snapshot at once, so the reply's text is always whole and in order, but listeners are called at the next animation frame. If the window draws no frames, they are called 100 ms later. Any other change is heard of at once, and takes the waiting deltas with it.

## Considered options

- **Buffering deltas in the transport and applying them a frame later**, as the issue suggested. Rejected: everything else in the transport (Stop, a completed turn, a resume, the queue) would have to flush the buffer first, or see a reply missing its latest text. Delaying only the call to listeners keeps the snapshot exact and still renders once a frame.
- **Limiting language guessing to a subset of languages.** Rejected: it would guess differently than before for finished replies. Guessing once, when the block is finished, removes the repeated cost without changing what is guessed.
- **Splitting every message into blocks, streamed or not.** Rejected: a message that never streams gains nothing from it, and opening a long chat would parse every message twice.
- **Highlighting in a Web Worker.** Not needed: with the steps above, a delta's parse and highlight work stays around a millisecond whatever the number of code blocks (PR for #224 has the numbers).

## Consequences

- A finished reply renders as before, and a test streams replies of every shape (code tagged and untagged, lists, tables, links, references, footnotes, find marks) and compares the HTML with the one-piece render.
- A streaming reply's last code block shows without colours until it is finished.
- A reply that stays on screen after streaming keeps its block-at-a-time render until the chat is opened again.
