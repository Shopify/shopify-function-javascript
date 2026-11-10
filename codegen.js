// A GraphQL Codegen plugin to use instead of `typescript`, with the same output. `customScalarOverrides` maps
// "InputObject.field" to a TypeScript type to use instead of the field's custom scalar, keeping lists and nullability.
const { plugin: typescriptPlugin } = require("@graphql-codegen/typescript");
const {
  Kind,
  buildASTSchema,
  getNamedType,
  isInputObjectType,
  isScalarType,
  isSpecifiedScalarType,
  parse,
  printSchema,
  visit,
} = require("graphql");

exports.plugin = (schema, documents, config) => {
  const overrides = parseOverrides(schema, config.customScalarOverrides);
  if (overrides.length === 0) {
    return typescriptPlugin(schema, documents, config);
  }

  // Each overridden field gets a scalar of its own, mapped to the override's type.
  const taken = new Set([...Object.keys(schema.getTypeMap()), ...Object.keys(config.scalars ?? {})]);
  const scalars = { ...config.scalars };
  const fieldScalars = new Map();
  for (const { typeName, fieldName, type } of overrides) {
    let name = `${typeName}${fieldName[0].toUpperCase()}${fieldName.slice(1)}`;
    while (taken.has(name)) name += "Override";
    taken.add(name);
    scalars[name] = type;
    fieldScalars.set(`${typeName}.${fieldName}`, name);
  }
  return typescriptPlugin(withFieldScalars(schema, fieldScalars), documents, { ...config, scalars });
};

exports.validate = (_schema, _documents, _config, _outputFile, plugins) => {
  if (plugins.some((plugin) => Object.hasOwn(plugin, "typescript"))) {
    throw new Error(
      "@shopify/shopify_function/codegen generates the same types as the typescript plugin. Use it instead of typescript, not with it.",
    );
  }
};

function parseOverrides(schema, overrides = {}) {
  const parsed = [];
  const errors = [];
  for (const [path, type] of Object.entries(overrides)) {
    const [typeName, fieldName, ...rest] = path.split(".");
    const inputObject = schema.getType(typeName);
    const field = rest.length === 0 && isInputObjectType(inputObject) ? inputObject.getFields()[fieldName] : undefined;
    const scalar = field && getNamedType(field.type);
    if (!field) {
      errors.push(`"${path}" isn't a field of an input object.`);
    } else if (!isScalarType(scalar) || isSpecifiedScalarType(scalar)) {
      errors.push(`"${path}" is ${field.type}, not a custom scalar.`);
    } else {
      parsed.push({ typeName, fieldName, type });
    }
  }
  if (errors.length > 0) {
    throw new Error(`customScalarOverrides:\n${errors.map((error) => `  ${error}`).join("\n")}`);
  }
  return parsed;
}

function withFieldScalars(schema, fieldScalars) {
  const retype = (node) => ({
    ...node,
    fields: node.fields?.map((field) => {
      const name = fieldScalars.get(`${node.name.value}.${field.name.value}`);
      return name ? { ...field, type: renameNamedType(field.type, name) } : field;
    }),
  });
  const document = visit(parse(printSchema(schema)), {
    InputObjectTypeDefinition: retype,
    InputObjectTypeExtension: retype,
  });
  const scalarDefinitions = [...fieldScalars.values()].map((name) => ({
    kind: Kind.SCALAR_TYPE_DEFINITION,
    name: { kind: Kind.NAME, value: name },
  }));
  return buildASTSchema(
    { ...document, definitions: [...document.definitions, ...scalarDefinitions] },
    { assumeValidSDL: true },
  );
}

function renameNamedType(type, name) {
  return type.kind === Kind.NAMED_TYPE
    ? { ...type, name: { kind: Kind.NAME, value: name } }
    : { ...type, type: renameNamedType(type.type, name) };
}
