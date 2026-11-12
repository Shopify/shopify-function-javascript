// Generates types for a function the way Shopify CLI does, then type-checks them.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

const root = path.join(__dirname, "..");

// A function schema and an input query that selects an enum field and uses
// enum and input object variables.
const schema = `
schema {
  query: Input
  mutation: MutationRoot
}

scalar Void

enum CountryCode { CA US }
enum DeliveryMethod { SHIPPING PICK_UP }

input LineFilter {
  titles: [String!]
  country: CountryCode
}

type CartLine {
  id: ID!
  deliveryMethod: DeliveryMethod
}

type Cart {
  lines(filter: LineFilter, country: CountryCode): [CartLine!]!
}

type Input {
  cart: Cart!
}

input FunctionRunResult {
  lineCount: Int!
}

type MutationRoot {
  run(result: FunctionRunResult!): Void!
}
`;

const inputQuery = `
query RunInput($filter: LineFilter!, $country: CountryCode) {
  cart {
    lines(filter: $filter, country: $country) {
      id
      deliveryMethod
    }
  }
}
`;

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

test("generated types have no type errors when a query uses enums and input objects", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "function-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegen-"));
  try {
    fs.writeFileSync(path.join(dir, "schema.graphql"), schema);
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "run.graphql"), inputQuery);
    // Codegen resolves its plugins from the function directory, as in an installed function.
    // A junction on Windows, which needs no extra privileges; the type is ignored elsewhere.
    fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");

    const configPath = path.join(configDir, "codegen.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...templateCodegen,
        config: { ...cliDefaults, ...templateCodegen.config, scalars: cliDefaults.scalars },
      }),
    );
    // Resolve the bin script from the package itself: on Windows, node_modules/.bin
    // holds shell and cmd shims rather than symlinks to the JavaScript entry point.
    const cliPackageJson = require.resolve("@graphql-codegen/cli/package.json");
    const bin = path.join(
      path.dirname(cliPackageJson),
      require(cliPackageJson).bin["graphql-code-generator"],
    );
    execFileSync(process.execPath, [bin, "--config", configPath], { cwd: dir, stdio: "pipe" });

    const program = ts.createProgram([path.join(dir, "generated", "api.ts")], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      types: [],
    });
    const errors = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.deepEqual(errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
