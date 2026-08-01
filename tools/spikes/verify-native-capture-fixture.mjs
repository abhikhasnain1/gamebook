import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(new URL("./native-capture-fixture.html", import.meta.url));
const source = readFileSync(fixturePath, "utf8");

const requiredFragments = [
  "<!doctype html>",
  'id="fixture"',
  "requestAnimationFrame",
  "devicePixelRatio",
  "STATE:",
  "FRAME:",
  "ELAPSED:",
  "RAF:",
  "requestFullscreen",
  "fullscreenchange",
  "#bfbf00",
  "#00bfbf",
  "#bf00bf",
];

for (const fragment of requiredFragments) {
  assert.ok(source.includes(fragment), `Fixture is missing required fragment: ${fragment}`);
}

const forbiddenPatterns = [
  /https?:\/\//i,
  /<script\s+[^>]*src\s*=/i,
  /<link\s+[^>]*href\s*=/i,
  /<iframe\b/i,
  /<object\b/i,
  /@import\b/i,
  /url\s*\(/i,
  /fetch\s*\(/i,
  /XMLHttpRequest/i,
  /WebSocket/i,
  /EventSource/i,
  /sendBeacon/i,
  /[A-Z]:\\Users\\/i,
  /OneDrive[\\/]/i,
];

for (const pattern of forbiddenPatterns) {
  assert.ok(!pattern.test(source), `Fixture contains forbidden dependency or path: ${pattern}`);
}

const inlineScripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(
  (match) => match[1],
);
assert.equal(inlineScripts.length, 1, "Fixture must contain exactly one inline script");
for (const script of inlineScripts) {
  Function(script);
}

console.log("Verified standalone native capture fixture.");
