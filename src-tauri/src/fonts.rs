//! The font families installed on this computer, for the Appearance settings (src/ui/appearance.ts). The webview can't
//! list local fonts, so on Linux fontconfig's `fc-list` does, and on Windows GDI's font enumeration.

use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Serialize, Default)]
pub struct Fonts {
    /// Every family, sorted case-insensitively.
    pub all: Vec<String>,
    /// The fixed-width ones, for code.
    pub mono: Vec<String>,
}

/// Each family once, sorted. `fc-list` prints one family per font file, so most come many times; its hidden
/// families start with a dot.
pub fn parse_families(out: &str) -> Vec<String> {
    let unique: BTreeSet<&str> = out.lines().map(str::trim).filter(|f| !f.is_empty() && !f.starts_with('.')).collect();
    let mut families: Vec<String> = unique.into_iter().map(str::to_owned).collect();
    families.sort_by_key(|f| f.to_lowercase());
    families
}

#[cfg(unix)]
async fn fc_list(pattern: &str) -> Vec<String> {
    match tokio::process::Command::new("fc-list").args([pattern, "--format", "%{family[0]}\n"]).output().await {
        Ok(out) if out.status.success() => parse_families(&String::from_utf8_lossy(&out.stdout)),
        // No fontconfig: the settings offer only the app's own fonts.
        _ => Vec::new(),
    }
}

#[cfg(unix)]
pub async fn list() -> Fonts {
    let (all, mono) = tokio::join!(fc_list(":"), fc_list(":spacing=mono"));
    Fonts { all, mono }
}

#[cfg(windows)]
pub async fn list() -> Fonts {
    tokio::task::spawn_blocking(gdi::families).await.unwrap_or_default()
}

/// One family as GDI enumerates it: its face name, and whether its pitch is fixed.
pub struct Face {
    pub name: String,
    pub fixed_pitch: bool,
}

/// Each family once, sorted, from GDI's enumeration, which names a family once per character set. A name starting
/// with `@` is the vertical-writing form of another family, not one to pick.
pub fn from_faces(faces: &[Face]) -> Fonts {
    let names = |mono: bool| {
        let lines: Vec<&str> = faces.iter().filter(|f| !mono || f.fixed_pitch).map(|f| f.name.as_str()).filter(|n| !n.starts_with('@')).collect();
        parse_families(&lines.join("\n"))
    };
    Fonts { all: names(false), mono: names(true) }
}

#[cfg(windows)]
mod gdi {
    use super::{from_faces, Face, Fonts};
    use windows_sys::Win32::Foundation::LPARAM;
    use windows_sys::Win32::Graphics::Gdi::{EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, FIXED_PITCH, LOGFONTW, TEXTMETRICW};

    unsafe extern "system" fn collect(font: *const LOGFONTW, _: *const TEXTMETRICW, _: u32, faces: LPARAM) -> i32 {
        // SAFETY: GDI passes a valid LOGFONTW for each family, and `faces` is the Vec `families` lent for this call.
        let (font, faces) = unsafe { (&*font, &mut *(faces as *mut Vec<Face>)) };
        let len = font.lfFaceName.iter().position(|&c| c == 0).unwrap_or(font.lfFaceName.len());
        faces.push(Face { name: String::from_utf16_lossy(&font.lfFaceName[..len]), fixed_pitch: font.lfPitchAndFamily & 0x3 == FIXED_PITCH });
        1
    }

    pub fn families() -> Fonts {
        let mut faces: Vec<Face> = Vec::new();
        // Every face name in every character set.
        let query = LOGFONTW { lfCharSet: DEFAULT_CHARSET, ..Default::default() };
        // SAFETY: the screen's DC is released below, and `faces` outlives the enumeration, which is synchronous.
        unsafe {
            let dc = GetDC(std::ptr::null_mut());
            if dc.is_null() {
                return Fonts::default();
            }
            EnumFontFamiliesExW(dc, &query, Some(collect), &mut faces as *mut Vec<Face> as LPARAM, 0);
            ReleaseDC(std::ptr::null_mut(), dc);
        }
        from_faces(&faces)
    }
}

#[cfg(test)]
mod tests {
    use super::{from_faces, parse_families, Face};

    #[test]
    fn each_family_once_sorted_without_hidden_ones() {
        let out = "Noto Sans\nJetBrains Mono\n.LastResort\n\nnoto Serif\nJetBrains Mono\n  DejaVu Sans  \n";
        assert_eq!(parse_families(out), ["DejaVu Sans", "JetBrains Mono", "Noto Sans", "noto Serif"]);
    }

    #[test]
    fn gdi_faces_become_families_without_vertical_forms() {
        let face = |name: &str, fixed_pitch| Face { name: name.into(), fixed_pitch };
        let faces = [face("Segoe UI", false), face("Consolas", true), face("@MS Gothic", true), face("MS Gothic", true), face("Consolas", true), face("arial", false)];
        let fonts = from_faces(&faces);
        assert_eq!(fonts.all, ["arial", "Consolas", "MS Gothic", "Segoe UI"]);
        assert_eq!(fonts.mono, ["Consolas", "MS Gothic"]);
    }
}
