import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousOrCriticalA11yIssues } from "../test/a11y";
import { MediaPlaybackControls } from "./MediaPlaybackControls";
import type { DecodedFrameRef, PlaybackState } from "./mediaPlayback";

describe("MediaPlaybackControls", () => {
  it("exposes keyboard playback, seeking, exact-frame, and poster controls", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    const onSeek = vi.fn();
    const onExactFrame = vi.fn();
    const onPoster = vi.fn();
    const { container } = render(
      <MediaPlaybackControls
        placements={placements()}
        selectedId="placement-alpha"
        durationUs={983_333}
        exactFrames={frames()}
        status="Poster restored"
        onSelect={vi.fn()}
        onPlay={onPlay}
        onPause={vi.fn()}
        onSeek={onSeek}
        onExactFrame={onExactFrame}
        onPoster={onPoster}
      />,
    );

    const play = screen.getByRole("button", { name: "Play Synthetic CFR 60 alpha" });
    play.focus();
    await user.keyboard("[Enter]");
    expect(onPlay).toHaveBeenCalledWith("placement-alpha");

    const seek = screen.getByRole("slider", { name: "Source time" });
    seek.focus();
    await user.keyboard("[ArrowRight]");
    fireEvent.change(seek, { target: { value: "1000" } });
    expect(onSeek).toHaveBeenCalledWith("placement-alpha", 1_000);

    await user.click(screen.getByRole("button", { name: /next exact frame for synthetic cfr 60 alpha/i }));
    expect(onExactFrame).toHaveBeenCalledWith("placement-alpha", frames()[1]);

    await user.click(screen.getByRole("button", { name: /restore poster for synthetic cfr 60 alpha/i }));
    expect(onPoster).toHaveBeenCalledWith("placement-alpha");
    expect(screen.getByRole("status")).toHaveTextContent("Poster restored");
    expect(screen.getByText("Decoded sample").nextElementSibling).toHaveTextContent("Poster");
    await expectNoSeriousOrCriticalA11yIssues(container);
  });

  it("exposes current playback state and actionable errors", async () => {
    const playing = state("placement-alpha", "playing");
    playing.timestampUs = 500_000;
    playing.sampleIndex = 30;
    playing.callbackActive = true;
    playing.sourceActive = true;
    const failed = state("placement-beta", "error");
    failed.error = "Exact frame is unavailable";
    const onPause = vi.fn();
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(
      <MediaPlaybackControls
        placements={placements(playing, failed)}
        selectedId="placement-alpha"
        durationUs={983_333}
        exactFrames={frames()}
        status="Frame 30 selected"
        onSelect={onSelect}
        onPlay={vi.fn()}
        onPause={onPause}
        onSeek={vi.fn()}
        onExactFrame={vi.fn()}
        onPoster={vi.fn()}
      />,
    );

    expect(screen.getByText("0.500 s")).toBeVisible();
    expect(screen.getByText("30")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Pause Synthetic CFR 60 alpha" }));
    expect(onPause).toHaveBeenCalledWith("placement-alpha");

    await user.click(screen.getByRole("button", { name: /synthetic cfr 60 beta/i }));
    expect(onSelect).toHaveBeenCalledWith("placement-beta");
  });
});

function placements(
  alpha = state("placement-alpha", "poster"),
  beta = state("placement-beta", "poster"),
) {
  return [
    { id: "placement-alpha", sourceName: "Synthetic CFR 60 alpha", state: alpha },
    { id: "placement-beta", sourceName: "Synthetic CFR 60 beta", state: beta },
  ];
}

function state(id: string, mode: PlaybackState["mode"]): PlaybackState {
  return {
    id,
    evidenceId: id.replace("placement", "evidence"),
    mode,
    timestampUs: 0,
    sampleIndex: null,
    callbackActive: false,
    sourceActive: false,
    error: null,
  };
}

function frames(): DecodedFrameRef[] {
  return [0, 30, 59].map((sampleIndex) => ({
    assetToken: "a".repeat(64),
    width: 160,
    height: 90,
    timestampUs: sampleIndex === 59 ? 983_333 : Math.round(sampleIndex * 1_000_000 / 60),
    sampleIndex,
    mimeType: "image/png" as const,
  }));
}
