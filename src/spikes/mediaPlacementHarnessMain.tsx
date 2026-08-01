import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MediaPlacementHarness } from "./MediaPlacementHarness";
import "./mediaPlacementHarness.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MediaPlacementHarness />
  </StrictMode>,
);
