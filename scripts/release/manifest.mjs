// Stages a built AppImage and its signature under one folder with host-safe names, and writes the updater's
// `latest.json` beside them (docs/releases.md, "The manifest").
//
//   node scripts/release/manifest.mjs <bundle dir> <out dir> <base url> [notes file]
//
// <bundle dir> is where `tauri build` left `<product>_<version>_<arch>.AppImage` and its `.sig`
// (`src-tauri/target/release/bundle/appimage`). <base url> is where the staged files will be served from; the
// manifest's `url` is that plus the staged file name.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Tauri's bundle arch suffix → the updater's target arch (`tauri_plugin_updater::updater_arch`). */
const ARCHES = { amd64: "x86_64", aarch64: "aarch64", i386: "i686", armhf: "armv7" };

const NAME = /_(?<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)_(?<arch>amd64|aarch64|i386|armhf)\.AppImage$/;

/**
 * The one AppImage in `bundleDir` and what its name says. Exactly one, so a stale build can't be released by
 * mistake.
 */
export function findAppImage(bundleDir) {
  const names = readdirSync(bundleDir).filter((n) => n.endsWith(".AppImage"));
  if (names.length !== 1) {
    throw new Error(`expected one .AppImage in ${bundleDir}, found ${names.length}: ${names.join(", ") || "none"}`);
  }
  const match = NAME.exec(names[0]);
  if (!match) {
    throw new Error(`${names[0]} isn't named <product>_<version>_<arch>.AppImage`);
  }
  const { version, arch } = match.groups;
  return { file: join(bundleDir, names[0]), version, target: `linux-${ARCHES[arch]}`, staged: `hermes-chat_${version}_${arch}.AppImage` };
}

/**
 * Copies the AppImage and its `.sig` into `outDir` as `hermes-chat_<version>_<arch>.AppImage[.sig]`, writes
 * `latest.json` there, and returns the manifest. Throws if the signature is missing: a build without the key made no
 * updater artifact, and an unsigned release must never be staged.
 */
export function stage(bundleDir, outDir, baseUrl, notes, now = new Date()) {
  const appimage = findAppImage(bundleDir);
  const signature = readFileSync(`${appimage.file}.sig`, "utf8").trim();
  mkdirSync(outDir, { recursive: true });
  copyFileSync(appimage.file, join(outDir, appimage.staged));
  writeFileSync(join(outDir, `${appimage.staged}.sig`), signature);
  const manifest = {
    version: appimage.version,
    notes,
    pub_date: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: { [appimage.target]: { signature, url: `${baseUrl.replace(/\/$/, "")}/${appimage.staged}` } },
  };
  writeFileSync(join(outDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, "/"))) {
  const [bundleDir, outDir, baseUrl, notesFile] = process.argv.slice(2);
  if (!bundleDir || !outDir || !baseUrl) {
    console.error("usage: node scripts/release/manifest.mjs <bundle dir> <out dir> <base url> [notes file]");
    process.exit(2);
  }
  const notes = notesFile ? readFileSync(notesFile, "utf8").trim() : "";
  const manifest = stage(bundleDir, outDir, baseUrl, notes);
  console.log(`staged ${manifest.version} for ${Object.keys(manifest.platforms).join(", ")} in ${outDir}`);
}
