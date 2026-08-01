import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ViewportHarness } from "./ViewportHarness";
import "./viewportHarness.css";

if (new URLSearchParams(window.location.search).get("uiScale") === "2") {
  document.documentElement.dataset.uiScale = "2";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ViewportHarness />
  </StrictMode>,
);
