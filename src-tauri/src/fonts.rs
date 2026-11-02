//! The font families installed on this computer, for the Appearance settings (src/ui/appearance.ts). WebKitGTK can't
//! list local fonts, so fontconfig's `fc-list` does.

use serde::Serialize;
use std::collections::BTreeSet;
use tokio::process::Command;

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

async fn fc_list(pattern: &str) -> Vec<String> {
    match Command::new("fc-list").args([pattern, "--format", "%{family[0]}\n"]).output().await {
        Ok(out) if out.status.success() => parse_families(&String::from_utf8_lossy(&out.stdout)),
        // No fontconfig: the settings offer only the app's own fonts.
        _ => Vec::new(),
    }
}

pub async fn list() -> Fonts {
    let (all, mono) = tokio::join!(fc_list(":"), fc_list(":spacing=mono"));
    Fonts { all, mono }
}

#[cfg(test)]
mod tests {
    use super::parse_families;

    #[test]
    fn each_family_once_sorted_without_hidden_ones() {
        let out = "Noto Sans\nJetBrains Mono\n.LastResort\n\nnoto Serif\nJetBrains Mono\n  DejaVu Sans  \n";
        assert_eq!(parse_families(out), ["DejaVu Sans", "JetBrains Mono", "Noto Sans", "noto Serif"]);
    }
}
