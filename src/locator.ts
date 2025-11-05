// locator.ts
type TimeoutOptions = {
  timeout?: number; // ms, default 4000
  signal?: AbortSignal;
};

type TextMatcher =
  | { kind: "string"; value: string; exact: boolean }
  | { kind: "regex"; source: string; flags: string };

type Combinator = "descendant" | "child";

type Segment = {
  nodeTest: string;
  predicates: string[];
  combinator: Combinator;
  nth?: number; // 1-based index, serialized as [n]
};

const DEFAULT_TIMEOUT = 4000;

function xpathStringLiteral(text: string): string {
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"')) return `"${text}"`;
  const parts: string[] = [];
  for (const chunk of text.split(/(['"])/)) {
    if (chunk === "'") parts.push(`"'"`);
    else if (chunk === '"') parts.push(`'"'`);
    else if (chunk.length) parts.push(`'${chunk}'`);
  }
  return `concat(${parts.join(", ")})`;
}

function xpathHasClasses(classes: string[]): string[] {
  return classes.map((cls) =>
    `contains(concat(' ', normalize-space(@class), ' '), ${
      xpathStringLiteral(` ${cls} `)
    })`
  );
}

function tokenToSegment(token: string, combinator: Combinator): Segment {
  token = token.trim();
  let nodeTest = "*";
  const predicates: string[] = [];

  const idSplit = token.split("#");
  if (idSplit.length > 1) {
    token = idSplit[0];
    const idVal = idSplit[1];
    predicates.push(`@id=${xpathStringLiteral(idVal)}`);
  }

  const parts = token.split(".").filter(Boolean);
  if (parts.length > 0) {
    const first = parts[0];
    if (/^[a-zA-Z][\w:-]*$/.test(first)) {
      nodeTest = first;
      parts.shift();
    }
  }
  predicates.push(...xpathHasClasses(parts));

  return { nodeTest, predicates, combinator };
}

function cssToSegments(selector: string): Segment[] {
  const segments: Segment[] = [];
  const chunks = selector.trim().split(">").map((s) => s.trim());
  for (let i = 0; i < chunks.length; i++) {
    const tokens = chunks[i].split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const firstComb: Combinator = i === 0 ? "descendant" : "child";
    segments.push(tokenToSegment(tokens[0], firstComb));
    for (let j = 1; j < tokens.length; j++) {
      segments.push(tokenToSegment(tokens[j], "descendant"));
    }
  }
  return segments;
}

function serializeRegExp(re: RegExp): { source: string; flags: string } {
  return { source: re.source, flags: re.flags };
}

class Locator {
  private readonly root: Document | Element;
  private readonly segments: Segment[];
  private readonly textMatcher?: TextMatcher;
  private readonly callChain: string[];

  private constructor(
    root: Document | Element,
    segments: Segment[],
    textMatcher: TextMatcher | undefined,
    callChain: string[],
  ) {
    this.root = root;
    this.segments = segments;
    this.textMatcher = textMatcher;
    this.callChain = callChain;
  }

  static create(seed: string, root?: Document | Element): Locator {
    const segs = cssToSegments(seed);
    return new Locator(root ?? document, segs, undefined, [
      `locator(${JSON.stringify(seed)})`,
    ]);
  }

  hasAttribute(name: string, value: string | number | boolean): Locator {
    const val = typeof value === "string"
      ? xpathStringLiteral(value)
      : typeof value === "number"
      ? String(value)
      : value
      ? `'true'`
      : `'false'`;
    const last = this.segments[this.segments.length - 1];
    const nextLast = {
      ...last,
      predicates: [...last.predicates, `@${name}=${val}`],
    };
    return new Locator(
      this.root,
      this.segments.slice(0, -1).concat(nextLast),
      this.textMatcher,
      this.callChain.concat(
        `.hasAttribute(${JSON.stringify(name)}, ${JSON.stringify(value)})`,
      ),
    );
  }

  hasAttributePresent(name: string): Locator {
    const last = this.segments[this.segments.length - 1];
    const nextLast = { ...last, predicates: [...last.predicates, `@${name}`] };
    return new Locator(
      this.root,
      this.segments.slice(0, -1).concat(nextLast),
      this.textMatcher,
      this.callChain.concat(`.hasAttributePresent(${JSON.stringify(name)})`),
    );
  }

  /**
   * Add a raw XPath predicate fragment to the last segment.
   * Example: locator("tbody").predicate("not(tr)") -> //tbody[not(tr)]
   */
  predicate(expr: string): Locator {
    const last = this.segments[this.segments.length - 1];
    const nextLast = { ...last, predicates: [...last.predicates, expr] };
    return new Locator(
      this.root,
      this.segments.slice(0, -1).concat(nextLast),
      this.textMatcher,
      this.callChain.concat(`.predicate(${JSON.stringify(expr)})`),
    );
  }

  /**
   * Convenience for wrapping an expression in not().
   * locator("tbody").not("tr") -> //tbody[not(tr)]
   */
  not(expr: string): Locator {
    return this.predicate(`not(${expr})`);
  }

  hasText(text: string | RegExp, exact: boolean = false): Locator {
    let nextSegments = this.segments.slice();
    let tm: TextMatcher;
    if (text instanceof RegExp) {
      tm = { kind: "regex", ...serializeRegExp(text) };
    } else {
      tm = { kind: "string", value: text, exact };
      const pred = exact
        ? `normalize-space(.)=${xpathStringLiteral(text)}`
        : `contains(normalize-space(.), ${xpathStringLiteral(text)})`;
      const last = nextSegments[nextSegments.length - 1];
      const nextLast = { ...last, predicates: [...last.predicates, pred] };
      nextSegments = nextSegments.slice(0, -1).concat(nextLast);
    }
    return new Locator(
      this.root,
      nextSegments,
      tm,
      this.callChain.concat(
        `.hasText(${
          text instanceof RegExp ? String(text) : JSON.stringify(text)
        }${text instanceof RegExp ? "" : exact ? ", true" : ""})`,
      ),
    );
  }

  locate(selector: string): Locator {
    const added = cssToSegments(selector);
    if (added.length > 0) added[0] = { ...added[0], combinator: "descendant" };
    return new Locator(
      this.root,
      this.segments.concat(added),
      this.textMatcher,
      this.callChain.concat(`.locate(${JSON.stringify(selector)})`),
    );
  }

  nth(n: number): Locator {
    const last = this.segments[this.segments.length - 1];
    const nextLast = { ...last, nth: n };
    return new Locator(
      this.root,
      this.segments.slice(0, -1).concat(nextLast),
      this.textMatcher,
      this.callChain.concat(`.nth(${n})`),
    );
  }

  within(root: Element | Document): Locator {
    return new Locator(
      root,
      this.segments.slice(),
      this.textMatcher,
      this.callChain.concat(`.within(<root>)`),
    );
  }

  toChainString(): string {
    return this.callChain.join("");
  }

  toXPath(): string {
    let path = ".";
    for (const s of this.segments) {
      path += s.combinator === "child" ? `/${s.nodeTest}` : `//${s.nodeTest}`;
      if (s.predicates.length) path += `[${s.predicates.join(" and ")}]`;
      if (typeof s.nth === "number") path += `[${s.nth}]`;
    }
    return path;
  }

  private evaluateAllNow(): Element[] {
    const xpath = this.toXPath();
    const doc = this.root instanceof Document
      ? this.root
      : this.root.ownerDocument!;
    const result = doc.evaluate(
      xpath,
      this.root,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    const nodes: Element[] = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      const el = result.snapshotItem(i);
      if (el && el.nodeType === Node.ELEMENT_NODE) nodes.push(el as Element);
    }
    if (this.textMatcher && this.textMatcher.kind === "regex") {
      const re = new RegExp(this.textMatcher.source, this.textMatcher.flags);
      return nodes.filter((el) => re.test(el.textContent?.trim() ?? ""));
    }
    return nodes;
  }

  /**
   * Polls until any matches are available, then returns all matches.
   * Throws on timeout. rAF-only loop.
   */
  async getAll(opts: TimeoutOptions = {}): Promise<Element[]> {
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
    const start = performance.now();

    const tryEval = (): Element[] | null => {
      const all = this.evaluateAllNow();
      return all.length > 0 ? all : null;
    };

    const immediate = tryEval();
    if (immediate) return immediate;

    if (timeout <= 0) {
      throw new Error(
        `Elements not found for ${this.toChainString()} (timeout=0ms)`,
      );
    }

    return await new Promise<Element[]>((resolve, reject) => {
      let rafId: number | null = null;

      const abort = () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
      };

      const step = () => {
        try {
          const found = tryEval();
          if (found) {
            abort();
            resolve(found);
            return;
          }
          if (performance.now() - start >= timeout) {
            abort();
            reject(
              new Error(
                `Timeout ${timeout}ms waiting for ${this.toChainString()}`,
              ),
            );
            return;
          }
          rafId = requestAnimationFrame(step);
        } catch (err) {
          abort();
          reject(err as Error);
        }
      };

      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(new Error("Aborted"));
          return;
        }
        const onAbort = () => {
          abort();
          reject(new Error("Aborted"));
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      rafId = requestAnimationFrame(step);
    });
  }

  /**
   * Wait for exactly one element, or for nth() to target a single position.
   * rAF-only loop; readable errors.
   */
  async getOne(opts: TimeoutOptions = {}): Promise<Element> {
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
    const start = performance.now();

    const check = (): Element | null => {
      const all = this.evaluateAllNow();
      if (typeof this.segments[this.segments.length - 1].nth === "number") {
        return all.length === 1 ? all[0] : null;
      }
      if (all.length === 1) return all[0];
      if (all.length > 1) {
        throw new Error(
          `Strictness violation: ${all.length} elements matched for ${this.toChainString()}`,
        );
      }
      return null;
    };

    const immediate = check();
    if (immediate) return immediate;

    if (timeout <= 0) {
      throw new Error(
        `Element not found for ${this.toChainString()} (timeout=0ms)`,
      );
    }

    return await new Promise<Element>((resolve, reject) => {
      let rafId: number | null = null;

      const abort = () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
      };

      const step = () => {
        try {
          const found = check();
          if (found) {
            abort();
            resolve(found);
            return;
          }
          if (performance.now() - start >= timeout) {
            abort();
            reject(
              new Error(
                `Timeout ${timeout}ms waiting for ${this.toChainString()}`,
              ),
            );
            return;
          }
          rafId = requestAnimationFrame(step);
        } catch (err) {
          abort();
          reject(err as Error);
        }
      };

      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(new Error("Aborted"));
          return;
        }
        const onAbort = () => {
          abort();
          reject(new Error("Aborted"));
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      rafId = requestAnimationFrame(step);
    });
  }
}

export function locator(seed: string, root?: Document | Element): Locator {
  return Locator.create(seed, root);
}

export function interact(locator: Locator) {
  return {
    click: async () => ((await locator.getOne()) as HTMLElement).click(),
  };
}

export type { Locator };
