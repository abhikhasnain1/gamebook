import { createRoot } from "react-dom/client";
import App from "./App";
import { RecordingHud } from "./components/RecordingHud";
import "./styles.css";

const surface = new URLSearchParams(window.location.search).get("surface");

createRoot(document.getElementById("root")!).render(
  surface === "recording-hud" ? <RecordingHud /> : <App />,
);
