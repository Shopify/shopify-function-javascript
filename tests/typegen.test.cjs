const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generate } = require("@graphql-codegen/cli");

const typegen = path.join(__dirname, "..", "typegen.js");

const schema = `
schema { query: Input, mutation: MutationRoot }
scalar JSON
scalar Void
input LineSelector @oneOf { id: ID, handle: String }
type CartLine { id: ID! }
type Input { id: ID!, lines(selector: LineSelector!, first: Int): [CartLine!]! }
input FunctionTargetPrepareResult { variables: JSON! }
input FunctionTargetRunResult { lineCount: Int! }
type MutationRoot {
  "Handles the Function result for the test.target.prepare target."
  targetPrepare(result: FunctionTargetPrepareResult!): Void!
  "Handles the Function result for the test.target.run target."
  targetRun(result: FunctionTargetRunResult!): Void!
}
`;

const queries = {
  "target_prepare.graphql": "query TargetPrepareInput { id }",
  "target_run.graphql": "query TargetRunInput($selector: LineSelector!, $first: Int) { lines(selector: $selector, first: $first) { id } }",
};

const targets = [
  { target: "test.target.prepare", export: "targetPrepare", inputQuery: "src/target_prepare.graphql" },
  { target: "test.target.run", export: "targetRun", inputQuery: "src/target_run.graphql" },
];

const prepare = (variables) => ({
  "index.js": 'export * from "./prepare.js";\n',
  "prepare.js": `export function targetPrepare() {\n  return { variables: ${variables} };\n}\n`,
});

// The templates' codegen config, with Shopify CLI's defaults merged in.
const codegenConfig = (config) => ({
  schema: "schema.graphql",
  documents: "src/*.graphql",
  generates: { "./generated/api.ts": { plugins: ["typescript", "typescript-operations"] } },
  config: { defaultScalarType: "unknown", scalars: { ID: "string", JSON: "unknown", Void: "null" }, omitOperationSuffix: true, ...config },
});

// Runs typegen.js as Shopify CLI does. `modules` are written to the function's node_modules.
function runTypegen(t, { files, fnTargets = targets, config = {}, queryFiles = queries, modules = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "function-"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "typegen-"));
  t.after(() => [dir, tmp].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  fs.writeFileSync(path.join(dir, "schema.graphql"), schema);
  fs.mkdirSync(path.join(dir, "src"));
  for (const [name, contents] of Object.entries({ ...queryFiles, ...files })) fs.writeFileSync(path.join(dir, "src", name), contents);
  for (const [name, contents] of Object.entries(modules)) {
    fs.mkdirSync(path.join(dir, "node_modules", name), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", name, "index.js"), contents);
  }
  fs.writeFileSync(path.join(tmp, "codegen.json"), JSON.stringify(codegenConfig(config)));
  const fn = { handle: "prepare-test", directory: dir, entry: "src/index.js", schema: "schema.graphql", targets: fnTargets };
  fs.writeFileSync(path.join(tmp, "function.json"), JSON.stringify(fn));
  const result = spawnSync(
    process.execPath,
    [typegen, "--config", path.join(tmp, "codegen.json"), "--function", path.join(tmp, "function.json")],
    { cwd: dir, encoding: "utf8" },
  );
  const api = path.join(dir, "generated", "api.ts");
  return { dir, status: result.status, stderr: result.stderr, types: fs.existsSync(api) ? fs.readFileSync(api, "utf8") : undefined };
}

test("passes variables the run query accepts, generating the types with this package's plugins rather than the function's", (t) => {
  // Plugins that work, as another version installed in the function would, but mark the output
  const other = 'exports.plugin = () => "// the function\'s plugin";';
  const fn = runTypegen(t, {
    files: prepare('{ selector: { id: "gid://shopify/CartLine/1" }, first: 5 }'),
    modules: { "@graphql-codegen/typescript": other, "@graphql-codegen/typescript-operations": other },
  });
  assert.equal(fn.status, 0, fn.stderr);
  assert.doesNotMatch(fn.types, /the function's plugin/);
  assert.match(fn.types, /export type TargetRunInputVariables = /);
});

test("fails when a prepare target returns variables its run query doesn't accept", (t) => {
  const fn = runTypegen(t, { files: prepare('{ selectr: { id: "gid://shopify/CartLine/1" }, first: "5" }') });
  assert.equal(fn.status, 1);
  assert.equal(
    fn.stderr,
    [
      `The function extension "prepare-test" returns prepare variables its run query doesn't accept`,
      "src/prepare.js:2:25 `variables.selectr` isn't declared by src/target_run.graphql",
      'src/prepare.js:2:77 `variables.first` must be Int, not "5"',
      "src/prepare.js:2:23 `variables.selector` is missing, and LineSelector! has no default",
      "",
    ].join("\n"),
  );
  // The types are still generated, for editors
  assert.match(fn.types, /export type TargetRunInputVariables = /);
});

test("without prepare targets, generates the same types as the typescript and typescript-operations plugins", async (t) => {
  const fn = runTypegen(t, { files: prepare("{}"), fnTargets: [targets[1]] });
  assert.equal(fn.status, 0, fn.stderr);
  const [plain] = await generate({ ...codegenConfig({}), cwd: fn.dir, silent: true, pluginLoader: require }, false);
  assert.equal(fn.types, plain.content);
});

test("fails when codegen fails", (t) => {
  const fn = runTypegen(t, { files: prepare("{}"), queryFiles: { ...queries, "target_run.graphql": "query TargetRunInput { missingField }" } });
  assert.equal(fn.status, 1);
  assert.match(fn.stderr, /missingField/);
});
