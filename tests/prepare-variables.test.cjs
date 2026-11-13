const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareVariablesProblems } = require("../prepare-variables.js");

const schema = `
  scalar JSON
  scalar Decimal
  scalar Handle
  scalar Void
  enum Mode { FAST SLOW }
  input Selector @oneOf { id: ID, handle: String }
  input Rule { handle: String!, weight: Int }
  type Query { shop: String, id: ID }
  input CartValidationsGeneratePrepareResult { variables: JSON!, cacheKey: String }
  type Mutation { cartValidationsGeneratePrepare(result: CartValidationsGeneratePrepareResult!): Void! }
`;
const runQuery =
  "query Run($handle: String!, $limit: Int = 5, $mode: Mode, $rules: [Rule!], $data: JSON, $id: ID, $price: Decimal, $selector: Selector, $handles: [Handle!], $nothing: Void) { shop }";

const paired = [
  { target: "cart.validations.generate.prepare", export: "cartValidationsGeneratePrepare" },
  { target: "cart.validations.generate.run", inputQuery: "src/run.graphql", export: "cartValidationsGenerateRun" },
];

// Writes a function with `files` in src/ and returns its problems, without their locations. Warnings start with "warning: ".
function check(files, targets = paired) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-"));
  try {
    fs.mkdirSync(path.join(directory, "src"));
    fs.writeFileSync(path.join(directory, "schema.graphql"), schema);
    fs.writeFileSync(path.join(directory, "src/run.graphql"), runQuery);
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, "src", file), content);
    return prepareVariablesProblems({ directory, entry: "src/index.js", schema: "schema.graphql", targets }).map(
      ({ message, warning }) => `${warning ? "warning: " : ""}${message.replace(/^\S+:\d+:\d+ /, "")}`,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const prepare = (body) => ({ "index.js": `export function cartValidationsGeneratePrepare(input) {\n${body}\n}` });
// A function whose prepare target is written in TypeScript, in src/prepare.ts
const typescript = (source) => ({ "index.js": "export * from './prepare.ts'", "prepare.ts": source });
// A prepare target that creates `variables` from `object`, then runs `lines` before returning it
const assigned = (object, lines) => check(prepare(`const variables = ${object}\n${lines}\nreturn {variables}`));

describe("prepareVariablesProblems", () => {
  test("accepts variables the run query declares", () => {
    assert.deepEqual(
      check(
        prepare(`
          const region = String(input.region)
          return {
            variables: {
              handle: region ? \`rule-\${region.toLowerCase()}\` : 'default',
              limit: undefined,
              mode: region === 'eu' ? 'FAST' : null,
              rules: [{handle: 'a', weight: 1}],
              data: JSON.parse(input.data),
            },
          }`),
      ),
      [],
    );
  });

  test("ignores functions without a prepare target", () => {
    assert.deepEqual(
      check({}, [{ target: "cart.validations.generate.run", inputQuery: "src/run.graphql", export: "run" }]),
      [],
    );
  });

  test("rejects keys the run query does not declare", () => {
    assert.deepEqual(check(prepare(`return {variables: {handel: 'a'}}`)), [
      "`variables.handel` isn't declared by src/run.graphql",
      "`variables.handle` is missing, and String! has no default",
    ]);
  });

  test("rejects values of the wrong type", () => {
    assert.deepEqual(
      check(prepare(`return {variables: {handle: 1, limit: 1.5, mode: 'MEDIUM', rules: [{handle: 'a', weight: '1'}]}}`)),
      [
        "`variables.handle` must be String!, not 1",
        "`variables.limit` must be Int, not 1.5",
        '`variables.mode` must be Mode, not "MEDIUM"',
        '`variables.rules[].weight` must be Int, not "1"',
      ],
    );
    // Each branch is checked on its own, since TypeScript widens 'FAST' and 'MEDIUM' to string and merges the branches
    assert.deepEqual(
      check(
        prepare(`return input.a ? {variables: {handle: 'a', mode: 'FAST'}} : {variables: {handle: 'a', mode: 'MEDIUM'}}`),
      ),
      ['`variables.mode` must be Mode, not "MEDIUM"'],
    );
  });

  test("rejects null and undefined where the variable needs a value", () => {
    assert.deepEqual(check(prepare(`return input.a ? {variables: {handle: null}} : {variables: {handle: undefined}}`)), [
      "`variables.handle` can be null, but String! can't",
      "`variables.handle` can be undefined, but String! has no default",
    ]);
    assert.deepEqual(check(prepare(`return {}`)), ["`variables` is missing, and Variables! has no default"]);
  });

  test("only fails on values that are definitely wrong", () => {
    assert.deepEqual(
      check({
        "index.js": `
          const MODES = ['FAST', 'SLOW']
          /** @param {{a: boolean, m: string}} input */
          export function cartValidationsGeneratePrepare(input) {
            return {variables: {handle: (input.a && 'x') || 'y', id: 5, mode: input.a ? input.m : MODES[0], price: '1.5'}}
          }`,
      }),
      [
        // One for `input.m`, and one for `MODES[0]`
        "warning: `variables.mode` is string, which Mode may not accept, so it can't be checked",
        "warning: `variables.mode` is string, which Mode may not accept, so it can't be checked",
      ],
    );
    assert.deepEqual(check(prepare(`return {variables: {handle: (input.a && false) || true, id: 1.5}}`)), [
      "warning: `variables.handle` is typed any, so it can't be checked",
      "`variables.handle` must be String!, not true",
      "`variables.id` must be ID, not 1.5",
    ]);
  });

  test("checks the prepare result's other fields from the schema", () => {
    assert.deepEqual(check(prepare(`return {variables: {handle: 'a'}, cacheKey: 'k'}`)), []);
    assert.deepEqual(check(prepare(`return {variables: {handle: 'a'}, cacheKey: 5}`)), ["`cacheKey` must be String, not 5"]);
    assert.deepEqual(check(prepare(`return {variables: {handle: 'a'}, cacheKy: 'k'}`)), [
      "`cacheKy` isn't a field of CartValidationsGeneratePrepareResult",
    ]);
  });

  test("rejects an async prepare target", () => {
    assert.deepEqual(check({ "index.js": "export async function cartValidationsGeneratePrepare() { return {variables: {handle: 'a'}} }" }), [
      "`cartValidationsGeneratePrepare` is async, so it returns a promise instead of its result",
    ]);
  });

  test("checks custom scalars as the type codegen gives them", () => {
    const vars = (value, scalars) =>
      check({
        ...prepare(`return {variables: {handle: 'a', ${value}}}`),
        "../package.json": JSON.stringify({ codegen: { config: { scalars } } }),
      });
    assert.deepEqual(vars(`handles: ['h']`), []);
    assert.deepEqual(vars(`handles: ['h', null]`), ["`variables.handles[]` can be null, but Handle! can't"]);
    assert.deepEqual(vars(`handles: [5]`), ["`variables.handles[]` must be Handle!, not 5"]);
    assert.deepEqual(vars(`price: '1.5'`), []);
    assert.deepEqual(vars(`price: 1.5`), ["`variables.price` must be Decimal, not 1.5"]);
    assert.deepEqual(vars(`price: 1.5`, { Decimal: "number" }), []);
    assert.deepEqual(vars(`price: 1.5`, { Decimal: { input: "unknown", output: "string" } }), []);
    assert.deepEqual(vars(`price: 1.5`, null), ["`variables.price` must be Decimal, not 1.5"]);
    assert.deepEqual(vars(`data: {a: [1]}`), []);
    assert.deepEqual(vars(`nothing: null`), []);
    assert.deepEqual(vars(`nothing: 'x'`), ["`variables.nothing` must be Void, not \"x\""]);
  });

  test("checks a value with toJSON as what it returns", () => {
    const vars = (value) => check(prepare(`return {variables: {handle: ${value}}}`));
    assert.deepEqual(vars(`new Date()`), []);
    assert.deepEqual(vars(`{toJSON: () => 'a'}`), []);
    assert.deepEqual(vars(`{toJSON: () => 5}`), ["`variables.handle` must be String!, not number"]);
  });

  test("applies oneOf input object rules", () => {
    const selector = (value) => check(prepare(`return {variables: {handle: 'a', selector: ${value}}}`));
    assert.deepEqual(selector(`{id: '1'}`), []);
    assert.deepEqual(selector(`{id: '1', handle: 'x'}`), ["`variables.selector` must set exactly one field of Selector"]);
    assert.deepEqual(selector(`{}`), ["`variables.selector` must set exactly one field of Selector"]);
    assert.deepEqual(selector(`{id: null}`), ["`variables.selector.id` can be null, but ID! can't"]);
    assert.deepEqual(selector(`{id: '1', handle: undefined}`), []);
    assert.deepEqual(selector(`{id: undefined, handle: undefined}`), ["`variables.selector` must set exactly one field of Selector"]);
    assert.deepEqual(selector(`{id: input.a ? '1' : undefined, handle: 'x'}`), [
      "warning: `variables.selector` may not set exactly one field of Selector, so it can't be checked",
    ]);
  });

  test("treats an array element as possibly undefined", () => {
    assert.deepEqual(
      check(typescript("export function cartValidationsGeneratePrepare(input: {list: string[]}) { return {variables: {handle: input.list[0]}} }")),
      ["`variables.handle` can be undefined, but String! has no default"],
    );
  });

  test("keeps the narrowing of a variable where it's used", () => {
    const narrowed = (body) =>
      check(typescript(`export function cartValidationsGeneratePrepare(input: {handle?: string}) {\nconst handle = input.handle\n${body}\n}`));
    assert.deepEqual(narrowed(`return {variables: {handle: typeof handle === 'string' ? handle : 'fallback'}}`), []);
    assert.deepEqual(narrowed(`if (handle) return {variables: {handle}}\nreturn {variables: {handle: 'b'}}`), []);
    assert.deepEqual(narrowed(`return {variables: {handle}}`), ["`variables.handle` can be undefined, but String! has no default"]);
    assert.deepEqual(narrowed(`return {variables: {handle: notDeclared}}`), ["warning: `variables.handle` is typed any, so it can't be checked"]);
  });

  test("accepts an empty list typed never[]", () => {
    const files = typescript("export function cartValidationsGeneratePrepare() { return {variables: {handle: 'a', rules: [].slice()}} }");
    assert.deepEqual(check(files), []);
  });

  test("trusts non-null assertions", () => {
    assert.deepEqual(
      check(typescript("export function cartValidationsGeneratePrepare(input: {list: string[]}) { return {variables: {handle: input.list.find((x) => x)!}} }")),
      [],
    );
  });

  test("checks what is built, not what the return type declares", () => {
    assert.deepEqual(
      check({
        "index.js": `
          /** @returns {{variables: {handle: string}}} */
          export function cartValidationsGeneratePrepare() {
            const variables = {handle: 'a', region: 'eu'}
            return {variables}
          }`,
      }),
      ["`variables.region` isn't declared by src/run.graphql"],
    );
  });

  test("ignores what annotations and casts claim", () => {
    assert.deepEqual(
      check(
        prepare(`
          const raw = /** @type {{handle: string}} */ (JSON.parse(input.raw))
          const {limit} = /** @type {{limit: number}} */ (JSON.parse(input.raw))
          return {variables: {handle: raw.handle, limit}}`),
      ),
      ["warning: `variables.handle` is typed any, so it can't be checked", "warning: `variables.limit` is typed any, so it can't be checked"],
    );
    assert.deepEqual(
      check({
        "index.js": `export * from './prepare.js'`,
        "prepare.ts": `
          type Variables = {handle: string}
          export function cartValidationsGeneratePrepare(input: {name?: string; mode: string}): {variables: Variables} {
            if (input.mode) return {variables: {handle: input.name!, mode: <'FAST'>input.mode}}
            return {variables: new Map<string, Variables>().get(input.mode)! as Variables}
          }`,
      }),
      [
        "warning: `variables.mode` is string, which Mode may not accept, so it can't be checked",
        "warning: `variables` is typed any, so it can't be checked",
      ],
    );
  });

  test("keeps what a return returns when it removes a cast", () => {
    const files = typescript("export function cartValidationsGeneratePrepare() {\n  return <any>\n    ({variables: {handle: 5}});\n}");
    assert.deepEqual(check(files), ["`variables.handle` must be String!, not 5"]);
  });

  test("sees through casts, @ts-ignore and helpers", () => {
    assert.deepEqual(
      check({
        "index.js": `
          export function cartValidationsGeneratePrepare(input) {
            // @ts-ignore
            if (input.a) return {variables: /** @type {{handle: string}} */ (JSON.parse(input.raw))}
            return {variables: build()}
          }
          function build() {
            return {handle: 2}
          }`,
      }),
      ["warning: `variables` is typed any, so it can't be checked", "`variables.handle` must be String!, not 2"],
    );
  });

  test("checks the last value of a key written twice", () => {
    assert.deepEqual(check(prepare(`return {variables: {handle: 'a', handle: 5}}`)), ["`variables.handle` must be String!, not 5"]);
  });

  test("checks objects combined with Object.assign", () => {
    assert.deepEqual(check(prepare(`return {variables: Object.assign({}, {handle: 'a'}, {limit: 2})}`)), []);
    assert.deepEqual(check(prepare(`return {variables: Object.assign({}, {handle: 'a'}, {region: 'eu'})}`)), [
      "`variables.region` isn't declared by src/run.graphql",
    ]);
  });

  test("warns about spreading an object that can have any keys", () => {
    assert.deepEqual(
      check({
        "index.js": `/** @param {{json: Record<string, unknown>}} input */
          export function cartValidationsGeneratePrepare(input) { return {variables: {handle: 'a', ...input.json}} }`,
      }),
      ["warning: `variables` spreads an object that can have any keys, so it can't be checked"],
    );
  });

  test("warns about, rather than checks, variables changed or passed on after they are created", () => {
    assert.deepEqual(
      check(
        prepare(`
          const variables = {handle: 'a'}
          variables.limit = 'many'
          tweak(variables)
          return {variables}`),
      ),
      [
        "warning: `variables` is changed or passed on after it's created, so it can't be checked",
        "warning: `variables` is changed or passed on after it's created, so it can't be checked",
      ],
    );
    assert.deepEqual(
      check(
        prepare(`
          const base = {handle: 'a'}
          base.handle = 1
          return {variables: {...base}}`),
      ),
      ["warning: `variables` is changed or passed on after it's created, so it can't be checked"],
    );
  });

  test("checks variables assigned by name after the object is created", () => {
    assert.deepEqual(assigned(`{}`, `variables.handle = 'a'\nvariables['limit'] = 5`), []);
    assert.deepEqual(assigned(`{handle: null}`, `variables.handle = 'a'`), []);
    assert.deepEqual(assigned(`{handle: 'a'}`, `if (input.a) variables.region = 'eu'`), [
      "`variables.region` isn't declared by src/run.graphql",
    ]);
    assert.deepEqual(assigned(`{handle: 'a'}`, `variables.limit = 'many'`), ['`variables.limit` must be Int, not "many"']);
    assert.deepEqual(assigned(`{}`, `variables.limit = 5`), ["`variables.handle` is missing, and String! has no default"]);
    // Keys that aren't written out, and objects spread after they're assigned to, still can't be checked
    assert.deepEqual(assigned(`{handle: 'a'}`, `variables[input.key] = 5`), [
      "warning: `variables` is changed or passed on after it's created, so it can't be checked",
    ]);
    assert.deepEqual(check(prepare(`const base = {}\nbase.handle = 'a'\nreturn {variables: {...base}}`)), [
      "warning: `variables` is changed or passed on after it's created, so it can't be checked",
    ]);
  });

  test("uses the value of a key in brackets", () => {
    assert.deepEqual(assigned(`{}`, `const key = 'handle'\nvariables[key] = 'a'`), []);
    assert.deepEqual(assigned(`{}`, `let key = 'handle'\nvariables[key] = 'a'`), [
      "warning: `variables` is changed or passed on after it's created, so it can't be checked",
    ]);
  });

  test("warns about a required variable that's only set on some paths", () => {
    assert.deepEqual(assigned(`{}`, `variables.handle = 'a'`), []);
    for (const lines of [
      `if (input.a) variables.handle = 'a'`,
      `for (const x of input.list) variables.handle = 'a'`,
    ]) {
      assert.deepEqual(assigned(`{}`, lines), ["warning: `variables.handle` is only set on some paths, so it can't be checked"], lines);
    }
  });

  test("follows a variable reached through an assignment's value", () => {
    const body = `const variables = {}\nvariables.handle = ${"VALUE"}\nconst result = {}\nresult.variables = variables\nreturn result`;
    assert.deepEqual(check(prepare(body.replace("VALUE", "'a'"))), []);
    assert.deepEqual(check(prepare(body.replace("VALUE", "5"))), ["`variables.handle` must be String!, not 5"]);
  });

  test("checks the writes to a key that can be returned", () => {
    assert.deepEqual(assigned(`{}`, `variables.handle = null\nvariables.handle = 'a'`), []);
    assert.deepEqual(assigned(`{}`, `if (input.a) variables.handle = null\nvariables.handle = 'a'`), []);
    assert.deepEqual(assigned(`{}`, `variables.handle = 'a'\nvariables.handle = null`), ["`variables.handle` can be null, but String! can't"]);
    assert.deepEqual(assigned(`{handle: null}`, `if (input.a) variables.handle = 'a'`), ["`variables.handle` can be null, but String! can't"]);
  });

  test("skips a write in a block that returns or throws first", () => {
    assert.deepEqual(assigned(`{handle: 'a'}`, `if (input.a) { variables.handle = null; return {variables: {handle: 'b'}} }`), []);
    assert.deepEqual(assigned(`{handle: 'a'}`, `if (input.a) { variables.handle = null; throw new Error('x') }`), []);
    assert.deepEqual(assigned(`{handle: 'a'}`, `if (input.a) { variables.handle = null; return {variables} }`), ["`variables.handle` can be null, but String! can't"]);
    assert.deepEqual(assigned(`{handle: 'a'}`, `if (input.a) { variables.handle = null }`), ["`variables.handle` can be null, but String! can't"]);
  });

  test("only checks assignments that can change what's returned", () => {
    const built = (lines) => check(prepare(`const variables = {handle: 'a'}\n${lines}`));
    assert.deepEqual(built(`const later = () => { variables.limit = 'x' }\nreturn {variables}`), [
      "warning: `variables` is changed or passed on after it's created, so it can't be checked",
    ]);
    assert.deepEqual(built(`if (input.a) return {variables}\nvariables.limit = 'x'\nreturn {variables: {handle: 'b'}}`), []);
    assert.deepEqual(built(`const result = {variables}\nvariables.limit = 'x'\nreturn result`), ["`variables.limit` must be Int, not \"x\""]);
    assert.deepEqual(built(`for (const x of input.list) { if (x) return {variables}; variables.limit = 'x' }\nreturn {variables: {handle: 'b'}}`), [
      "`variables.limit` must be Int, not \"x\"",
    ]);
  });

  test("follows the arguments a helper is called with", () => {
    assert.deepEqual(
      check({
        "index.js": `/** @param {{n: number}} input */
          export function cartValidationsGeneratePrepare(input) { return {variables: build(input.n)} }
          /** @param {string} handle */
          function build(handle) { return {handle} }`,
      }),
      ["`variables.handle` must be String!, not number"],
    );
    assert.deepEqual(
      check(typescript("function id<T>(x: T): T { return x }\nexport function cartValidationsGeneratePrepare() { return {variables: id({handle: 'a'})} }")),
      [],
    );
  });

  test("checks a parameter a helper narrows or changes as its type there", () => {
    const helper = (source) =>
      check(typescript(`${source}\nexport function cartValidationsGeneratePrepare() { return {variables: build(7)} }`));
    assert.deepEqual(helper("function build(handle: string | number) { handle = String(handle); return {handle} }"), []);
    assert.deepEqual(helper("function build(handle: unknown) { if (typeof handle === 'string') return {handle}; return {handle: 'x'} }"), []);
    assert.deepEqual(helper("function build(handle: string | number) { handle = 5; return {handle} }"), ["`variables.handle` must be String!, not number"]);
    assert.deepEqual(helper("function build(handle: unknown) { handle = String(handle); return {handle} }"), [
      "warning: `variables.handle` is typed unknown, so it can't be checked",
    ]);
    assert.deepEqual(check(prepare("function build(handle) { handle = String(handle); return {handle} }\nreturn {variables: build(7)}")), [
      "warning: `variables.handle` is typed any, so it can't be checked",
    ]);
  });

  test("uses a helper's default where its argument is undefined", () => {
    const build = (call) =>
      check(typescript(`function build(handle = 'a') { return {handle} }\nexport function cartValidationsGeneratePrepare(input: {h?: string, n?: number}) { return {variables: ${call}} }`));
    assert.deepEqual(build(`build(undefined)`), []);
    assert.deepEqual(build(`build(input.h)`), []);
    assert.deepEqual(build(`build(input.n)`), ["`variables.handle` must be String!, not number"]);
  });

  test("checks a generic helper by what its call returns", () => {
    const generic = (variables) =>
      check(typescript(`function first<T>(...xs: T[]): T { return xs[0]! }\nexport function cartValidationsGeneratePrepare<T>(input: {t: T}) { return {variables: ${variables}} }`));
    assert.deepEqual(generic(`{handle: first(...['a'])}`), []);
    assert.deepEqual(generic(`{handle: 'a', limit: first('x')}`), ["`variables.limit` must be Int, not \"x\""]);
    assert.deepEqual(generic(`{handle: input.t}`), ["warning: `variables.handle` is typed T, so it can't be checked"]);
  });

  test("follows re-exports", () => {
    assert.deepEqual(
      check({
        "index.js": `export * from './prepare.js'`,
        "prepare.js": `export const cartValidationsGeneratePrepare = () => ({variables: {handle: 1}})`,
      }),
      ["`variables.handle` must be String!, not 1"],
    );
  });

  test("warns about an export it can't follow, and leaves missing exports to the bundler", () => {
    assert.deepEqual(
      check({
        "index.js": `
          const wrap = (fn) => fn
          export const cartValidationsGeneratePrepare = wrap(() => ({variables: {handle: 'a'}}))`,
      }),
      ["warning: `cartValidationsGeneratePrepare` isn't a function it can follow, so it can't be checked"],
    );
    assert.deepEqual(
      check({
        "index.js": `
          const handlers = {cartValidationsGeneratePrepare() { return {variables: {handle: 'a'}} }}
          export const cartValidationsGeneratePrepare = handlers.cartValidationsGeneratePrepare`,
      }),
      ["warning: `cartValidationsGeneratePrepare` isn't a function it can follow, so it can't be checked"],
    );
    assert.deepEqual(check({ "index.js": "export function other() {}" }), []);
  });

  test("warns about a syntax error, even in a file the bundle leaves out", () => {
    // A function missing its closing brace
    assert.deepEqual(check({ "index.js": "export function cartValidationsGeneratePrepare() {\n  return {variables: {handle: 1}}" }), [
      "warning: can't be checked because of a syntax error: '}' expected.",
    ]);
    assert.deepEqual(
      check({ ...typescript("import type { X } from './types.ts'\nexport function cartValidationsGeneratePrepare() { return {variables: {handle: 1}} }"), "types.ts": "export type X = { a: ; }" }),
      ["warning: can't be checked because of a syntax error: Type expected."],
    );
  });
});
