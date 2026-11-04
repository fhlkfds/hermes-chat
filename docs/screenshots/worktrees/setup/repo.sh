#!/bin/bash
# Synthetic repositories for the worktree screenshots, in /tmp/hc82/srv. Nothing here is real data.
set -eu
S=/tmp/hc82/srv; rm -rf "$S"; mkdir -p "$S"; cd "$S"
g() { git -c user.name="Sam Example" -c user.email=sam@example.com "$@"; }
git init -q --bare weather-api-origin.git
git init -q -b main weather-api; cd weather-api
printf '# weather-api\n\nForecasts for the dashboard.\n' > README.md
mkdir -p src config; printf 'export const units = "metric";\n' > src/units.ts
printf 'timeout_ms = 5000\n' > config/defaults.toml
printf '.env\nnode_modules/\nconfig/local.toml\n' > .gitignore
printf '# Ignored files a worktree needs (Hermes reads this list too)\n.env\nnode_modules/\nconfig/local.toml\nconfig/defaults.toml\n' > .worktreeinclude
g add -A; g commit -qm "Start the forecast API"
printf 'export const retries = 3;\n' > src/retry.ts; g add -A; g commit -qm "Retry slow upstream calls"
git remote add origin ../weather-api-origin.git; git push -q -u origin main
git branch feature/forecast-cache
# Ignored files the setup copies or links.
printf 'WEATHER_API_KEY=synthetic-not-a-key\n' > .env
mkdir -p node_modules/left-pad; printf 'module.exports = (s) => s;\n' > node_modules/left-pad/index.js
printf 'timeout_ms = 9000\n' > config/local.toml
# The source checkout is dirty: none of this goes into a worktree.
printf '# weather-api\n\nForecasts for the dashboard. (draft edit)\n' > README.md
printf 'notes for later\n' > scratch.md
# A second repository with no worktrees, for the empty list.
cd "$S"; git init -q -b main field-notes; cd field-notes; printf '# Field notes\n' > README.md; g add -A; g commit -qm "Start the notes"
echo ready
