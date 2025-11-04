/**
 * Benchmark runner that executes each bench; by default inside an isolated iframe, optionally inline.
 *
 * API:
 *   bench("name", () => ({ ...optionalSetupData }), (setup) => { ...work... })
 *   bench("name", (setup) => { ...work... }) // setup omitted; setup defaults to {}
 *   await bench.run({ warmupIterations?, benchmarkDurationMs?, isolate? }); // isolate=false by default
 *
 * Each benchmark has its own setup function whose return value is passed to the bench function.
 * Benchmarks are executed after a fixed warmup phase (iterations) followed by a timed loop.
 *
 * When executed via `deno task bench` this file also acts as a CLI harness:
 *   - Discovers *.bench.ts(x) files based on positionals or --includes
 *   - Bundles them for the browser (Playwright Chromium)
 *   - Injects them; your bench files should end with `await bench.run();`
 */

// Types
export interface BenchResult {
  name: string;
  warmupIterations: number;
  benchmarkDurationMs: number;
  iterations: number;
  totalTimeMs: number;
  avgTimePerIterMs: number;
  opsPerSec: number;
}

type SetupFn = () => Promise<unknown> | unknown;
type BenchFn<Setup extends SetupFn = () => unknown> = (
  setup: Awaited<ReturnType<Setup>>,
) => Promise<void> | void;

const benchList: { name: string; setup: SetupFn; code: BenchFn }[] = [];

interface BenchRunConfig {
  warmupIterations?: number;
  benchmarkDurationMs?: number;
  isolate?: boolean; // default true; set false to run benches in-page (imported symbols available)
}

interface BenchFunction {
  <Setup extends SetupFn = () => unknown>(
    name: string,
    code: BenchFn<Setup>,
  ): void;
  <Setup extends SetupFn = () => unknown>(
    name: string,
    setup: SetupFn,
    code: BenchFn<Setup>,
  ): void;
  run: (config?: BenchRunConfig) => Promise<BenchResult[]>;
  _internal?: {
    benchList: { name: string; setup: SetupFn; code: BenchFn }[];
  };
}

