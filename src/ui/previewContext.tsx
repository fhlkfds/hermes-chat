// How links and tool calls in the transcript open the preview pane (PreviewPane.tsx). Without a provider, as in the
// benchmark harness, a link still never navigates the app's own window.
import { createContext, useContext, type ReactNode } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { linkTarget, type PreviewTarget } from "../hermes/preview";

export const PreviewContext = createContext<((t: PreviewTarget) => void) | undefined>(undefined);

export const useOpenPreview = () => useContext(PreviewContext);

/**
 * A link in a reply or a previewed Markdown file. An http(s) link opens in the preview pane, a loopback one from the
 * Hermes server (ADR 0052); anything else does nothing, since following it would replace Hermes Chat's own window.
 * Same-page `#anchors` still scroll.
 */
export function PreviewLink({ href, children, title }: { href?: string; children?: ReactNode; title?: string }) {
  const open = useOpenPreview();
  const link = linkTarget(href, location.origin);
  const url = link && link.kind !== "elsewhere" ? link.url : undefined;
  const follow = (e: ReactMouseEvent) => {
    if (href?.startsWith("#") && e.type === "click") return;
    e.preventDefault();
    if (url && e.type === "click") open?.({ kind: "web", url });
  };
  return (
    <a
      href={href}
      title={title ?? (url ? `${url}\nOpens in the preview${link?.kind === "serverPage" ? ", from the Hermes server" : ""}` : href)}
      onClick={follow}
      onAuxClick={follow}
      rel="noreferrer"
    >
      {children}
    </a>
  );
}
