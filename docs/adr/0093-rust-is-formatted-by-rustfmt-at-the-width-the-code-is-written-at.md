# Rust is formatted by rustfmt at the width the code is written at

`ci.yml` runs `cargo fmt --check` since #307, and the check failed on every file: the code under `src-tauri` is written at the width it is read at, as the TS side is (no formatter there, long lines everywhere), and rustfmt's default width of 100 would have rewritten most of it. The numbers, from one run of `cargo fmt` per setting on the same tree:

| `max_width` | default heuristics | `use_small_heuristics = "Max"` |
| --- | --- | --- |
| 100 | 11748 insertions, 2581 deletions | 6186, 1757 |
| 120 | 8188, 1961 | 2906, 1111 |
| 140 | 5750, 1561 | 1498, 909 |
| 160 | 3950, 1258 | 934, 931 |
| 200 | 2298, 1155 | 647, 1335 |

## Decisions

- **`src-tauri/rustfmt.toml` sets `max_width = 160` and `use_small_heuristics = "Max"`.** 160 is where the code already breaks its lines (of 19354 code lines, 103 run past 160, 697 past 120); "Max" makes rustfmt use that whole width before it splits a call, a struct literal or a chain over lines, which is how the code was written. At that setting the one-time reformat moved about as many lines as it removed (30 files, 796 insertions, 846 deletions): import order, trailing commas, a struct variant per line, and the few lines past 160.
- **The reformat is one commit of its own**, so blame skips it with `--ignore-rev` and a review of a real change never carries it.

## Considered options

- **rustfmt's defaults** (100, default heuristics). Dropped: the first row of the table. Nearly every function signature and call would have been wrapped over lines, and later code would be written at a width the rest of the project doesn't use.
- **Wider still (180, 200).** Dropped: the deletions grow past the insertions there because rustfmt joins lines the author broke on purpose, and 200 is past what fits beside a diff.
- **No `cargo fmt --check`.** Dropped: #307 added the gate so that the format stops drifting; a width the code already has makes it cheap to keep.

## Consequences

- `cargo fmt` (in `src-tauri`) before a commit; CI fails on a file it would change.
- Doc comments are not wrapped by rustfmt (`wrap_comments` is off), so their width stays the author's, as before.
