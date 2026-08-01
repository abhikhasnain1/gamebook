import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const edgePath = args.edge ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const outputPath = resolve(args.output);
const profilePath = resolve("src-tauri/target/media-rendering-performance/edge-profile");
const debuggingPort = 9333;
const pageUrl = new URL("http://127.0.0.1:1420/tools/spikes/media-rendering-performance.html");
pageUrl.searchParams.set("build", args.build);
pageUrl.searchParams.set("durationMs", String(args.durationMs));

async function main() {
  await assertFixture("src-tauri/target/media-rendering-performance/fixture-1080p60.mp4");
  await assertFixture("src-tauri/target/media-rendering-performance/fixture-1440p60.mp4");
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(profilePath, { recursive: true, force: true });

  const edge = spawn(edgePath, [
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profilePath}`,
    "--no-first-run",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1280,720",
    pageUrl.toString(),
  ], { stdio: "ignore", windowsHide: false });

  let cdp;
  try {
  const target = await waitForTarget(debuggingPort, pageUrl.pathname);
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.call("Runtime.enable");
  await waitForPage(cdp);
  const samples = [];
  samples.push({ phase: "baseline", ...(await sampleProcessTree(edge.pid)) });
  await cdp.evaluate("document.querySelector('[aria-label=\"Run rendering benchmark\"]')?.click()", false);

  let browserReport = null;
  while (!browserReport) {
    await delay(1_000);
    const phase = await cdp.evaluate("document.querySelector('[role=\"status\"]')?.textContent || 'running'");
    samples.push({ phase: String(phase), ...(await sampleProcessTree(edge.pid)) });
    browserReport = await cdp.evaluate("window.__GAMEBOOK_MEDIA_RENDERING_SPIKE__ || null");
  }
  await delay(3_000);
  samples.push({ phase: "post-cleanup", ...(await sampleProcessTree(edge.pid)) });

  const system = summarizeSystem(samples);
  const gate = evaluateGate(browserReport.sources, system.privateMemoryDeltaBytes);
  const fixtureArtifacts = await Promise.all([
    fixtureEvidence("1080p60", "src-tauri/target/media-rendering-performance/fixture-1080p60.mp4", "src-tauri/target/media-rendering-performance/fixture-1080p60.json"),
    fixtureEvidence("1440p60", "src-tauri/target/media-rendering-performance/fixture-1440p60.mp4", "src-tauri/target/media-rendering-performance/fixture-1440p60.json"),
  ]);
  const report = {
    ...browserReport,
    schema: "gamebook.media-rendering-performance.v1",
    status: gate.fabricPassed ? "passed" : "failed",
    fixtureEvidence: fixtureArtifacts,
    system,
    gate,
    collection: {
      browser: basename(edgePath),
      remoteDebuggingAddress: "loopback",
      isolatedProfile: true,
      wallClockSampling: true,
      samples: samples.length,
      durationMs: args.durationMs,
    },
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: basename(outputPath), status: report.status, gate }, null, 2)}\n`);
  } finally {
    try {
      await cdp?.call("Browser.close");
    } catch {}
    if (!edge.killed) edge.kill();
  }
}

function parseArgs(values) {
  const parsed = { durationMs: 30_000 };
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (!value) throw new Error(`${option} requires a value`);
    if (option === "--build") parsed.build = value;
    else if (option === "--output") parsed.output = value;
    else if (option === "--duration-ms") parsed.durationMs = Number(value);
    else if (option === "--edge") parsed.edge = value;
    else throw new Error(`Unknown option: ${option}`);
  }
  if (!/^[a-f0-9]{7,64}$/i.test(parsed.build ?? "")) throw new Error("--build must be a Git revision");
  if (!parsed.output) throw new Error("--output is required");
  if (!Number.isInteger(parsed.durationMs) || parsed.durationMs < 5_000 || parsed.durationMs > 30_000) {
    throw new Error("--duration-ms must be an integer from 5000 through 30000");
  }
  return parsed;
}

async function waitForTarget(port, pathname) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const target = targets.find((candidate) => candidate.type === "page" && candidate.url.includes(pathname));
      if (target) return target;
    } catch {}
    await delay(250);
  }
  throw new Error("Edge debugging target did not become available");
}

async function waitForPage(cdp) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate("document.readyState === 'complete' && Boolean(document.querySelector('[aria-label=\"Run rendering benchmark\"]'))")) return;
    await delay(250);
  }
  throw new Error("Rendering harness did not become ready");
}

