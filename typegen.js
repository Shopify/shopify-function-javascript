#!/usr/bin/env node
// Shopify CLI runs this instead of graphql-code-generator when the package has it:
//
//   node typegen.js --config <codegen config> --function <function JSON>
//
// The function JSON is {handle, directory, entry, schema, targets: [{target, export, inputQuery}]}, where `export` is
// the JavaScript function the CLI bundles. It exits non-zero when codegen fails or a prepare target returns variables
// its run query doesn't accept.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { parseArgs } = require("node:util");
const { createContext, generate } = require("@graphql-codegen/cli");
const { prepareVariablesErrors } = require("./prepare-variables.js");

async function main(args) {
  const { values } = parseArgs({ args, options: { config: { type: "string" }, function: { type: "string" } } });
  if (!values.config || !values.function) throw new Error("Usage: typegen.js --config <codegen config> --function <function JSON>");
  const fn = { schema: "schema.graphql", targets: [], ...JSON.parse(fs.readFileSync(values.function, "utf8")) };

  const context = await createContext({ config: values.config });
  const config = context.getConfig();
  context.updateConfig({
    // Errors are reported on stderr, so codegen's progress output would only repeat them
    silent: true,
    pluginLoader: pluginLoader(fn.directory),
  });
  await generate(context);

  const errors = prepareVariablesErrors({
    ...fn,
    scalars: config.config?.scalars,
    defaultScalarType: config.config?.defaultScalarType,
  });
  if (errors.length > 0) {
    const name = fn.handle ? `The function extension "${fn.handle}"` : "The function";
    throw new Error(`${name} returns prepare variables its run query doesn't accept\n${errors.join("\n")}`);
  }
}

// Loads plugins from this package first, so the versions it pins run, whatever the package manager hoists.
function pluginLoader(directory) {
  const fromPackage = createRequire(__filename);
  const fromFunction = createRequire(path.join(directory, "package.json"));
  return (name) => {
    try {
      return fromPackage(name);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
    return fromFunction(name);
  };
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
