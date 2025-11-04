/**
 * Benchmark CLI Harness
 *
 * Separates the CLI concerns from the browser-only bench runtime (src/bench.ts).
 *
 * Usage:
 *   deno run -A --unstable-bundle src/bench.cli.ts
 *   deno run -A --unstable-bundle src/bench.cli.ts --includes bench
 *   deno run -A --unstable-bundle src/bench.cli.ts path/to/file.bench.ts other/file.bench.ts
 *
 * (With tasks in deno.json you can map: "bench": "deno run -A --unstable-bundle src/bench.cli.ts --includes bench")
 *
 * Options:
 *   --ui            Run headed (Chromium with UI) instead of headless
 *   --watch         Re-run on file changes (headed recommended)
 *   --includes DIR  Include directory while recursively discovering *.bench.ts(x)
 *
 * Bench file contract:
 *   import { bench } from "../src/bench.ts";
 *   ... register benchmarks ...
 *   await bench.run();
 *
 * If a bench file forgets calling bench.run(), the harness will attempt an auto-run after all modules load.
 */

import path from "node:path";
import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { startBrowser } from "./browser.ts";
import { directory } from "./files.ts";
import { sourceMapSupport } from "./sourcemap.ts";

declare global {
  interface GlobalThis {
    bench?: { run(): Promise<any> };
    __bench_last_results?: unknown;
    __done?: (code?: number) => void;
  }
}

// Ensure this file is treated as a module for global augmentation.
export {};

/* ----------------------------- Parse Args ------------------------------- */
const { values, positionals } = parseArgs({
  args: Deno.args,
  options: {
    ui: { type: "boolean", default: false },
    watch: { type: "boolean", default: false },
    includes: { type: "string", multiple: true },
  },
  strict: true,
  allowPositionals: true,
});

const includeDirs: string[] = (values.includes || []).map((p) =>
  path.resolve(p)
);
const entrypoints: string[] = [];

/* ----------------------- Discover Bench Entrypoints --------------------- */
/**
 * Discovery rules:
 * - If positionals are provided treat them as explicit bench files (must end with .bench.ts/.bench.tsx)
 * - Directories must be specified via --includes to be scanned recursively
 * - If no positionals and no --includes, default to current working directory
 */

if (positionals.length) {
  for (const p of positionals) {
    const abs = path.resolve(p);
    let stats;
    try {
      stats = statSync(abs);
    } catch {
      throw new Error(`Path not found: ${p}`);
    }
    if (stats.isDirectory()) {
      throw new Error(`"${p}" is a directory. Use --includes "${p}" instead.`);
    }
    if (!/\.bench\.tsx?$/.test(abs)) {
      throw new Error(`"${p}" is not a .bench.ts or .bench.tsx file`);
    }
    const relativePath = abs.replace(
      new RegExp(`^${Deno.cwd().replace(/\//g, "/")}\/`),
      "",
    );
    entrypoints.push(relativePath);
  }
} else {
  const roots = includeDirs.length ? includeDirs : [path.resolve("./")];
  directory(
    roots,
    (filePath) => {
      const relativePath = filePath.replace(
        new RegExp(`^${Deno.cwd().replace(/\//g, "/")}\/`),
        "",
      );
      entrypoints.push(relativePath);
    },
    { include: [/\.bench\.tsx?$/] },
  );
}

if (!entrypoints.length) {
  console.error("No bench entrypoints found");
  Deno.exit(1);
}

/* ------------------------------- Bundling -------------------------------- */
/**
 * We bundle all bench entrypoints (no code splitting) producing one output per entrypoint.
 * Each output is encoded as a data: URL and imported sequentially in the browser page.
 *
 * Bench code itself controls when benchmarking starts (via bench.run()).
 * We add a small fallback that calls bench.run() if user forgets.
 */