async function sampleProcessTree(rootPid) {
  const script = [
    `$root=${Number(rootPid)}`,
    "$all=@($root)",
    "$rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)",
    "do{$before=$all.Count;$children=@($rows|Where-Object{$all -contains $_.ParentProcessId}|ForEach-Object{$_.ProcessId});$all=@($all+$children|Sort-Object -Unique)}while($all.Count -gt $before)",
    "$processes=@(Get-Process -Id $all -ErrorAction SilentlyContinue)",
    "$private=($processes|Measure-Object PrivateMemorySize64 -Sum).Sum",
    "$cpu=($processes|Measure-Object CPU -Sum).Sum",
    "$gpu=0.0",
    "try{$c=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop).CounterSamples;$pattern='pid_(' + (($all|ForEach-Object{[regex]::Escape([string]$_)}) -join '|') + ')_';$gpu=($c|Where-Object{$_.InstanceName -match $pattern}|Measure-Object CookedValue -Sum).Sum}catch{}",
    "[pscustomobject]@{capturedAt=(Get-Date).ToUniversalTime().ToString('o');processCount=$processes.Count;privateBytes=[int64]$private;cpuSeconds=[double]$cpu;gpuPercent=[double]$gpu}|ConvertTo-Json -Compress",
  ].join(";");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.trim());
}

function summarizeSystem(samples) {
  const baseline = samples.find((sample) => sample.phase === "baseline");
  const post = [...samples].reverse().find((sample) => sample.phase === "post-cleanup");
  const cpu = [];
  for (let index = 1; index < samples.length; index += 1) {
    const elapsed = (Date.parse(samples[index].capturedAt) - Date.parse(samples[index - 1].capturedAt)) / 1_000;
    const delta = samples[index].cpuSeconds - samples[index - 1].cpuSeconds;
    if (elapsed > 0 && delta >= 0) cpu.push(delta / elapsed / navigatorConcurrency() * 100);
  }
  const gpu = samples.map((sample) => sample.gpuPercent).filter(Number.isFinite);
  const memory = samples.map((sample) => sample.privateBytes);
  return {
    processPrivateMemoryBaselineBytes: baseline.privateBytes,
    processPrivateMemoryPeakBytes: Math.max(...memory),
    processPrivateMemoryPostCleanupBytes: post.privateBytes,
    privateMemoryDeltaBytes: post.privateBytes - baseline.privateBytes,
    cpuPercent: distribution(cpu),
    gpuPercent: distribution(gpu),
    sampleCount: samples.length,
    cleanupDelayMs: 3_000,
  };
}

function navigatorConcurrency() {
  return Number(process.env.NUMBER_OF_PROCESSORS) || 1;
}

function distribution(values) {
  if (values.length === 0) return { mean: 0, peak: 0 };
  return {
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    peak: round(Math.max(...values)),
  };
}

function evaluateGate(sources, memoryDeltaBytes) {
  const frameRatePassed = sources.length === 2 && sources.every((source) => source.renderedFps >= 55);
  const transformLatencyPassed = sources.length === 2 && sources.every((source) => source.transformLatencyMs.count >= 30 && source.transformLatencyMs.p95 < 50);
  const cleanupPassed = sources.length === 2 && sources.every((source) => Object.values(source.cleanup).every((value) => value === 0));
  const memoryPassed = memoryDeltaBytes <= 100 * 1024 * 1024;
  const fabricPassed = frameRatePassed && transformLatencyPassed && cleanupPassed && memoryPassed;
  return { fabricPassed, frameRatePassed, transformLatencyPassed, cleanupPassed, memoryPassed, fallbackEvaluationRequired: !fabricPassed };
}

async function fixtureEvidence(id, mediaPath, reportPath) {
  const media = await readFile(mediaPath);
  const fixtureReport = JSON.parse(await readFile(reportPath, "utf8"));
  return {
    id,
    width: fixtureReport.width,
    height: fixtureReport.height,
    frameRate: fixtureReport.frameRate,
    durationSeconds: fixtureReport.durationSeconds,
    submittedFrames: fixtureReport.submittedFrames,
    bytes: media.length,
    sha256: createHash("sha256").update(media).digest("hex"),
  };
}

async function assertFixture(path) {
  const bytes = await readFile(path);
  if (bytes.length < 1_000) throw new Error(`Fixture ${basename(path)} is missing or too small`);
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static connect(url) {
    return new Promise((resolveConnect, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolveConnect(new CdpClient(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed")), { once: true });
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, returnByValue = true) {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
}

await main();
