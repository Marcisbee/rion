import path from "node:path";
import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { startBrowser } from "./browser.ts";
import { directory } from "./files.ts";
import { sourceMapSupport } from "./sourcemap.ts";

/**
 * Benchmark CLI (pp.ts)
 *
 * Provides:
 *   --ui        Run with visible browser (not headless)
 *   --watch     Re-run on file changes
 *   --includes  One or more directories to search for *.bench.ts files
 *
 * Positionals: explicit *.bench.ts files (must match pattern). Directories are NOT allowed
 * as positionals; use --includes <dir>.
 *
 * Behavior:
 *   1. Discover benchmark entrypoint files.
 *   2. Bundle them (no code splitting).
 *   3. Produce an HTML harness that:
 *        - registers modules via an import map
 *        - imports each module (each module itself invokes bench.run())
 *        - provides a <template id="frame"> used by bench.run() to spawn per-benchmark iframes.
 *   4. Launch browser via startBrowser (headless unless --ui).
 *   5. In --watch mode, re-bundle on changes.
 */

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

// Collect explicit entrypoint files (positionals) & directories (includes)
const includeDirs: string[] = (values.includes || []).map((p) =>
  path.resolve(p)
);

const entrypoints: string[] = [];

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
      throw new Error(
        `"${p}" is a directory. Use --includes "${p}" instead for discovery.`,
      );
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
  // Directory discovery fallback
  const roots = includeDirs.length ? includeDirs : [path.resolve("./bench")];

  directory(
    roots,
    (filePath) => {
      if (!/\.bench\.tsx?$/.test(filePath)) return;
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
  throw new Error("No benchmark entrypoints found");
}

function relativeFromCwd(p: string) {
  return path.relative(Deno.cwd(), path.resolve(p)).replace(/\\/g, "/");
}

// Internal bundling step (no code splitting)
async function bundle(): Promise<{ html: string }> {
  const result = await Deno.bundle({
    entrypoints,
    outputDir: path.resolve("./"),
    platform: "browser",
    minify: false,
    // sourcemap: "inline",
    write: false,
    format: "esm",
    codeSplitting: false,
  });

  if (!result.success) {
    for (const error of result.errors) {
      console.error(error.text);
    }
    throw new Error("Bundling failed");
  }

  const importEntries: string[] = [];
  const moduleNames: [string, string][] = [];

  // Map each output file to a synthetic module name.
  result.outputFiles?.forEach((file, i) => {
    const moduleName = `bench_module_${i}`;
    // The order may not match entrypoints strictly if bundler emits them differently;
    // we pair index -> entrypoint assuming stable ordering by bundler.
    moduleNames.push([entrypoints[i] ?? `unknown_${i}`, moduleName]);
    const decorated = [file.text()].join("\n");
    const encoded = encodeURIComponent(decorated);
    importEntries.push(
      `"${moduleName}": "data:application/javascript,${encoded}"`,
    );
  });

  // Build HTML harness
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <template id="frame">
      <script type="module">${await sourceMapSupport()}</script>
      <script type="importmap">
      {
        "imports": {
          ${importEntries.join(",\n          ")}
        }
      }
      </script>
      <script type="module">
        // Placeholder replaced by bench.run() orchestration for individual iframe runs.
        window.$$benchName = "__BENCH_NAME__";
        await import("__MODULE_NAME__");
      </script>
    </template>

    <meta charset="UTF-8" />
    <title>Rion Benchmarks</title>
    <script type="module">${await sourceMapSupport()}</script>
    <script type="importmap">
    {
      "imports": {
        ${importEntries.join(",\n        ")}
      }
    }
    </script>
    <script type="module">
    // Sequentially import each benchmark entrypoint module. Each module registers its benches
    // and (likely) invokes bench.run() internally (if designed that way).
    const modules = ${
    JSON.stringify(
      moduleNames.map(([ep, m]) => [relativeFromCwd(ep), m]),
    )
  };
    for (const [entry, moduleName] of modules) {
      window.$$currentModule = moduleName;
      console.log("");
      console.group(\`%c\${entry}\`, "text-decoration:underline;");
      await import(moduleName);
      console.groupEnd();
    }
    // Optional hooks used by existing infrastructure (tests may share UI logic).
    window.showReport?.();
    window.__done?.(window.__test_failing);
    </script>
  </head>
  <body></body>
</html>`;
  return { html };
}

async function runSuite(watchMode: boolean, uiMode: boolean) {
  const { html } = await bundle();
  await startBrowser(html, watchMode, { headless: !uiMode });
}

if (!values.watch) {
  await runSuite(false, values.ui);
} else {
  // Watch mode with debounced rebuild.
  const rootsToWatch = includeDirs.length
    ? includeDirs
    : [path.resolve("./bench")];

  // Initial run
  await runSuite(true, values.ui);

  console.log(
    "[bench watch] watching for changes in:",
    rootsToWatch.map(relativeFromCwd).join(", "),
  );

  const watcher = Deno.watchFs(rootsToWatch, { recursive: true });
  let pending = false;
  const debounceMs = 150;
  let lastTrigger = 0;

  for await (const event of watcher) {
    if (!event.paths.some((p) => /\.tsx?$/.test(p))) continue;
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
        "[bench watch] change detected:",
        event.paths.map(relativeFromCwd).join(", "),
      );
      try {
        await runSuite(true, values.ui);
      } catch (e) {
        console.error("[bench watch] rebuild failed:", e);
      }
    }, debounceMs);
  }
}
