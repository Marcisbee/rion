/**
 * Minimal benchmark harness with 2s timed execution.
 */

type BenchSetup = () => any | Promise<any>;
type BenchCode = (setupResult: any) => void | Promise<void>;

interface BenchEntry {
  name: string;
  setup: BenchSetup;
  code: BenchCode;
}

interface BenchResultMessage {
  type: "BENCHMARK_RESULT";
  name: string;
  warmupIterations: number;
  warmupTotalTimeMs: number;
  iterations: number;
  totalTimeMs: number;
  avgTimePerIterMs: number;
  opsPerSec: number;
}

interface BenchErrorMessage {
  type: "BENCHMARK_ERROR";
  name: string;
  message: string;
}

const benchList: BenchEntry[] = [];

export function bench(name: string, setup: BenchSetup, code: BenchCode) {
  benchList.push({ name, setup, code });
}

bench.exec = async (name: string): Promise<() => Promise<void>> => {
  const entry = benchList.find((b) => b.name === name);
  if (!entry) throw new Error(`No bench found: ${name}`);
  const setupResult = await entry.setup();
  return async () => {
    await entry.code(setupResult);
  };
};

async function runSingleIframe(name: string) {
  const DURATION_MS = 2000;

  let runner: () => Promise<void>;
  try {
    runner = await bench.exec(name);
  } catch (err: any) {
    const errorMsg: BenchErrorMessage = {
      type: "BENCHMARK_ERROR",
      name,
      message: err?.message ?? String(err),
    };
    window.parent.postMessage(errorMsg, "*");
    return;
  }

  // Fixed warmup: run exactly 10 iterations (not timed)
  const warmupStart = performance.now();
  for (let w = 0; w < 10; w++) {
    await runner();
  }
  const warmupTotalTimeMs = performance.now() - warmupStart;

  // Timed benchmark phase (2s)
  let iterations = 0;
  const start = performance.now();
  while (true) {
    await runner();
    iterations++;
    const now = performance.now();
    if (now - start >= DURATION_MS) {
      const totalTimeMs = now - start;
      const avgTimePerIterMs = iterations === 0 ? 0 : totalTimeMs / iterations;
      const opsPerSec = iterations / (totalTimeMs / 1000);
      const result: BenchResultMessage = {
        type: "BENCHMARK_RESULT",
        name,
        warmupIterations: 10,
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
  iframe.width = "200";
  iframe.height = "100";
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
    // Execute each benchmark (simple gray prefix like src/bench.ts)
    for (const entry of entries) {
      console.log("%c- " + entry.name, "color:gray;");
      await runOne(entry);
    }

    // Sort results by throughput descending (ops/sec)
    results.sort((a, b) => b.opsPerSec - a.opsPerSec);

    console.log("");

    // Collapsed per-benchmark groups similar to src/bench.ts formatting
    for (const r of results) {
      const headerStyle = "font-weight:bold;";
      console.groupCollapsed(`%c${r.name}`, headerStyle);
      console.log(
        `ops/sec: ${Math.round(r.opsPerSec).toLocaleString()} | avg ms/iter: ${
          r.avgTimePerIterMs.toExponential(3)
        } | iterations: ${r.iterations.toLocaleString()}`,
      );
      // Additional raw metrics (uncomment if desired)
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
  BenchResultMessage,
  BenchSetup,
};
