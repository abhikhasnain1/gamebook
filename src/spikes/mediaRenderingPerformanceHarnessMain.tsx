import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MediaRenderingPerformanceHarness } from "./MediaRenderingPerformanceHarness";
import "./mediaRenderingPerformance.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MediaRenderingPerformanceHarness />
  </StrictMode>,
);
