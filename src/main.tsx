import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { restoreDraftsAfterRestart } from "./hermes/tauriUpdates";
import "./styles.css";

void restoreDraftsAfterRestart().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
