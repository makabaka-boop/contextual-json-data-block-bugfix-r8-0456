import test from "node:test";
import assert from "node:assert/strict";
import * as parse5 from "parse5";
import { compileTemplates, TemplateError } from "../src/index.js";
import { serializeJsonData } from "../src/json-data.js";

const BASE = "http://localhost/app/";

const compile = (files, entry = "index.html", options = {}) =>
  compileTemplates(files, entry, {
    baseUrl: BASE,
    allowJsonData: true,
    ...options,
  });

const rejectCode = (fn, code) => {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof TemplateError);
      assert.equal(
        error.code,
        code,
        `expected ${code}, got ${error.code}: ${error.message}`,
      );
      return true;
    },
  );
};

function parseDoc(html) {
  const document = parse5.parse(html);
  const find = (node, predicate) => {
    if (predicate(node)) return node;
    for (const child of node.childNodes ?? []) {
      const found = find(child, predicate);
      if (found) return found;
    }
    return null;
  };
  const body = find(document, (node) => node.nodeName === "body");
  const allTags = (node, names = []) => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeName && !child.nodeName.startsWith("#"))
        names.push(child.nodeName);
      allTags(child, names);
    }
    return names;
  };
  const findById = (id) =>
    find(document, (node) =>
      node.attrs?.some((attr) => attr.name === "id" && attr.value === id),
    );
  const scripts = (node, out = []) => {
    if (node.nodeName === "script") out.push(node);
    for (const child of node.childNodes ?? []) scripts(child, out);
    return out;
  };
  return { document, find, body, allTags, findById, scripts };
}

const textOf = (node) =>
  node.childNodes.map((child) => child.value).join("");

test("JSON block round-trips a single whole value and keeps raw JSON (no entity escaping)", () => {
  const compiled = compile({
    "index.html":
      '<script id="d" type="application/json">{{payload}}</script>',
  });
  const payload = {
    title: 'A & B < C > D "quoted"',
    n: 12.5,
    flag: true,
    missing: null,
    list: [1, 2, 3],
  };
  const html = compiled.render({ payload });
  assert.ok(!html.includes("&amp;"), "JSON must not be HTML-entity escaped");
  const doc = parseDoc(html);
  const parsed = JSON.parse(textOf(doc.findById("d")));
  assert.deepEqual(parsed, payload);
});

test("surrounding whitespace around the single value is allowed", () => {
  const compiled = compile({
    "index.html":
      '<script type="application/json">\n  {{payload}}\n\t</script>',
  });
  const html = compiled.render({ payload: { a: 1 } });
  const doc = parseDoc(html);
  assert.deepEqual(JSON.parse(textOf(doc.scripts(doc.document)[0]).trim()), {
    a: 1,
  });
});

test("HTML closing tags and script-escape sequences in data cannot change page structure", () => {
  const compiled = compile({
    "index.html":
      '<script id="d" type="application/json">{{payload}}</script><p id="after">tail</p>',
  });
  const payload = {
    x: "</script><img src=x onerror=alert(1)>",
    y: "<!--<script><style>",
    z: "</script",
  };
  const html = compiled.render({ payload });
  assert.ok(!html.includes("</script><img"));
  const doc = parseDoc(html);
  const tags = doc.allTags(doc.document);
  assert.ok(tags.includes("script") && tags.includes("p"));
  for (const injected of ["img", "svg", "style"])
    assert.ok(!tags.includes(injected), `unexpected injected tag ${injected}`);
  assert.equal(doc.findById("after").attrs[0].value, "after");
  assert.deepEqual(JSON.parse(textOf(doc.findById("d"))), payload);
});

test("U+2028/U+2029 and angle brackets survive a JSON round trip", () => {
  const compiled = compile({
    "index.html": '<script type="application/json">{{payload}}</script>',
  });
  const payload = { line: "a b c<>", angle: "</" };
  const html = compiled.render({ payload });
  assert.ok(!html.includes(" "));
  assert.ok(!html.includes(" "));
  const doc = parseDoc(html);
  assert.deepEqual(JSON.parse(textOf(doc.scripts(doc.document)[0])), payload);
});

