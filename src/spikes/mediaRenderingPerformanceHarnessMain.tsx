import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MediaRenderingPerformanceHarness } from "./MediaRenderingPerformanceHarness";
import "./mediaRenderingPerformance.css";

const requestedScale = Number(new URLSearchParams(window.location.search).get("uiScale") ?? "1");
if (requestedScale === 1.5 || requestedScale === 2) {
  document.documentElement.dataset.uiScale = String(requestedScale);
  document.documentElement.style.setProperty("--ui-scale", String(requestedScale));
  document.documentElement.style.setProperty("--ui-scale-width", `${100 / requestedScale}%`);
  document.documentElement.style.setProperty("--ui-scale-height", `${100 / requestedScale}vh`);
  document.documentElement.style.setProperty("--ui-scale-min-width", `${900 / requestedScale}px`);
  document.documentElement.style.setProperty("--ui-scale-min-height", `${620 / requestedScale}px`);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MediaRenderingPerformanceHarness />
  </StrictMode>,
);
