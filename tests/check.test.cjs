const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const check = path.join(__dirname, "..", "check.js");

const schema = `
scalar JSON
input LineSelector @oneOf { id: ID, handle: String }
type CartLine { id: ID! }
type Query { id: ID!, lines(selector: LineSelector!, first: Int): [CartLine!]! }
`;

const targets = [
  { target: "test.target.prepare", export: "targetPrepare" },
  { target: "test.target.run", export: "targetRun", inputQuery: "src/run.graphql" },
];

// Runs check.js for a function whose prepare target returns `variables`, as Shopify CLI does.
function runCheck(t, { variables = "{}", fn = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "function-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "schema.graphql"), schema);
  fs.writeFileSync(path.join(dir, "src/run.graphql"), "query Run($selector: LineSelector!, $first: Int) { lines(selector: $selector, first: $first) { id } }");
  fs.writeFileSync(path.join(dir, "src/index.js"), `export function targetPrepare() {\n  return { variables: ${variables} };\n}\n`);
  const json = path.join(dir, "function.json");
  fs.writeFileSync(json, JSON.stringify({ handle: "prepare-test", directory: dir, entry: "src/index.js", schema: "schema.graphql", targets, ...fn }));
  return spawnSync(process.execPath, [check, "--function", json], { cwd: dir, encoding: "utf8" });
}

test("passes variables the run query accepts", (t) => {
  const result = runCheck(t, { variables: '{ selector: { id: "gid://shopify/CartLine/1" }, first: 5 }' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("fails when a prepare target returns variables its run query doesn't accept", (t) => {
  const result = runCheck(t, { variables: '{ selectr: { id: "gid://shopify/CartLine/1" }, first: "5" }' });
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    [
      `The function extension "prepare-test" returns prepare variables its run query doesn't accept`,
      "src/index.js:2:25 `variables.selectr` isn't declared by src/run.graphql",
      'src/index.js:2:77 `variables.first` must be Int, not "5"',
      "src/index.js:2:23 `variables.selector` is missing, and LineSelector! has no default",
      "",
    ].join("\n"),
  );
});

test("warns, without failing, about variables it can't check", (t) => {
  const result = runCheck(t, { variables: "{ selector: JSON.parse(\"{}\"), first: 5 }" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stderr,
    [
      `The function extension "prepare-test" returns prepare variables that can't be checked against its run query`,
      "src/index.js:2:35 `variables.selector` is typed any, so it can't be checked",
      "",
    ].join("\n"),
  );
});

test("warns, without failing, when the check itself fails", (t) => {
  const result = runCheck(t, { fn: { schema: "missing.graphql" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /The function extension "prepare-test"'s prepare variables couldn't be checked: ENOENT/);
});

test("passes a function without prepare targets", (t) => {
  const result = runCheck(t, { fn: { entry: undefined, targets: [targets[1]] } });
  assert.equal(result.status, 0, result.stderr);
});
