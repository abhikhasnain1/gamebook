import axe, { type Result } from "axe-core";
import { expect } from "vitest";

const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

export async function expectNoSeriousOrCriticalA11yIssues(
  root: Element | Document = document,
) {
  const results = await axe.run(root);
  const blockingViolations = results.violations.filter((violation) =>
    BLOCKING_IMPACTS.has(violation.impact ?? ""),
  );

  expect(formatViolations(blockingViolations)).toEqual([]);
}

function formatViolations(violations: Result[]): string[] {
  return violations.map((violation) => {
    const targets = violation.nodes
      .flatMap((node) => node.target)
      .join(", ");
    return `${violation.id} (${violation.impact}): ${targets}`;
  });
}
