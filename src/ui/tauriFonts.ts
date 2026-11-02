// The installed fonts, listed by Rust through fontconfig (src-tauri/src/fonts.rs). If that fails, the Appearance
// settings offer only the app's own fonts.
import { invoke } from "@tauri-apps/api/core";
import type { Fonts } from "./appearance";

export const systemFonts = (): Promise<Fonts> => invoke<Fonts>("system_fonts").catch(() => ({ all: [], mono: [] }));