test("both if/else branches must provide the value; selected branch round-trips", () => {
  const compiled = compile({
    "index.html":
      '<script type="application/json">{{#if pickA}}{{a}}{{else}}{{b}}{{/if}}</script>',
  });
  const data = { a: { fromA: [1, 2] }, b: { fromB: "z</script>" } };
  for (const [pick, expected] of [
    [true, data.a],
    [false, data.b],
  ]) {
    const html = compiled.render({ ...data, pickA: pick });
    const doc = parseDoc(html);
    assert.deepEqual(JSON.parse(textOf(doc.scripts(doc.document)[0])), expected);
  }
});

test("branches that produce only part of the data are rejected at compile time", () => {
  rejectCode(
    () =>
      compile({
        "index.html":
          '<script type="application/json">{{#if a}}{{x}}{{else}}  {{/if}}</script>',
      }),
    "INCOMPATIBLE_BRANCH_CONTEXT",
  );
  rejectCode(
    () =>
      compile({
        "index.html":
          '<script type="application/json">{{#if a}}  {{else}}{{x}}{{/if}}</script>',
      }),
    "INCOMPATIBLE_BRANCH_CONTEXT",
  );
});

test("two interpolations in one block (even across separate ifs) never compile", () => {
  rejectCode(
    () =>
      compile({
        "index.html": '<script type="application/json">{{a}}{{b}}</script>',
      }),
    "JSON_BLOCK_CONTENT",
  );
  rejectCode(
    () =>
      compile({
        "index.html":
          '<script type="application/json">{{#if a}}{{x}}{{else}}{{y}}{{/if}}{{#if b}}{{m}}{{else}}{{n}}{{/if}}</script>',
      }),
    "JSON_BLOCK_CONTENT",
  );
});

test("a block with no value, literal text, or JSON fragments is rejected", () => {
  for (const source of [
    '<script type="application/json">  </script>',
    '<script type="application/json">junk {{x}}</script>',
    '<script type="application/json">{"a":{{x}}}</script>',
    '<script type="application/json">{{x}}<b></script>',
    '<script type="application/json">{{x}}</style>',
  ]) {
    rejectCode(() => compile({ "index.html": source }), "JSON_BLOCK_CONTENT");
  }
});

test("script type cannot be dynamic, duplicated, or supplied through a branch or include", () => {
  rejectCode(
    () => compile({ "index.html": '<script type="{{t}}">{{x}}</script>' }),
    "JSON_SCRIPT_TYPE",
  );
  rejectCode(
    () =>
      compile({
        "index.html":
          '<script type="application/json" type="text/javascript">{{x}}</script>',
      }),
    "JSON_SCRIPT_TYPE",
  );
  rejectCode(
    () =>
      compile({
        "index.html": '<script type="application/json" type>{{x}}</script>',
      }),
    "JSON_SCRIPT_TYPE",
  );
  rejectCode(
    () =>
      compile({
        "index.html":
          '<script type="{{#if a}}application/json{{else}}text/javascript{{/if}}">{{x}}</script>',
      }),
    "INCOMPATIBLE_BRANCH_CONTEXT",
  );
  rejectCode(
    () =>
      compile({
        "index.html": '<script type="{{#include "p.html"}}">{{x}}</script>',
        "p.html": "application/json",
      }),
    "JSON_SCRIPT_TYPE",
  );
});

test("literal type comparison tolerates case and surrounding whitespace but not parameters", () => {
  const compiled = compile({
    "index.html": '<script type="Application/JSON  ">{{x}}</script>',
  });
  const doc = parseDoc(compiled.render({ x: 1 }));
  assert.equal(JSON.parse(textOf(doc.scripts(doc.document)[0])), 1);

  rejectCode(
    () =>
      compile({
        "index.html":
          '<script type="application/json; charset=utf-8">{{x}}</script>',
      }),
    "DYNAMIC_RAW_ELEMENT",
  );
});

