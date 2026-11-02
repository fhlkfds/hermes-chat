// Reading files out of a paste, and copying text out of the chat.
import type { PastedFile } from "../hermes/model";

/** The local paths in a `text/uri-list`, as file managers put copied files on the clipboard. */
export function filePaths(uriList: string): string[] {
  return uriList.split(/\r?\n/).flatMap((line) => {
    if (!line || line.startsWith("#")) return [];
    try {
      const url = new URL(line.trim());
      return url.protocol === "file:" && (!url.host || url.host === "localhost") ? [decodeURIComponent(url.pathname)] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The files in a paste: `paths` when the clipboard says where they are, otherwise `files` with their bytes (a
 * screenshot has no path, and the webview may hide a copied file's). Both are empty for a plain text paste.
 */
export function pastedFiles(data: DataTransfer): { paths: string[]; files: PastedFile[] } {
  const paths = filePaths(data.getData("text/uri-list"));
  if (paths.length) return { paths, files: [] };
  const files = Array.from(data.files, (f) => ({
    name: f.name,
    type: f.type,
    size: f.size,
    bytes: async () => new Uint8Array(await f.arrayBuffer()),
  }));
  return { paths: [], files };
}

/** Puts `text` on the clipboard; resolves to whether it got there. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older WebKitGTK builds don't have the async clipboard API.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
