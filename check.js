#!/usr/bin/env node
// Shopify CLI runs this, when the package has it, before bundling a JavaScript function:
//
//   node check.js --function <function JSON>
//
// The function JSON is {handle, directory, entry, schema, targets: [{target, export, inputQuery}]}, where `export` is
// the JavaScript function the CLI bundles. It exits non-zero, failing the build, when a prepare target returns
// variables its run query doesn't accept, and warns about variables it can't check.
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { prepareVariablesProblems } = require("./prepare-variables.js");

try {
  const { values } = parseArgs({ options: { function: { type: "string" } } });
  if (!values.function) throw new Error("Usage: check.js --function <function JSON>");
  const fn = { schema: "schema.graphql", targets: [], ...JSON.parse(fs.readFileSync(values.function, "utf8")) };
  const name = fn.handle ? `The function extension "${fn.handle}"` : "The function";
  let problems;
  try {
    problems = prepareVariablesProblems({ ...fn, scalars: codegenScalars(fn.directory) });
  } catch (error) {
    // A problem in the check itself shouldn't stop the build
    console.warn(`${name}'s prepare variables couldn't be checked: ${error.message}`);
    problems = [];
  }
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

// The scalars in the function's codegen config, which Shopify CLI merges with its own
function codegenScalars(directory) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).codegen?.config?.scalars ?? {};
  } catch {
    return {};
  }
}
