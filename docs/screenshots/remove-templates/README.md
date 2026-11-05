# Remove the composer's Templates button

Taken on the Hermes Chat debug build under Xvfb (1280 × 820), against a throwaway Hermes dashboard with synthetic data (`setup/`). No real data.

1. `1-before.png`, `1-before-composer.png`: the composer at 0e8c7bf, with the Templates button (the page icon after the camera).
2. `2-after.png`, `2-after-composer.png`: this branch. The button is gone; the model and reasoning controls move left.

Rerun: `setup/dash.sh`, then `setup/start-app.sh <binary>` and `setup/onboard.sh`.
