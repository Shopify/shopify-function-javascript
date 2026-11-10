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
const { TypeScriptDocumentsVisitor } = require("@graphql-codegen/typescript-operations");
const { Kind, buildSchema, getNamedType, isInputObjectType, isScalarType, isSpecifiedScalarType, parse } = require("graphql");
const codegenPlugin = require("./codegen.js");
const { preparePairs, prepareVariablesErrors } = require("./prepare-variables.js");

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
    generates: withPrepareVariableTypes(config, fn),
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
  // As `typescript`, it replaces that plugin, so it skips the check against using both.
  const asTypescript = { plugin: codegenPlugin.plugin };
  return (name) => {
    if (name === "@graphql-codegen/typescript") return asTypescript;
    if (name === "@shopify/shopify_function/codegen") return codegenPlugin;
    try {
      return fromPackage(name);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
    return fromFunction(name);
  };
}

// Gives each prepare result's `variables` its run query's variables type, in outputs with both plugins. Overrides in
// the config win.
function withPrepareVariableTypes(config, fn) {
  const schema = buildSchema(fs.readFileSync(path.resolve(fn.directory, fn.schema), "utf8"));
  const entries = Object.entries(config.generates ?? {}).map(([file, output]) => {
    const { plugins = [], config: outputConfig = {}, ...rest } = Array.isArray(output) ? { plugins: output } : output;
    const names = plugins.map((plugin) => (typeof plugin === "string" ? plugin : Object.keys(plugin)[0]));
    if (!names.includes("typescript-operations") || !names.some((name) => name === "typescript" || name === "@shopify/shopify_function/codegen")) {
      return [file, output];
    }
    const overrides = {
      ...prepareVariableTypes(schema, fn, { ...config.config, ...outputConfig }),
      ...config.config?.customScalarOverrides,
      ...outputConfig.customScalarOverrides,
    };
    return [file, { ...rest, plugins, config: { ...outputConfig, customScalarOverrides: overrides } }];
  });
  return Object.fromEntries(entries);
}

function prepareVariableTypes(schema, fn, config) {
  const visitor = new TypeScriptDocumentsVisitor(schema, config, []);
  const overrides = {};
  for (const { target, query } of preparePairs(fn.targets)) {
    // The schema describes the field the result is passed to as handling the target's result
    const field = Object.values(schema.getMutationType()?.getFields() ?? {}).find((candidate) =>
      candidate.description?.includes(` ${target} `),
    );
    const result = field?.args[0] && getNamedType(field.args[0].type);
    const variables = isInputObjectType(result) ? result.getFields().variables : undefined;
    const scalar = variables && getNamedType(variables.type);
    if (!isScalarType(scalar) || isSpecifiedScalarType(scalar)) continue;

    const operation = parse(fs.readFileSync(path.resolve(fn.directory, query), "utf8")).definitions.find(
      (definition) => definition.kind === Kind.OPERATION_DEFINITION,
    );
    if (!operation?.name) continue;
    const name = operation.name.value;
    overrides[`${result.name}.variables`] = visitor.convertName(name, {
      suffix: `${visitor.getOperationSuffix(name, "Query")}Variables`,
    });
  }
  return overrides;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
