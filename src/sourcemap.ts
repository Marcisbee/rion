export async function sourceMapSupport() {
  const utilsBundle = await Deno.bundle({
    entrypoints: [new URL("./sourcemap.client.ts", import.meta.url).href],
    platform: "browser",
    minify: true,
    write: false,
    format: "esm",
    codeSplitting: false,
  });

  return utilsBundle.outputFiles?.[0].text();
}