test("ordinary script and style regions keep rejecting dynamic content with the flag enabled", () => {
  rejectCode(() => compile({ "index.html": "<style>{{x}}</style>" }), "DYNAMIC_RAW_ELEMENT");
  rejectCode(
    () =>
      compile({
        "index.html": '<script type="text/javascript">{{x}}</script>',
      }),
    "DYNAMIC_RAW_ELEMENT",
  );
  rejectCode(
    () =>
      compile({
        "index.html":
          '<script data-x="{{x}}" type="application/json">{{y}}</script>',
      }),
    "DYNAMIC_RAW_ELEMENT",
  );
});

test("without allowJsonData there is no JSON block; a data-looking script stays a raw region", () => {
  rejectCode(
    () =>
      compileTemplates(
        { "index.html": '<script type="application/json">{{x}}</script>' },
        "index.html",
        { baseUrl: BASE },
      ),
    "DYNAMIC_RAW_ELEMENT",
  );
});

test("the same include is governed by the surrounding context: JSON block vs plain text", () => {
  const files = {
    "index.html":
      '<script id="j" type="application/json">{{#include "p.html"}}</script><p id="t">{{#include "p.html"}}</p>',
    "p.html": "{{v}}",
  };
  const compiled = compile(files);
  // A string is a legal JSON value and a legal text value.
  const html = compiled.render({ v: "</script><b>" });
  const doc = parseDoc(html);
  assert.deepEqual(JSON.parse(textOf(doc.findById("j"))), "</script><b>");
  assert.equal(doc.findById("t").childNodes[0].value, "</script><b>");

  // An object is valid JSON but not a legal text interpolation.
  rejectCode(() => compiled.render({ v: { a: 1 } }), "VARIABLE_TYPE_ERROR");
});

test("an include may supply the single JSON value, including behind an if", () => {
  const compiled = compile({
    "index.html":
      '<script type="application/json">{{#if a}}{{#include "d.html"}}{{else}}{{y}}{{/if}}</script>',
    "d.html": "{{x}}",
  });
  const html = compiled.render({ a: true, x: [1, 2], y: null });
  const doc = parseDoc(html);
  assert.deepEqual(JSON.parse(textOf(doc.scripts(doc.document)[0])), [1, 2]);
});

test("multiple separate JSON blocks each hold one value and reset independently", () => {
  const compiled = compile({
    "index.html":
      '<script id="a" type="application/json">{{a}}</script><p>x</p><script id="b" type="application/json">{{b}}</script>',
  });
  const html = compiled.render({ a: 1, b: { two: true } });
  const doc = parseDoc(html);
  assert.deepEqual(JSON.parse(textOf(doc.findById("a"))), 1);
  assert.deepEqual(JSON.parse(textOf(doc.findById("b"))), { two: true });
});

test("non-finite numbers are refused instead of silently becoming null", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => serializeJsonData(bad),
      (err) => {
        assert.equal(err.reason, "NON_FINITE_NUMBER");
        assert.match(err.message, /finite JSON number/);
        return true;
      },
    );
  }
  assert.equal(serializeJsonData(0), "0");
  assert.equal(serializeJsonData(-3.25e10), String(-3.25e10));
});

