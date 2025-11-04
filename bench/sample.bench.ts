import { bench } from "../src/bench.ts";

function setup() {
  let fn = function (a: number = 0) {
    return a + 1;
  };
  let se = function (a: number) {/* side effect */};

  let b1: any = function (...args: any[]) {
    let ret = Reflect.apply(fn, this, args);
    for (let s of b1.se) Reflect.apply(s, this, args);
    return ret;
  };
  b1.se = [se];

  let b2 = new Proxy(fn, {
    apply(target, thisArg, args) {
      let ret = Reflect.apply(target, thisArg, args);
      Reflect.apply(se, thisArg, args);
      return ret;
    },
  });

  return { b1, b2 };
}

bench("Wrapped function", setup, ({ b1 }) => {
  b1();
});

bench("Function proxy", setup, ({ b2 }) => {
  b2();
});

await bench.run();
