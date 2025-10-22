import { assert, test } from "../src/main.ts";

test.before(() => {
  // Setup DOM for element tests
  document.body.innerHTML = '<div id="test" class="foo">Hello</div>';
});

test("equal", () => {
  assert.equal(1, 1);
  assert.equal("a", "a");
  assert.equal(null, null);
  assert.throws(() => assert.equal(1, 2));
  assert.throws(() => assert.equal("a", "b"));
});

test("deepEqual", () => {
  assert.deepEqual({ a: 1 }, { a: 1 });
  assert.deepEqual([1, 2], [1, 2]);
  assert.throws(() => assert.deepEqual({ a: 1 }, { a: 2 }));
  assert.throws(() => assert.deepEqual([1, 2], [1, 3]));
});

test("notEqual", () => {
  assert.notEqual(1, 2);
  assert.notEqual("a", "b");
  assert.throws(() => assert.notEqual(1, 1));
  assert.throws(() => assert.notEqual("a", "a"));
});

test("true", () => {
  assert.true(true);
  assert.throws(() => assert.true(false));
  assert.throws(() => assert.true(1));
});

test("false", () => {
  assert.false(false);
  assert.throws(() => assert.false(true));
  assert.throws(() => assert.false(0));
});

test("throws", () => {
  assert.throws(() => {
    throw new Error();
  });
  assert.throws(() => assert.throws(() => {}));
});

test("doesNotThrow", () => {
  assert.doesNotThrow(() => {});
  assert.throws(() =>
    assert.doesNotThrow(() => {
      throw new Error();
    })
  );
});

test("resolves", async () => {
  await assert.resolves(Promise.resolve(42));
  await assert.rejects(assert.resolves(Promise.reject(new Error())));
});

test("rejects", async () => {
  await assert.rejects(Promise.reject(new Error()));
  await assert.rejects(assert.rejects(Promise.resolve(42)));
});

test("instanceOf", () => {
  assert.instanceOf(new Date(), Date);
  assert.instanceOf([], Array);
  assert.throws(() => assert.instanceOf(1, Date));
});

test("typeOf", () => {
  assert.typeOf("string", "string");
  assert.typeOf(42, "number");
  assert.typeOf(true, "boolean");
  assert.throws(() => assert.typeOf("string", "number"));
});

test("exists", () => {
  assert.exists(0);
  assert.exists("");
  assert.exists(false);
  assert.throws(() => assert.exists(null));
  assert.throws(() => assert.exists(undefined));
});

test("undefined", () => {
  assert.undefined(undefined);
  assert.throws(() => assert.undefined(null));
  assert.throws(() => assert.undefined(0));
});

test("closeTo", () => {
  assert.closeTo(1.1, 1, 0.2);
  assert.closeTo(1, 1.1, 0.2);
  assert.throws(() => assert.closeTo(1.5, 1, 0.2));
});

test("match", () => {
  assert.match("hello", /ell/);
  assert.match("world", /^world$/);
  assert.throws(() => assert.match("hello", /xyz/));
});

test("contains", () => {
  assert.contains([1, 2, 3], 2);
  assert.contains("hello", "ell");
  assert.throws(() => assert.contains([1, 2], 3));
  assert.throws(() => assert.contains("hello", "xyz"));
});

test("excludes", () => {
  assert.excludes([1, 2, 3], 4);
  assert.excludes("hello", "xyz");
  assert.throws(() => assert.excludes([1, 2, 3], 2));
  assert.throws(() => assert.excludes("hello", "ell"));
});

test("length", () => {
  assert.length([1, 2], 2);
  assert.length("hi", 2);
  assert.throws(() => assert.length([1], 2));
  assert.throws(() => assert.length("a", 2));
});

test("elementExists", () => {
  assert.elementExists("#test");
  assert.elementExists(".foo");
  assert.throws(() => assert.elementExists("#nonexistent"));
});

test("elementAttribute", () => {
  assert.elementAttribute("#test", "id", "test");
  assert.elementAttribute("#test", "class");
  assert.throws(() => assert.elementAttribute("#test", "id", "wrong"));
  assert.throws(() => assert.elementAttribute("#test", "nonexistent"));
});

test("snapshot.html", () => {
  assert.snapshot.html("<div>Hello</div>", "<div>Hello</div>");
  assert.snapshot.html(
    document.querySelector("#test"),
    '<div id="test" class="foo">Hello</div>',
  );
  assert.throws(() =>
    assert.snapshot.html("<div>Hello</div>", "<div>World</div>")
  );
});

test.run();