test("unsupported and silently-rewritten values are refused with evidence", () => {
  const rejectReason = (value, reason) => {
    assert.throws(
      () => serializeJsonData(value),
      (err) => {
        assert.equal(err.reason, reason, `expected ${reason}; ${err.message}`);
        return true;
      },
    );
  };
  rejectReason(10n, "UNSUPPORTED_TYPE");
  rejectReason(() => 1, "UNSUPPORTED_TYPE");
  rejectReason(Symbol("s"), "UNSUPPORTED_TYPE");
  rejectReason(new Date(0), "NON_PLAIN_OBJECT");
  rejectReason(new Map(), "NON_PLAIN_OBJECT");
  rejectReason(new Set([1]), "NON_PLAIN_OBJECT");
  rejectReason(/re/, "NON_PLAIN_OBJECT");
  class Point {}
  rejectReason(new Point(), "NON_PLAIN_OBJECT");
  rejectReason(
    Object.defineProperty({}, "g", { get: () => 1, enumerable: true }),
    "ACCESSOR_PROPERTY",
  );
  rejectReason({ a: undefined }, "UNSUPPORTED_TYPE");
  rejectReason({ toJSON: () => "rewritten" }, "TOJSON_METHOD");
  const sparse = [1, 2];
  sparse.length = 3;
  rejectReason(sparse, "ARRAY_HOLE");
  const extra = [1];
  extra.named = 2;
  rejectReason(extra, "ARRAY_EXTRA_PROPERTY");
  rejectReason(
    Object.defineProperty({}, "hidden", { value: 1, enumerable: false }),
    "NON_ENUMERABLE_PROPERTY",
  );
  rejectReason({ [Symbol("k")]: 1 }, "SYMBOL_PROPERTY");
  const circular = {};
  circular.self = circular;
  rejectReason(circular, "CIRCULAR_REFERENCE");
  // A shared (non-circular) reference is still legal JSON.
  const shared = { a: 1 };
  assert.equal(
    serializeJsonData({ x: shared, y: shared }),
    '{"x":{"a":1},"y":{"a":1}}',
  );
});

test("nesting is limited to 16 levels of object/array data", () => {
  let ok = 1;
  for (let i = 0; i < 16; i += 1) ok = { a: ok };
  serializeJsonData(ok);
  let tooDeep = 1;
  for (let i = 0; i < 17; i += 1) tooDeep = { a: tooDeep };
  assert.throws(
    () => serializeJsonData(tooDeep),
    (err) => err.reason === "DEPTH_EXCEEDED",
  );
});

test("primitive, null, empty container, and number fidelity are retained", () => {
  for (const [value, text] of [
    ["x", '"x"'],
    [true, "true"],
    [false, "false"],
    [null, "null"],
    [0, "0"],
    [[], "[]"],
    [{}, "{}"],
  ]) {
    assert.equal(serializeJsonData(value), text);
    assert.deepEqual(JSON.parse(serializeJsonData(value)), value);
  }
});

test("invalid JSON data makes render fail rather than emitting a half page", () => {
  const compiled = compile({
    "index.html":
      '<header>{{head}}</header><script type="application/json">{{data}}</script><footer>done</footer>',
  });
  const cyclic = {};
  cyclic.self = cyclic;
  for (const data of [NaN, { a: NaN }, cyclic, 5n]) {
    rejectCode(
      () => compiled.render({ head: "H", data }),
      "INVALID_JSON_DATA",
    );
  }
  // Invalid value on the unselected branch is not consulted; valid render works.
  const branchy = compile({
    "index.html":
      '<script type="application/json">{{#if a}}{{ok}}{{else}}{{bad}}{{/if}}</script>',
  });
  assert.equal(
    branchy.render({ a: true, ok: 1, bad: NaN }),
    '<script type="application/json">1</script>',
  );
  rejectCode(
    () => branchy.render({ a: false, ok: 1, bad: NaN }),
    "INVALID_JSON_DATA",
  );
});

test("a getter is never invoked; bad data is refused rather than observed", () => {
  let touched = false;
  const value = Object.defineProperty({}, "g", {
    get() {
      touched = true;
      return 1;
    },
    enumerable: true,
  });
  rejectCode(
    () =>
      compile({
        "index.html": '<script type="application/json">{{x}}</script>',
      }).render({ x: value }),
    "INVALID_JSON_DATA",
  );
  assert.equal(touched, false);
});
