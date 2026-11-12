const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareVariablesProblems } = require("../prepare-variables.js");

const schema = `
  scalar JSON
  scalar Decimal
  enum Mode { FAST SLOW }
  input Rule { handle: String!, weight: Int }
  type Query { shop: String, id: ID }
`;
const runQuery =
  "query Run($handle: String!, $limit: Int = 5, $mode: Mode, $rules: [Rule!], $data: JSON, $id: ID, $price: Decimal) { shop }";

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
        "`variables.handle` can be undefined, but String! has no default",
        "warning: `variables.mode` is string, which Mode may not accept, so it can't be checked",
        "warning: `variables` is typed any, so it can't be checked",
      ],
    );
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

  test("checks variables assigned by name after the object is created", () => {
    const assigned = (lines) => check(prepare(`const variables = ${lines}\nreturn {variables}`));
    assert.deepEqual(assigned(`{}\nvariables.handle = 'a'\nvariables['limit'] = 5`), []);
    assert.deepEqual(assigned(`{handle: null}\nvariables.handle = 'a'`), []);
    assert.deepEqual(assigned(`{handle: 'a'}\nif (input.a) variables.region = 'eu'`), [
      "`variables.region` isn't declared by src/run.graphql",
    ]);
    assert.deepEqual(assigned(`{handle: 'a'}\nvariables.limit = 'many'`), ['`variables.limit` must be Int, not "many"']);
    assert.deepEqual(assigned(`{}\nvariables.limit = 5`), ["`variables.handle` is missing, and String! has no default"]);
    // Keys that aren't written out, and objects spread after they're assigned to, still can't be checked
    assert.deepEqual(assigned(`{handle: 'a'}\nvariables[input.key] = 5`), [
      "warning: `variables` is changed or passed on after it's created, so it can't be checked",
    ]);
    assert.deepEqual(check(prepare(`const base = {}\nbase.handle = 'a'\nreturn {variables: {...base}}`)), [
      "warning: `variables` is changed or passed on after it's created, so it can't be checked",
    ]);
  });

  test("only fails on values that are definitely wrong", () => {
    assert.deepEqual(
      check({
        "index.js": `
          const MODES = ['FAST', 'SLOW']
          /** @param {{a: boolean, m: string}} input */
          export function cartValidationsGeneratePrepare(input) {
            return {variables: {handle: (input.a && 'x') || 'y', id: 5, mode: input.a ? input.m : MODES[0], price: 1.5}}
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

  test("warns about an export it can't follow, and leaves missing exports and syntax errors to the bundler", () => {
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
    // A function missing its closing brace
    assert.deepEqual(check({ "index.js": "export function cartValidationsGeneratePrepare() {\n  return {variables: {handle: 1}}" }), []);
  });
});
