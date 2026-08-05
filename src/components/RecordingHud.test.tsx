import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousOrCriticalA11yIssues } from "../test/a11y";
import { RecordingHudView } from "./RecordingHud";

describe("RecordingHudView", () => {
  it("exposes time and independent media states with a named stop control", async () => {
    const onStop = vi.fn();
    render(
      <RecordingHudView
        state={{
          recordingId: "recording-alpha",
          state: "recording",
          elapsedSeconds: 3,
          remainingSeconds: 27,
          videoState: "recording",
          systemAudioState: "recording",
          microphoneState: "off",
          targetKind: "monitor-under-pointer",
        }}
        onStop={onStop}
      />,
    );

    expect(screen.getByRole("main", { name: "Recording status" })).toBeVisible();
    expect(screen.getByText("System audio").nextSibling).toHaveTextContent("Recording");
    expect(screen.getByText("Microphone").nextSibling).toHaveTextContent("Off");
    expect(screen.getByText("00:03 / 00:27")).toHaveAccessibleName(
      "00:03 elapsed; 00:27 remaining",
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
    await expectNoSeriousOrCriticalA11yIssues(document.body);
  });
});
