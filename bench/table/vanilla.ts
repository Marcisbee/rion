document.body.innerHTML = `
<div id="main">
    <div class="container">
        <div class="jumbotron">
            <div class="row">
                <div class="col-md-6">
                    <h1>VanillaJS-Lite-"keyed"</h1>
                </div>
                <div class="col-md-6">
                    <div class="row">
                        <div class="col-sm-6 smallpad">
                            <button type="button" class="btn btn-primary btn-block" id="run">Create 1,000 rows</button>
                        </div>
                        <div class="col-sm-6 smallpad">
                            <button type="button" class="btn btn-primary btn-block" id="runlots">Create 10,000 rows</button>
                        </div>
                        <div class="col-sm-6 smallpad">
                            <button type="button" class="btn btn-primary btn-block" id="add">Append 1,000 rows</button>
                        </div>
                        <div class="col-sm-6 smallpad">
                            <button type="button" class="btn btn-primary btn-block" id="update">Update every 10th row</button>
                        </div>
                        <div class="col-sm-6 smallpad">
                            <button type="button" class="btn btn-primary btn-block" id="clear">Clear</button>
                        </div>
                        <div class="col-sm-6 smallpad">
                            <button type="button" class="btn btn-primary btn-block" id="swaprows">Swap Rows</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <table class="table table-hover table-striped test-data">
            <tbody id="tbody">
            </tbody>
        </table>
        <span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true"></span>
    </div>
</div>
<template id="trow"><tr><td class="col-md-1">?</td><td class="col-md-4"><a>?</a></td><td class="col-md-1"><a><span class="glyphicon glyphicon-remove" aria-hidden="true"></span></a></td><td class="col-md-6"></td></tr></template>
`;

const adjectives = [
  "pretty",
  "large",
  "big",
  "small",
  "tall",
  "short",
  "long",
  "handsome",
  "plain",
  "quaint",
  "clean",
  "elegant",
  "easy",
  "angry",
  "crazy",
  "helpful",
  "mushy",
  "odd",
  "unsightly",
  "adorable",
  "important",
  "inexpensive",
  "cheap",
  "expensive",
  "fancy",
];
const colours = [
  "red",
  "yellow",
  "blue",
  "green",
  "pink",
  "brown",
  "purple",
  "brown",
  "white",
  "black",
  "orange",
];
const nouns = [
  "table",
  "chair",
  "house",
  "bbq",
  "desk",
  "car",
  "pony",
  "cookie",
  "sandwich",
  "burger",
  "pizza",
  "mouse",
  "keyboard",
];

const pick = (dict) => dict[Math.round(Math.random() * 1000) % dict.length];
const label = () => `${pick(adjectives)} ${pick(colours)} ${pick(nouns)}`;
const labelOf = (r) => r.firstChild.nextSibling.firstChild.firstChild;

let ID = 1, SEL, TMPL, SIZE;
const [[TABLE], [TBODY], [TROW], BUTTONS] = "table,tbody,#trow,button"
    .split(",").map((s) => document.querySelectorAll(s)),
  ROWS = TBODY.children;

const { cloneNode, insertBefore } = Node.prototype;
const clone = (n) => cloneNode.call(n, true);
const insert = insertBefore.bind(TBODY);
const create = (count, add) => {
  if (SIZE !== count) {
    TMPL = clone(TROW.content),
      [...Array((SIZE = count) / 50 - 1)]
        .forEach(() => TMPL.appendChild(clone(TMPL.firstChild)));
  }
  !add && (clear(), TBODY.remove());
  while (count) {
    for (const r of TMPL.children) {
      (r.$id ??= r.firstChild.firstChild).nodeValue = ID++,
        (r.$label ??= labelOf(r)).nodeValue = label(),
        count--;
    }
    insert(clone(TMPL), null);
  }
  !add && TABLE.appendChild(TBODY);
};
const clear = () => (TBODY.textContent = "", SEL = null);

BUTTONS.forEach(function (b) {
  b.onclick = this[b.id];
}, {
  run() {
    create(1000);
  },
  runlots() {
    create(10000);
  },
  add() {
    create(1000, true);
  },
  clear,
  update() {
    for (let i = 0, r; r = ROWS[i]; i += 10) {
      labelOf(r).nodeValue += " !!!";
    }
  },
  swaprows() {
    const [, r1, r2] = ROWS, r998 = ROWS[998];
    r998 && (insert(r1, r998), insert(r998, r2));
  },
});

TBODY.onclick = (e) => {
  const t = e.target, n = t.tagName, r = t.closest("TR");
  e.stopPropagation();
  (n == "SPAN" || n == "A" && t.firstElementChild)
    ? r.remove()
    : n == "A" && (SEL && (SEL.className = ""), (SEL = r).className = "danger");
};