async function bundle(): Promise<{ html: string }> {
  const result = await Deno.bundle({
    entrypoints,
    outputDir: path.resolve("./"),
    platform: "browser",
    minify: false,
    sourcemap: "inline",
    write: false,
    format: "esm",
    codeSplitting: true,
  });

  console.log(result);

  if (!result.success) {
    for (const error of result.errors) {
      console.error(`[bundle error] ${error.text}`);
    }
    throw new Error("Bundling failed");
  }

  const importEntries: string[] = [];
  const moduleNames: [string, string][] = [];

  result.outputFiles?.forEach((file, i) => {
    const moduleName = `bench_module_${i}`;
    moduleNames.push([entrypoints[i], moduleName]);
    const decorated = [file.text()].join("\n");
    const encoded = encodeURIComponent(decorated);
    importEntries.push(
      `"${moduleName}": "data:application/javascript,${encoded}"`,
    );
  });

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Rion bench</title>
    <script type="module">${await sourceMapSupport()}</script>
    <script type="importmap">
    {
      "imports": {
        ${importEntries.join(",\n        ")}
      }
    }
    </script>
    <script type="module">
      const modules = ${JSON.stringify(moduleNames)};
      // Multi-run coordination: ensure multiple bench.run() calls (one per entrypoint) don't
      // terminate the browser/process early. We wrap __done so it only exits after all runs finish.
      const __originalDone = globalThis.__done;
      globalThis.__bench_expected_runs = modules.length;
      globalThis.__bench_runs_done = 0;
      globalThis.__bench_exit_code = 0;
      globalThis.__done = (code = 0) => {
        // Preserve a failing exit code if any run fails.
        if (code && globalThis.__bench_exit_code === 0) {
          globalThis.__bench_exit_code = code;
        }
        globalThis.__bench_runs_done++;
        if (globalThis.__bench_runs_done >= globalThis.__bench_expected_runs) {
          __originalDone?.(globalThis.__bench_exit_code);
        }
      };
      for (const [entry, mod] of modules) {
        console.log("");
        console.group("%c" + entry, "text-decoration:underline;");
        await import(mod);
        console.groupEnd();
        await new Promise(r => setTimeout(r, 25));
      }
      // Auto-run fallback (if user forgot to call bench.run()).
      if (!globalThis.__bench_last_results &&
          typeof globalThis.bench?.run === "function") {
        try {
          await globalThis.bench.run();
        } catch (e) {
          console.error("[bench] auto-run failed:", e);
          globalThis.__done?.(1);
        }
      }
      // If bench.run() already executed, bench.ts sets __bench_last_results & calls __done.
      // If not, the auto-run above does it.
    </script>
  </head>
  <body></body>
</html>`;
  return { html };
}

/* -------------------------- One-shot vs Watch --------------------------- */

async function runSuite() {
  const { html } = await bundle();
  await startBrowser(html, /*watch*/ values.watch, {
    headless: !values.ui,
  });
}

if (!values.watch) {
  await runSuite();
} else {
  const rootsToWatch = includeDirs.length ? includeDirs : [path.resolve("./")];
  await runSuite();
  console.log("[watch] watching for changes in:", rootsToWatch.join(", "));
  const watcher = Deno.watchFs(rootsToWatch, { recursive: true });
  let pending = false;
  const debounceMs = 150;
  let lastTrigger = 0;

  for await (const event of watcher) {
    if (!event.paths.some((p) => /\.tsx?$/.test(p))) {
      continue;
    }
    const nowTs = Date.now();
    if (pending && nowTs - lastTrigger < debounceMs) {
      lastTrigger = nowTs;
      continue;
    }
    pending = true;
    lastTrigger = nowTs;
    setTimeout(async () => {
      pending = false;
      console.clear();
      console.log(
        "[watch] change detected:",
        event.paths.map((p) => path.relative(Deno.cwd(), p)).join(", "),
      );
      try {
        await runSuite();
      } catch (e) {
        console.error("[watch] rebuild failed:", e);
      }
    }, debounceMs);
  }
}
