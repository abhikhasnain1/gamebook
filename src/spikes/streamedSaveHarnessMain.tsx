import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StreamedSaveHarness } from "./StreamedSaveHarness";
import "./streamedSaveHarness.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StreamedSaveHarness />
  </StrictMode>,
);
