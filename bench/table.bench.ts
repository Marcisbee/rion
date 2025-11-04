import { bench } from "../src/bench.ts";
import { locator } from "../src/locator.ts";

bench("vanilla1 1k", async () => {
  await import("./table/vanilla.ts");
  await locator("h1").hasText(`VanillaJS-Lite-"keyed"`).getOne();
}, async () => {
  const create1k = await locator("button#run").getOne() as HTMLButtonElement;

  create1k.click();

  await locator("tbody > tr").nth(1000).getOne();
});

bench("vanilla2 1k", async () => {
  await import("./table/vanilla2.ts");
  await locator("h1").hasText(`Vanillajs-3-"keyed"`).getOne();
}, async () => {
  const create1k = await locator("button#run").getOne() as HTMLButtonElement;

  create1k.click();

  await locator("tbody > tr").nth(1000).getOne();
});

await bench.run();
