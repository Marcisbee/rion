/**
 * Benchmark harness with beforeEach / afterEach hooks.
 *
 * New signature:
 *   bench(name, { setup, beforeEach, afterEach }, run)
 *
 * Behavior:
 *   - setup() executed once per benchmark (may return any value used by hooks & run).
 *   - For each warmup & measured iteration (iteration integer starts at 0 for warmup):
 *       beforeEach?.(setupResult, iteration)
 *       run(setupResult, iteration)
 *       afterEach?.(setupResult, iteration)
 *
 * Timing:
 *   - Warmup iterations are not part of measured stats.
 *   - beforeEach / afterEach hook time is EXCLUDED from measured timing; only the core
 *     code() execution duration is accumulated.
 *
 * Result message includes total iterations & timing stats (code time only).
 */

type BenchSetup = () => any | Promise<any>;
type BenchIterationHook = (
  setupResult: any,
  iteration: number,
) => any | Promise<any>;
type BenchCode = (setupResult: any, iteration: number) => void | Promise<void>;

interface BenchEntry {
  name: string;
  setup?: BenchSetup;
  beforeEach?: BenchIterationHook;
  afterEach?: BenchIterationHook;
  code: BenchCode;
}

interface BenchResultMessage {
  type: "BENCHMARK_RESULT";
  name: string;
  warmupIterations: number;
  warmupTotalTimeMs: number;
  iterations: number;
  totalTimeMs: number; // Accumulated code() time only
  avgTimePerIterMs: number;
  opsPerSec: number;
}

interface BenchErrorMessage {
  type: "BENCHMARK_ERROR";
  name: string;
  message: string;
}

const benchList: BenchEntry[] = [];

/**
 * Register benchmark.
 *
 * Example:
 *   bench("my bench", {
 *     setup: () => prepare(),
 *     beforeEach: (ctx, i) => reset(ctx),
 *     afterEach: (ctx, i) => verify(ctx),
 *   }, (ctx) => doWork(ctx));
 */
export function bench(
  name: string,
  hooks: {
    setup?: BenchSetup;
    beforeEach?: BenchIterationHook;
    afterEach?: BenchIterationHook;
  },
  code: BenchCode,
) {
  benchList.push({
    name,
    setup: hooks.setup,
    beforeEach: hooks.beforeEach,
    afterEach: hooks.afterEach,
    code,
  });
}

/**
 * Prepare execution context for a single benchmark (setup executed once).
 * Returns the entry and its setupResult so caller can orchestrate timing precisely.
 */
bench.exec = async (
  name: string,
): Promise<{ entry: BenchEntry; setupResult: any }> => {
  const entry = benchList.find((b) => b.name === name);
  if (!entry) throw new Error(`No bench found: ${name}`);

  let setupResult: any;
  if (entry.setup) {
    setupResult = await entry.setup();
  }

  return { entry, setupResult };
};

async function runSingleIframe(name: string) {
  // Timed duration constant kept for potential future expansion.
  const DURATION_MS = 2000;

  let execResult: { entry: BenchEntry; setupResult: any };
  try {
    execResult = await bench.exec(name);
  } catch (err: any) {
    const errorMsg: BenchErrorMessage = {
      type: "BENCHMARK_ERROR",
      name,
      message: err?.message ?? String(err),
    };
    window.parent.postMessage(errorMsg, "*");
    return;
  }
  const { entry, setupResult } = execResult;

  // Warmup phase (fixed count, not included in measured stats)
  const WARMUP_COUNT = 5;
  const warmupStart = performance.now();
  for (let w = 0; w < WARMUP_COUNT; w++) {
    // Warmup includes hooks but not part of measured totals
    if (entry.beforeEach) await entry.beforeEach(setupResult, w);
    await entry.code(setupResult, w);
    if (entry.afterEach) await entry.afterEach(setupResult, w);
  }
  const warmupTotalTimeMs = performance.now() - warmupStart;

  // Measured phase (exclude beforeEach / afterEach hook time)
  let iterations = 0;
  let measuredCodeTotalMs = 0;
  const measuredStartWall = performance.now();
  while (true) {
    const iterationNumber = WARMUP_COUNT + iterations;

    // Run beforeEach (not timed)
    if (entry.beforeEach) await entry.beforeEach(setupResult, iterationNumber);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    document.body.offsetHeight;

    const codeStart = performance.now();
    await entry.code(setupResult, iterationNumber);
    const codeEnd = performance.now();

    // Run afterEach (not timed)
    if (entry.afterEach) await entry.afterEach(setupResult, iterationNumber);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    document.body.offsetHeight;

    measuredCodeTotalMs += codeEnd - codeStart;
    iterations++;

    const now = performance.now();

    // Current logic: stop after reaching a minimum iteration threshold.
    // If desired, switch to time-based by uncommenting duration check.
    if (iterations >= 10) {
      // if (now - measuredStartWall >= DURATION_MS) {
      const totalTimeMs = measuredCodeTotalMs; // Only code time, excluding hooks
      const avgTimePerIterMs = iterations === 0 ? 0 : totalTimeMs / iterations;
      const opsPerSec = iterations / (totalTimeMs / 1000);
      const result: BenchResultMessage = {
        type: "BENCHMARK_RESULT",
        name,
        warmupIterations: WARMUP_COUNT,
        warmupTotalTimeMs,
        iterations,
        totalTimeMs,
        avgTimePerIterMs,
        opsPerSec,
      };
      window.parent.postMessage(result, "*");
      return;
    }
  }
}

