# Restricted HTML template compiler

This package compiles trusted developer-authored HTML templates that render untrusted string data. It implements its own template parser and HTML context scanner; no contextual autoescape template engine is used for the compiler core. `parse5` is used only in the test suite as an independent HTML parser.

## Supported template language

- Output: `{{name}}` or dotted paths such as `{{user.name}}`.
- Boolean conditionals: `{{#if flag}} ... {{else}} ... {{/if}}`.
- Static includes: `{{#include "partial.html"}}`.
- Include targets are fixed quoted strings. Data cannot select an included file.
- Maximum six files and 20 KiB total source across a compilation.

The developer template text is trusted and is not sanitized. Dynamic string data is never trusted.

## Compilation guarantees

The compiler tokenizes ordinary text, quoted attribute values, comments, DOCTYPE declarations, and `script`/`style` raw-text regions. Context is propagated into both conditional branches and through includes.

Compilation fails, with file, line/column, and include-chain information when possible, if:

- Both `if`/`else` branches end in incompatible HTML contexts.
- Includes form a cycle.
- Interpolation occurs in a tag name, attribute name, unquoted attribute value, event handler attribute, `style`, `srcdoc`, or `srcset`, a comment, markup declaration, or `script`/`style` region.
- A dynamic `href` or `src` does not occupy the entire quoted value.
- A template ends in the middle of a tag, quoted attribute, comment, script, or style region.
- SVG, MathML, or non-script/style special raw/RCDATA-style elements are used.

## Escaping and URLs

- Text interpolation escapes `&`, `<`, and `>`.
- Quoted attribute interpolation escapes `&`, `<`, `>`, `"`, and `'`.
- `href`/`src` interpolation is first resolved against a fixed base URL. Only `http:`, `https:`, or same-site relative references are retained. Control characters, tab/newline/CR whitespace, backslashes, and protocol-relative (`//host`) values are rejected. The accepted normalized value is then attribute-escaped.

Static literal attribute values are not rewritten or sanitized; only dynamic data is constrained.

## Atomic rendering

A compiled template is reusable. Each render validates every variable on the selected branch before constructing output:

- text and URL values must be strings;
- `if` values must be booleans;
- required URL strings must satisfy the fixed-base URL policy.

A missing variable, wrong type, or invalid URL throws before any partial HTML is returned.

## Structured data blocks (`allowJsonData: true`)

With `allowJsonData: true`, a literal `<script type="application/json">` start tag opens a data block instead of a raw script region.

- A block contains exactly **one complete JSON value** interpolation plus optional surrounding whitespace. The value may be produced directly, by an `{{#include}}`, or by an `{{#if}}`, but every if/else branch must finish in the same state: a branch that emits the value while the other emits only whitespace is a compile error, and two values in one block (even across separate `if`s) never compile. Interpolation inside a JSON fragment such as `{"a": {{x}}}` or `[1,{{x}}]` is rejected.
- The `type` is an exact, case-insensitive literal (surrounding whitespace trimmed; parameters such as `; charset=` are not a data block). It cannot be interpolated, chosen by a branch, repeated (including a second boolean `type`), or supplied through an include. Ordinary `<script>` and `<style>` regions continue to reject all dynamic content, including other attributes on a `<script>` start tag. When the option is off, every `<script>` is an ordinary raw region.
- The same include file is compiled against each call site, so it is handled as a JSON value inside a data block and as escaped text/attribute/URL output elsewhere; the contexts never share output classification.
- Accepted data: finite numbers, strings, booleans, `null`, dense arrays without extra properties, and plain objects. Rejected: `NaN`/`Infinity`, circular references, accessor (getter/setter) properties, non-enumerable and symbol-keyed properties, array holes and extra array properties, own `toJSON`, non-plain objects such as `Date`/`Map`/class instances, `bigint`, `undefined`, functions, and symbols, plus nesting deeper than 16 object/array levels. Getters are never invoked, so bad values are refused without side effects.
- Serialization preserves type and value: the text is inserted raw (never HTML-entity escaped), and `<`, `>`, U+2028 and U+2029 are emitted as unicode escapes so data containing `</script>` or script comment sequences cannot change the page structure.
- Render is atomic: every value on the selected branch is validated before output is built, so invalid data never yields a successful half page.

After rendering, `JSON.parse(script.textContent)` returns a value deeply equal to the input.

## Example

```js
import { compileTemplates } from './src/index.js';

const compiled = compileTemplates({
  'index.html': '<h1>{{title}}</h1><a href="{{home}}">Home</a>',
}, 'index.html', { baseUrl: 'https://example.com/app/' });

compiled.render({
  title: '<script>alert(1)</script>',
  home: '/dashboard?next=home',
});
```

## Tests

```bash
npm test
```


allowJsonData:true 新增字面量 type="application/json" 的数据块。块内只允许一处完整 JSON 值插值与前后空白，可由 include/if 产生，但所有分支必须结束于兼容的完整值状态；不得在 JSON 字符串或数组片段中插值，也不得动态选择 type 或使用重复 type。普通 script/style 仍禁止动态输出。JSON 数据支持有限数、字符串、布尔、null、无空洞数组和普通对象，拒绝循环、getter、非 JSON 类型及超过 16 层数据；保留类型，不能转成 HTML 实体文本。渲染后 JSON.parse(script.textContent) 必须还原原数据，数据中的 HTML 结束标签不能改变页面结构。
