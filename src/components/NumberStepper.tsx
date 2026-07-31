import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

interface NumberStepperProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  tooltipSide?: "top" | "bottom" | "left" | "right";
  suffix?: string;
  icon?: ReactNode;
  className?: string;
  onChange: (value: number) => void;
}

export function NumberStepper({
  value,
  min,
  max,
  step = 1,
  label,
  tooltipSide = "bottom",
  suffix,
  icon,
  className = "",
  onChange,
}: NumberStepperProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  function updateDraft(nextDraft: string) {
    setDraft(nextDraft);
    const parsed = Number(nextDraft);
    if (
      nextDraft !== "" &&
      Number.isFinite(parsed) &&
      parsed >= min &&
      parsed <= max
    ) {
      onChange(parsed);
    }
  }

  function stepBy(direction: -1 | 1) {
    const current = Number.isFinite(Number(draft)) ? Number(draft) : value;
    const next = clamp(current + direction * step, min, max);
    setDraft(String(next));
    onChange(next);
  }

  return (
    <div className={`number-stepper ${className}`.trim()}>
      {icon && <span className="number-stepper-icon" aria-hidden="true">{icon}</span>}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        data-tooltip={label}
        data-tooltip-side={tooltipSide}
        aria-label={label}
        onChange={(event) => updateDraft(event.target.value)}
        onBlur={() => setDraft(String(value))}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {suffix && <span className="number-stepper-suffix">{suffix}</span>}
      <span className="number-stepper-buttons">
        <button
          type="button"
          data-tooltip={`Increase ${label.toLowerCase()}`}
          data-tooltip-side={tooltipSide}
          aria-label={`Increase ${label.toLowerCase()}`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => stepBy(1)}
        >
          <ChevronUp />
        </button>
        <button
          type="button"
          data-tooltip={`Decrease ${label.toLowerCase()}`}
          data-tooltip-side={tooltipSide}
          aria-label={`Decrease ${label.toLowerCase()}`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => stepBy(-1)}
        >
          <ChevronDown />
        </button>
      </span>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