export const bench: BenchFunction = Object.assign(
  (...args: unknown[]) => {
    if (
      args.length === 2 && typeof args[0] === "string" &&
      typeof args[1] === "function"
    ) {
      const [name, code] = args as [string, BenchFn];
      benchList.push({ name, setup: () => ({}), code });
    } else if (
      args.length === 3 && typeof args[0] === "string" &&
      typeof args[1] === "function" && typeof args[2] === "function"
    ) {
      const [name, setup, code] = args as [string, SetupFn, BenchFn];
      benchList.push({ name, setup, code });
    } else {
      throw new Error(
        "Invalid bench() signature. Use bench(name, code) or bench(name, setup, code).",
      );
    }
  },
  {
    async run(config: BenchRunConfig = {}): Promise<BenchResult[]> {
      if (typeof document === "undefined") {
        throw new Error(
          "bench.run() must be executed in a browser environment",
        );
      }

      const benchLocal = benchList.splice(0, benchList.length);

      if (!benchLocal.length) {
        console.warn("[bench] No benchmarks registered.");
        return [];
      }

      // Per-benchmark setup functions are stored with each bench entry.

      // Configuration
      const WARMUP_ITERATIONS = config.warmupIterations ?? 10;
      const BENCHMARK_DURATION_MS = config.benchmarkDurationMs ?? 2000;
      const ISOLATE = config.isolate ?? false;

      let iframe: HTMLIFrameElement | null = null;
      let runSingleBenchmark: (
        benchSolo: { name: string; setup: SetupFn; code: BenchFn },
      ) => Promise<BenchResult>;

      if (ISOLATE) {
        // Create one iframe reused for all isolated benchmarks
        iframe = document.createElement("iframe");
        iframe.width = "0";
        iframe.height = "0";
        iframe.style.position = "absolute";
        iframe.style.left = "-9999px";
        iframe.setAttribute("sandbox", "allow-scripts");
        document.body.appendChild(iframe);

        runSingleBenchmark = (
          benchSolo: { name: string; setup: SetupFn; code: BenchFn },
        ): Promise<BenchResult> => {
          return new Promise<BenchResult>((resolveOne, rejectOne) => {
            const srcdoc = `<!DOCTYPE html>
 <html lang="en">
   <head></head>
   <body>
     <script type="module">
       const __setupOutput = (${benchSolo.setup})();
       const __benchFn = ${benchSolo.code};
       const WARMUP_ITERATIONS = ${WARMUP_ITERATIONS};
       const BENCHMARK_DURATION_MS = ${BENCHMARK_DURATION_MS};
       (async () => {
         for (let i = 0; i < WARMUP_ITERATIONS; i++) {
           await __benchFn(__setupOutput);
         }
         let iterations = 0;
         const start = performance.now();
         while ((performance.now() - start) < BENCHMARK_DURATION_MS) {
           await __benchFn(__setupOutput);
           iterations++;
         }
         const end = performance.now();
         const totalTimeMs = end - start;
         const avgTimePerIterMs = iterations > 0 ? (totalTimeMs / iterations) : 0;
         const opsPerSec = iterations > 0 ? (iterations / (totalTimeMs / 1000)) : 0;
         window.parent.postMessage({
           type: 'BENCHMARK_RESULT',
           name: ${JSON.stringify(benchSolo.name)},
           warmupIterations: WARMUP_ITERATIONS,
           benchmarkDurationMs: BENCHMARK_DURATION_MS,
           iterations,
           totalTimeMs,
           avgTimePerIterMs,
           opsPerSec,
         }, '*');
       })().catch(err => {
         window.parent.postMessage({
           type: 'BENCHMARK_ERROR',
           name: ${JSON.stringify(benchSolo.name)},
           message: String(err && err.message || err),
         }, '*');
       });
     </script>
   </body>
 </html>`;

            const onMessage = (e: MessageEvent) => {
              if (e.source !== iframe!.contentWindow) return;
              const data = e.data;
              if (!data || typeof data !== "object") return;
              if (
                data.type === "BENCHMARK_RESULT" && data.name === benchSolo.name
              ) {
                globalThis.removeEventListener("message", onMessage);
                resolveOne({
                  name: data.name,
                  warmupIterations: data.warmupIterations,
                  benchmarkDurationMs: data.benchmarkDurationMs,
                  iterations: data.iterations,
                  totalTimeMs: data.totalTimeMs,
                  avgTimePerIterMs: data.avgTimePerIterMs,
                  opsPerSec: data.opsPerSec,
                });
              } else if (
                data.type === "BENCHMARK_ERROR" && data.name === benchSolo.name
              ) {
                globalThis.removeEventListener("message", onMessage);
                rejectOne(new Error(data.message || "Benchmark error"));
              }
            };

            globalThis.addEventListener("message", onMessage);
            iframe!.srcdoc = srcdoc;
          });
        };
      } else {
        // Non-isolated path: run benchmark functions directly in current window (imports available).
        runSingleBenchmark = async (
          benchSolo: { name: string; setup: SetupFn; code: BenchFn },
        ): Promise<BenchResult> => {
          const setupOutput = await benchSolo.setup();
          // Warmup
          for (let i = 0; i < WARMUP_ITERATIONS; i++) {
            await benchSolo.code(setupOutput);
          }
          // Timed loop
          let iterations = 0;
          const start = performance.now();
          while ((performance.now() - start) < BENCHMARK_DURATION_MS) {
            await benchSolo.code(setupOutput);
            iterations++;
          }
          const end = performance.now();
          const totalTimeMs = end - start;
          const avgTimePerIterMs = iterations > 0
            ? (totalTimeMs / iterations)
            : 0;
          const opsPerSec = iterations > 0
            ? (iterations / (totalTimeMs / 1000))
            : 0;
          return {
            name: benchSolo.name,
            warmupIterations: WARMUP_ITERATIONS,
            benchmarkDurationMs: BENCHMARK_DURATION_MS,
            iterations,
            totalTimeMs,
            avgTimePerIterMs,
            opsPerSec,
          };
        };
      }

      const results: BenchResult[] = [];
      try {
        for (const benchSolo of benchLocal) {
          console.log("%c- " + benchSolo.name, "color:gray;");
          const res = await runSingleBenchmark(benchSolo);
          results.push(res);
        }
        // Enhanced formatted & sorted output
        results.sort((a, b) => b.opsPerSec - a.opsPerSec);

        console.log("Summary (sorted by ops/sec desc):");
        // const tableData = results.map(r => ({
        //   name: r.name,
        //   opsPerSec: Math.round(r.opsPerSec),
        //   avgMs: +r.avgTimePerIterMs.toFixed(6),
        //   iterations: r.iterations,
        //   totalMs: +r.totalTimeMs.toFixed(2),
        //   warmup: r.warmupIterations,
        //   durationMs: r.benchmarkDurationMs,
        // }));
        // console.table(tableData);

        // Detailed per-benchmark breakdown (collapsed groups)
        for (const r of results) {
          const headerStyle = "font-weight:bold;";
          console.groupCollapsed(`%c${r.name}`, headerStyle);
          console.log(
            `ops/sec: ${
              Math.round(r.opsPerSec).toLocaleString()
            } | avg ms/iter: ${
              r.avgTimePerIterMs.toExponential(3)
            } | iterations: ${r.iterations.toLocaleString()}`,
          );
          // console.log(
          //   `total: ${
          //     r.totalTimeMs.toFixed(2)
          //   } ms | duration: ${r.benchmarkDurationMs} ms | warmup iters: ${r.warmupIterations}`,
          // );
          console.groupEnd();
        }
        console.log("");
      } finally {
        if (iframe) iframe.remove();
      }
      (globalThis as { __bench_last_results?: BenchResult[] })
        .__bench_last_results = results;
      // Multi-run coordination: increment run counter and only finalize when all expected runs finished.
      interface BenchGlobal {
        __bench_runs_done?: number;
        __bench_expected_runs?: number;
        __done?: (code?: number) => void;
      }
      const g = globalThis as BenchGlobal;
      g.__bench_runs_done = (g.__bench_runs_done || 0) + 1;
      if (
        typeof g.__bench_expected_runs !== "number" ||
        g.__bench_runs_done >= g.__bench_expected_runs
      ) {
        g.__done?.(0);
      }
      return results;
    },

    _internal: {
      benchList,
    },
  },
);
