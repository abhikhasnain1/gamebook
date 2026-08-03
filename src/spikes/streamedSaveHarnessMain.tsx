import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StreamedSaveHarness } from "./StreamedSaveHarness";
import "./streamedSaveHarness.css";

const requestedScale = Number(new URLSearchParams(window.location.search).get("scale") ?? "1");
if ([1, 1.5, 2].includes(requestedScale)) {
  const logicalWidth = 900 / requestedScale;
  const logicalHeight = 620 / requestedScale;
  document.documentElement.dataset.uiScale = String(requestedScale);
  document.documentElement.style.setProperty("--ui-scale", String(requestedScale));
  document.documentElement.style.setProperty("--ui-scale-width", `${logicalWidth}px`);
  document.documentElement.style.setProperty("--ui-scale-height", `${logicalHeight}px`);
  document.documentElement.style.setProperty("--ui-scale-min-width", `${logicalWidth}px`);
  document.documentElement.style.setProperty("--ui-scale-min-height", `${logicalHeight}px`);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StreamedSaveHarness />
  </StrictMode>,
);
