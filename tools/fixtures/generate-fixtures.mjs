import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, deflateSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE_ROOT = join(ROOT, "src", "test", "fixtures");
const MODE = process.argv.includes("--write")
  ? "write"
  : process.argv.includes("--verify")
    ? "verify"
    : null;

if (!MODE) {
  console.error("Use --write to regenerate fixtures or --verify to check them.");
  process.exit(2);
}

const FIXED_TIME = "2026-08-01T00:00:00.000Z";
const files = new Map();
const catalog = [];
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

addText("README.md", fixtureReadme());
addFrameSet(30, [0, 15, 29]);
addFrameSet(60, [0, 30, 59]);
addColorFixtures();
addMalformedFixtures();
addVersion1ProjectFixture();
addManifest();

if (MODE === "write") {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  for (const [path, content] of files) {
    const target = join(FIXTURE_ROOT, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  console.log(`Wrote ${files.size} deterministic fixture files.`);
} else {
  const failures = [];
  for (const [path, content] of files) {
    const target = join(FIXTURE_ROOT, path);
    if (!existsSync(target)) {
      failures.push(`Missing ${path}`);
      continue;
    }
    const actual = readFileSync(target);
    if (!actual.equals(Buffer.from(content))) {
      failures.push(`Changed ${path}`);
    }
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    console.error("Run npm.cmd run fixtures:generate to refresh deterministic fixtures.");
    process.exit(1);
  }
  console.log(`Verified ${files.size} deterministic fixture files.`);
}

function addFrameSet(fps, indices) {
  const frames = indices.map((sampleIndex) => {
    const timestampUs = Math.round((sampleIndex * 1_000_000) / fps);
    const path = `media/numbered-frames-${fps}fps/frame-${String(sampleIndex).padStart(4, "0")}.png`;
    const png = pngBuffer(160, 90, (x, y) => framePixel(x, y, sampleIndex, fps));
    addBinary(path, png, {
      type: "numbered-frame",
      description: `Synthetic ${fps} FPS frame ${sampleIndex} at ${timestampUs} microseconds.`,
      accessibilityText: `Frame ${sampleIndex} of a ${fps} FPS numbered-frame fixture.`,
      metadata: { fps, sampleIndex, timestampUs, width: 160, height: 90 },
    });
    return { sampleIndex, timestampUs, path, sha256: sha256(png) };
  });
  addJson(`media/numbered-frames-${fps}fps/metadata.json`, {
    fixture: `numbered-frames-${fps}fps`,
    generatedAt: FIXED_TIME,
    description: `${fps} FPS numbered frames with machine-verifiable sample indices and presentation timestamps.`,
    frameDurationUs: 1_000_000 / fps,
    frames,
  }, {
    type: "numbered-frame-metadata",
    description: `${fps} FPS numbered-frame metadata.`,
    accessibilityText: `Metadata lists each synthetic frame, sample index, timestamp, and hash.`,
  });
}

function addColorFixtures() {
  const sdrPath = "media/color/sdr-rec709-bars.png";
  const sdr = pngBuffer(256, 96, (x, y) => colorBarPixel(x, y));
  addBinary(sdrPath, sdr, {
    type: "sdr-color",
    description: "8-bit sRGB/Rec.709 color bars for static color regression checks.",
    accessibilityText: "Eight vertical SDR color bars: white, yellow, cyan, green, magenta, red, blue, and black.",
    metadata: { colorSpace: "sRGB/Rec.709", bitDepth: 8, width: 256, height: 96 },
  });
  addJson("media/color/hdr-blocking-samples.json", {
    fixture: "hdr-blocking-samples",
    generatedAt: FIXED_TIME,
    description: "Synthetic HDR metadata samples used to test explicit blocking or validated tone mapping decisions.",
    samples: [
      { name: "pq-1000-nit-white", transfer: "PQ", primaries: "bt2020", maxCLL: 1000 },
      { name: "hlg-wide-color", transfer: "HLG", primaries: "bt2020", maxCLL: null },
    ],
    expectedVersion1Behavior: "reject-or-explicitly-tone-map-before-record-creation",
  }, {
    type: "hdr-color",
    description: "Textual HDR fixture samples for unsupported HDR/10-bit boundaries.",
    accessibilityText: "JSON describes HDR transfer functions and expected blocking behavior.",
  });
}

function addMalformedFixtures() {
  addBinary("imports/not-a-png.png.fixture", Buffer.from("not a png\n", "utf8"), {
    type: "malformed-import",
    description: "File has a PNG-like name but invalid bytes.",
    accessibilityText: "Invalid import fixture with text bytes instead of an image.",
    expectedFailure: "reject-before-project-mutation",
  });
  const valid = pngBuffer(24, 24, (x, y) => [x * 7, y * 7, 80, 255]);
  addBinary("imports/truncated-png.png.fixture", valid.subarray(0, 32), {
    type: "malformed-import",
    description: "Truncated PNG signature and header.",
    accessibilityText: "Malformed image fixture that ends before complete PNG chunks.",
    expectedFailure: "reject-before-project-mutation",
  });
  addBinary("archives/absolute-path-entry.zip.fixture", zipBuffer([
    { name: "C:/escape/asset.png", data: Buffer.from("escape", "utf8") },
  ]), {
    type: "malformed-archive",
    description: "ZIP entry uses a Windows drive prefix.",
    accessibilityText: "Archive fixture for drive-prefix path rejection.",
    expectedFailure: "reject-absolute-path",
  });
  addBinary("archives/parent-traversal-entry.zip.fixture", zipBuffer([
    { name: "../escape/asset.png", data: Buffer.from("escape", "utf8") },
  ]), {
    type: "malformed-archive",
    description: "ZIP entry attempts parent-directory traversal.",
    accessibilityText: "Archive fixture for dot-dot traversal rejection.",
    expectedFailure: "reject-parent-traversal",
  });
  addBinary("archives/case-duplicate-entries.zip.fixture", zipBuffer([
    { name: "assets/aa/image.png", data: Buffer.from("one", "utf8") },
    { name: "ASSETS/AA/image.png", data: Buffer.from("two", "utf8") },
  ]), {
    type: "malformed-archive",
    description: "ZIP entries collide after case-insensitive normalization.",
    accessibilityText: "Archive fixture for case-insensitive duplicate path rejection.",
    expectedFailure: "reject-case-duplicate",
  });
  addBinary("archives/nul-name-entry.zip.fixture", zipBuffer([
    { name: "assets/good.png", data: Buffer.from("good", "utf8") },
    { name: "assets/bad\u0000name.png", data: Buffer.from("bad", "utf8") },
  ]), {
    type: "malformed-archive",
    description: "ZIP entry contains a NUL character in the name bytes.",
    accessibilityText: "Archive fixture for NUL path rejection.",
    expectedFailure: "reject-nul-path",
  });
  addBinary("archives/declared-oversize-json.zip.fixture", zipBuffer([
    {
      name: "manifest.json",
      data: Buffer.from(JSON.stringify({
        formatVersion: 2,
        declaredJsonBytes: 16 * 1024 * 1024 + 1,
      }), "utf8"),
    },
  ]), {
    type: "malformed-archive",
    description: "Archive manifest declares a JSON record over the 16 MB validation limit.",
    accessibilityText: "Archive fixture for declared JSON size limit rejection.",
    expectedFailure: "reject-json-size-limit",
  });
}

function addVersion1ProjectFixture() {
  const image = pngBuffer(320, 180, (x, y) => [
    (x * 3) % 256,
    (y * 5) % 256,
    ((x + y) * 2) % 256,
    255,
  ]);
  const thumbnail = pngBuffer(160, 90, (x, y) => [
    (x * 4) % 256,
    (y * 6) % 256,
    96,
    255,
  ]);
  const session = {
    formatVersion: 1,
    id: "fixture-session-v1-basic",
    title: "Fixture Version 1 Project",
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    activePageId: "fixture-page-1",
    pages: [
      {
        id: "fixture-page-1",
        title: "1",
        createdAt: FIXED_TIME,
        monitorName: "Synthetic QA Display",
        sourceWidth: 320,
        sourceHeight: 180,
        screenshotDataUrl: dataUrl("image/png", image),
        screenshotLayout: { left: 68, top: 112, scaleX: 2.5625, scaleY: 2.5625, angle: 0 },
        annotations: {
          objects: [
            {
              type: "Rect",
              left: 460,
              top: 210,
              width: 180,
              height: 92,
              fill: "rgba(239,68,68,0.25)",
              stroke: "#ef4444",
              strokeWidth: 4,
              data: { role: "annotation", kind: "box", id: "fixture-box-1" },
            },
            {
              type: "Textbox",
              left: 720,
              top: 250,
              width: 280,
              height: 120,
              text: "Deterministic fixture note",
              fill: "#202328",
              fontSize: 28,
              data: { role: "annotation", kind: "note", id: "fixture-note-1" },
            },
          ],
        },
        thumbnailDataUrl: dataUrl("image/png", thumbnail),
        extractedText: "Deterministic fixture note",
        backgroundColor: "#f7f7f5",
      },
    ],
  };
  const json = Buffer.from(`${JSON.stringify(session, null, 2)}\n`, "utf8");
  addBinary("projects/version1/basic-screenshot.gamebook.fixture", gzipSync(json, { mtime: 0 }), {
    type: "version1-project",
    description: "Gzip-compressed version 1 project containing one synthetic screenshot and two annotations.",
    accessibilityText: "Version 1 project fixture with one page, a rectangle annotation, and a note annotation.",
    metadata: {
      formatVersion: 1,
      pageCount: 1,
      screenshotSha256: sha256(image),
      thumbnailSha256: sha256(thumbnail),
    },
  });
  addJson("projects/version1/basic-screenshot.expected.json", {
    fixture: "basic-screenshot",
    generatedAt: FIXED_TIME,
    expected: {
      formatVersion: 1,
      pageCount: 1,
      activePageId: "fixture-page-1",
      sourceImageSha256: sha256(image),
      annotationIds: ["fixture-box-1", "fixture-note-1"],
      extractedText: "Deterministic fixture note",
    },
  }, {
    type: "version1-project-metadata",
    description: "Expected values for the basic version 1 project fixture.",
    accessibilityText: "JSON lists expected project identifiers, source hash, annotation identifiers, and extracted text.",
  });
}

function addManifest() {
  addJson("manifest.json", {
    generatedAt: FIXED_TIME,
    generator: "tools/fixtures/generate-fixtures.mjs",
    provenance: "Deterministic synthetic test data; contains no captured user or game media.",
    regeneration: "npm.cmd run fixtures:generate",
    verification: "npm.cmd run fixtures:verify",
    fixtures: catalog.sort((a, b) => a.path.localeCompare(b.path)),
  });
}

function addJson(path, value, info) {
  addText(path, `${JSON.stringify(value, null, 2)}\n`, info);
}

function addText(path, value, info) {
  addBinary(path, Buffer.from(value, "utf8"), info);
}

function addBinary(path, content, info = {}) {
  const buffer = Buffer.from(content);
  files.set(path, buffer);
  if (path !== "manifest.json") {
    catalog.push({
      path,
      sha256: sha256(buffer),
      bytes: buffer.length,
      ...info,
    });
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function dataUrl(mime, buffer) {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function fixtureReadme() {
  return `# Test Fixtures

These fixtures are generated synthetic data for automated Gamebook tests. They contain no captured gameplay, user media, personal paths, or third-party assets.

Regenerate:

\`\`\`powershell
npm.cmd run fixtures:generate
\`\`\`

Verify:

\`\`\`powershell
npm.cmd run fixtures:verify
\`\`\`

Use \`manifest.json\` for hashes, textual descriptions, expected failures, and accessibility descriptions. Fixture files use \`.fixture\` suffixes where a production extension would otherwise be ignored or tempting to open as a real user project.
`;
}

function pngBuffer(width, height, pixelAt) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixelAt(x, y);
      const offset = 1 + x * 4;
      row[offset] = r & 255;
      row[offset + 1] = g & 255;
      row[offset + 2] = b & 255;
      row[offset + 3] = a & 255;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", concatUInt32(width, height, Buffer.from([8, 6, 0, 0, 0]))),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function framePixel(x, y, sampleIndex, fps) {
  const background = [20 + fps, 36 + sampleIndex * 3, 56 + (x % 48), 255];
  const digitArea = x >= 26 && x < 134 && y >= 18 && y < 72;
  if (!digitArea) return background;
  const text = String(sampleIndex).padStart(2, "0");
  const digit = x < 80 ? Number(text[0]) : Number(text[1]);
  const localX = (x < 80 ? x - 30 : x - 84);
  const localY = y - 22;
  return sevenSegmentOn(digit, localX, localY) ? [245, 247, 248, 255] : [36, 48, 60, 255];
}

function sevenSegmentOn(digit, x, y) {
  const segments = [
    [true, true, true, true, true, true, false],
    [false, true, true, false, false, false, false],
    [true, true, false, true, true, false, true],
    [true, true, true, true, false, false, true],
    [false, true, true, false, false, true, true],
    [true, false, true, true, false, true, true],
    [true, false, true, true, true, true, true],
    [true, true, true, false, false, false, false],
    [true, true, true, true, true, true, true],
    [true, true, true, true, false, true, true],
  ][digit];
  const thick = 6;
  const width = 34;
  const height = 48;
  const boxes = [
    [thick, 0, width - thick, thick],
    [width - thick, thick, width, height / 2],
    [width - thick, height / 2, width, height - thick],
    [thick, height - thick, width - thick, height],
    [0, height / 2, thick, height - thick],
    [0, thick, thick, height / 2],
    [thick, height / 2 - thick / 2, width - thick, height / 2 + thick / 2],
  ];
  return boxes.some(([x1, y1, x2, y2], index) =>
    segments[index] && x >= x1 && x < x2 && y >= y1 && y < y2,
  );
}

function colorBarPixel(x, y) {
  const colors = [
    [235, 235, 235, 255],
    [235, 235, 16, 255],
    [16, 235, 235, 255],
    [16, 235, 16, 255],
    [235, 16, 235, 255],
    [235, 16, 16, 255],
    [16, 16, 235, 255],
    [16, 16, 16, 255],
  ];
  return colors[Math.min(7, Math.floor(x / 32))].map((value, index) =>
    index === 3 ? value : Math.max(0, Math.min(255, value - Math.floor(y / 16))),
  );
}

function zipBuffer(entries) {
  let offset = 0;
  const locals = [];
  const central = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
      name, data,
    ]);
    locals.push(local);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
      u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(central);
  return Buffer.concat([
    ...locals,
    centralDirectory,
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralDirectory.length), u32(offset), u16(0),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  return Buffer.concat([
    u32be(data.length),
    typeBuffer,
    data,
    u32be(crc32(Buffer.concat([typeBuffer, data]))),
  ]);
}

function concatUInt32(width, height, rest) {
  return Buffer.concat([u32be(width), u32be(height), rest]);
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function u32be(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
