import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { restoreDraftsAfterRestart } from "./hermes/tauriUpdates";
import { syncScreenshotOutbox } from "./hermes/tauriScreenshot";
import "./styles.css";

void restoreDraftsAfterRestart().then(() => {
  // Even at the sign-in screen, crash leftovers are swept with every connection's persisted outbox protected: after
  // an update's restart has put its outboxes back, so their screenshots are kept.
  void syncScreenshotOutbox().catch(() => {});
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
