# Model page pickers: text cut off (screenshots)

Captured on 2026-11-04 from the running Hermes Chat debug build (WebKitGTK) on an Xvfb display at 1600 × 1000 with openbox, the window maximised. Nothing was composited or retouched. The app was signed in by URL to the repo's `FakeHermes` stand-in on loopback (`docs/screenshots/settings-redesign/bridge.ts`), so the providers and models are synthetic.

The before shot is the same running app with `src/styles.css` swapped back to `main` for a moment; Vite reloaded the stylesheet in place.

- `1-before-model.png`: `main`. Provider, Model, Reasoning effort, the subagent Route and its Reasoning effort show only the bottoms of their letters.
- `2-after-model.png`: this branch. The same pickers read OpenRouter, z-ai/glm-5.3-flash, High, Inherit from main agent and Inherit.
- `3-after-model-auxiliary.png`: this branch, scrolled to Auxiliary models; those pickers were never inside a form field and are unchanged.
- `4-after-setup-provider.png`: this branch, first-run setup's Model providers step. Its bare Provider select keeps the taller padded look the setup form's rule gives it. The keyring warning is because the capture ran on a private D-Bus with no keyring.
