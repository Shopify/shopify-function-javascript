// Generates types for a function the way Shopify CLI does, then type-checks them.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const fixture = path.join(__dirname, "fixtures", "function");

// The codegen block of the JavaScript function templates in Shopify/extensions-templates.
const templateCodegen = {
  schema: "schema.graphql",
  documents: "src/*.graphql",
  generates: { "./generated/api.ts": { plugins: ["typescript", "typescript-operations"] } },
  config: { omitOperationSuffix: true },
};

// Shopify CLI merges these defaults into the function's codegen config, writes it
// to a temporary file and runs graphql-code-generator from the function directory.
// See buildGraphqlTypes in Shopify/cli packages/app/src/cli/services/function/build.ts.
const cliDefaults = {
  defaultScalarType: "unknown",
  scalars: {
    Date: "string",
    DateTime: "string",
    DateTimeWithoutTimezone: "string",
    Decimal: "string",
    Handle: "string",
    ID: "string",
    JSON: "unknown",
    TimeWithoutTimezone: "string",
    URL: "string",
    Void: "null",
  },
};

function generate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "function-"));
  fs.cpSync(fixture, dir, { recursive: true });
  // Codegen resolves its plugins from the function directory, as in an installed function.
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  const config = {
    ...templateCodegen,
    config: {
      ...cliDefaults,
      ...templateCodegen.config,
      scalars: { ...cliDefaults.scalars, ...templateCodegen.config.scalars },
    },
  };
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codegen-")), "codegen.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const bin = fs.realpathSync(path.join(root, "node_modules", ".bin", "graphql-code-generator"));
  execFileSync(process.execPath, [bin, "--config", configPath], { cwd: dir, stdio: "pipe" });
  return dir;
}

function typeErrors(dir) {
  const program = ts.createProgram([path.join(dir, "generated", "api.ts"), path.join(dir, "src", "target_prepare.js")], {
    allowJs: true,
    checkJs: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
  });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const file = d.file ? path.relative(dir, d.file.fileName) : "";
    return `${file}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
  });
}

test("generated types compile when queries use enums and input objects", () => {
  const dir = generate();
  try {
    assert.deepEqual(typeErrors(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the run query's variables type checks what a prepare target returns", () => {
  const dir = generate();
  try {
    const prepare = path.join(dir, "src", "target_prepare.js");
    const source = fs.readFileSync(prepare, "utf8");
    for (const [from, to, expected] of [
      ["filter:", "filtre:", /'filtre' does not exist/],
      ["country: CountryCode.Us", 'country: "US"', /'"US"' is not assignable/],
      ['titles: ["Gift card"]', "titles: [1]", /'number' is not assignable to type 'string'/],
    ]) {
      fs.writeFileSync(prepare, source.replace(from, to));
      const errors = typeErrors(dir);
      assert.ok(errors.some((error) => expected.test(error)), `${to}:\n${errors.join("\n")}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
