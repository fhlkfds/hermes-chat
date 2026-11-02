// Search across every chat in the profile, Active and Settled, from the Ctrl+K palette, and archived chats too when the
// owner ticks the box. Ported from the prototype; the server does the searching (`Hermes.search`).
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { Found } from "../hermes/model";
import { SourceIcon, Spinner, highlight, relTime } from "./bits";

/** Typing this long without a pause sends the search. */
const PAUSE_MS = 200;

export function SearchPalette({
  onSearch,
  onPick,
  onClose,
}: {
  onSearch: (q: string, archived: boolean) => Promise<Found[]>;
  onPick: (found: Found) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  // The results and the search they answer, so a slow answer to an older one is never shown.
  const [results, setResults] = useState<{ q: string; archived: boolean; found: Found[] }>({ q: "", archived: false, found: [] });
  const [error, setError] = useState<string>();
  const [sel, setSel] = useState(0);
  const query = q.trim();

  useEffect(() => {
    setError(undefined);
    if (!query) {
      setResults({ q: "", archived, found: [] });
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      onSearch(query, archived).then(
        (found) => current && (setResults({ q: query, archived, found }), setSel(0)),
        (e) => current && setError(`Couldn't search: ${e instanceof Error ? e.message : String(e)}`),
      );
    }, PAUSE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, archived]);

  const found = results.found;
  const searching = !!query && (results.q !== query || results.archived !== archived) && !error;

  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Search chats" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          {searching ? <Spinner /> : <Search size={16} />}
          <input
            autoFocus
            placeholder="Search all chats, including Settled"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, found.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter" && found[sel]) onPick(found[sel]);
            }}
          />
          <label className="palette-option" title="Search archived chats too">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            Include archived
          </label>
          <kbd>Esc</kbd>
        </div>
        <div className="palette-results">
          {error && (
            <div className="palette-empty err" role="alert">
              {error}
            </div>
          )}
          {!error && !query && <div className="palette-empty">Search the words and titles of every chat</div>}
          {!error && query && !searching && found.length === 0 && <div className="palette-empty">No matches</div>}
          {found.map((f, i) => (
            <button
              key={f.chatId}
              className={`hit-row ${i === sel ? "sel" : ""}`}
              ref={(el) => void (i === sel && el?.scrollIntoView({ block: "nearest" }))}
              onMouseEnter={() => setSel(i)}
              onClick={() => onPick(f)}
            >
              <div className="hit-title">
                <SourceIcon source={f.source} />
                <span className="hit-name">{highlight(f.title, results.q, "hl")}</span>
                {f.archived ? <span className="badge">Archived</span> : f.settled && <span className="badge">Settled</span>}
                <span className="hit-time">{relTime(f.updatedAt)}</span>
              </div>
              <div className="hit-snippet">
                {f.snippet.map((p, j) =>
                  p.hit ? (
                    <mark key={j} className="hl">
                      {p.text}
                    </mark>
                  ) : (
                    p.text
                  ),
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