async function runController() {
  const entries = benchList.splice(0, benchList.length);
  if (entries.length === 0) {
    console.warn("No benchmarks registered.");
    return;
  }

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.width = "100%";
  iframe.height = "100%";
  iframe.style.top = "0px";
  iframe.style.left = "0px";
  iframe.style.position = "absolute";
  iframe.style.border = "none";
  document.body.appendChild(iframe);

  const results: BenchResultMessage[] = [];

  const runOne = (entry: BenchEntry): Promise<void> =>
    new Promise((resolve, reject) => {
      const templateEl = document.head.querySelector("template");
      if (!templateEl) {
        reject(new Error("Missing <template> element"));
        return;
      }

      const srcdoc = templateEl.innerHTML
        .replaceAll("__MODULE_NAME__", (window as any).$$currentModule)
        .replaceAll("__BENCH_NAME__", entry.name);

      const onMessage = (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow) return;
        const data = e.data;
        if (!data || typeof data !== "object") return;

        if (data.type === "BENCHMARK_ERROR" && data.name === entry.name) {
          window.removeEventListener("message", onMessage);
          reject(new Error(data.message));
        } else if (
          data.type === "BENCHMARK_RESULT" && data.name === entry.name
        ) {
          window.removeEventListener("message", onMessage);
          results.push(data as BenchResultMessage);
          resolve();
        }
      };

      window.addEventListener("message", onMessage);
      iframe.srcdoc = srcdoc;
    });

  try {
    for (const entry of entries) {
      console.log("%c- " + entry.name, "color:gray;");
      await runOne(entry);
    }

    // Sort by throughput descending.
    results.sort((a, b) => b.opsPerSec - a.opsPerSec);

    console.log("");

    for (const r of results) {
      const headerStyle = "font-weight:bold;";
      console.groupCollapsed(`%c${r.name}`, headerStyle);
      console.log(
        `ops/sec: ${Math.round(r.opsPerSec).toLocaleString()} | avg ms/iter: ${
          r.avgTimePerIterMs.toExponential(3)
        } | iterations: ${r.iterations.toLocaleString()}`,
      );
      // Uncomment for raw metrics:
      // console.log(
      //   `total: ${r.totalTimeMs.toFixed(2)} ms | warmup iters: ${r.warmupIterations} | warmup total: ${r.warmupTotalTimeMs.toFixed(2)} ms`,
      // );
      console.groupEnd();
    }
  } catch (err) {
    console.error("Benchmark run failed:", err);
  } finally {
    iframe.remove();
  }
}

bench.run = async () => {
  const singleName = (window as any).$$benchName;
  if (singleName != null) {
    await runSingleIframe(singleName);
  } else {
    await runController();
  }
};

export type {
  BenchCode,
  BenchEntry,
  BenchErrorMessage,
  BenchIterationHook,
  BenchResultMessage,
  BenchSetup,
};
