#!/usr/bin/env node
// Shopify CLI runs this, when the package has it, before bundling a JavaScript function:
//
//   node check.js --function <function JSON>
//
// The function JSON is {handle, directory, entry, schema, targets: [{target, export, inputQuery}]}, where `export` is
// the JavaScript function the CLI bundles. It exits non-zero, failing the build, when a prepare target returns
// variables its run query doesn't accept, and warns about variables it can't check.
const fs = require("node:fs");
const { parseArgs } = require("node:util");
const { prepareVariablesProblems } = require("./prepare-variables.js");

try {
  const { values } = parseArgs({ options: { function: { type: "string" } } });
  if (!values.function) throw new Error("Usage: check.js --function <function JSON>");
  const fn = { schema: "schema.graphql", targets: [], ...JSON.parse(fs.readFileSync(values.function, "utf8")) };
  const problems = prepareVariablesProblems(fn);
  const name = fn.handle ? `The function extension "${fn.handle}"` : "The function";
  const list = (warning) => problems.filter((problem) => problem.warning === warning).map((problem) => problem.message);

  const warnings = list(true);
  if (warnings.length > 0) {
    console.warn(`${name} returns prepare variables that can't be checked against its run query\n${warnings.join("\n")}`);
  }
  const errors = list(false);
  if (errors.length > 0) {
    throw new Error(`${name} returns prepare variables its run query doesn't accept\n${errors.join("\n")}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
