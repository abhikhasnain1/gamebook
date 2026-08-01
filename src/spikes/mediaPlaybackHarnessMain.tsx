import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MediaPlaybackHarness } from "./MediaPlaybackHarness";
import "./mediaPlaybackHarness.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MediaPlaybackHarness />
  </StrictMode>,
);
