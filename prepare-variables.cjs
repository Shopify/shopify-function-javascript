const { plugin: typescriptPlugin } = require('@graphql-codegen/typescript');
const { TypeScriptDocumentsVisitor, plugin: operationsPlugin } = require('@graphql-codegen/typescript-operations');
const ts = require('typescript');
const { mapSchema, MapperKind } = require('@graphql-tools/utils');
const { GraphQLScalarType, GraphQLNonNull, Kind, isObjectType, isScalarType, isNonNullType } = require('graphql');

/**
 * Composes the TypeScript schema and operation generators. Operation types
 * are generated against the original schema; only prepare result fields change.
 *
 * @param {import('graphql').GraphQLSchema} schema
 * @param {import('@graphql-codegen/plugin-helpers').Types.DocumentFile[]} documents
 * @param {object} config
 */
exports.plugin = async function (schema, documents, config, info) {
  if (config.globalNamespace || config.noExport || config.onlyEnums || config.onlyOperationTypes) {
    throw new Error('prepareVariables requires exported schema and operation types (globalNamespace, noExport, onlyEnums and onlyOperationTypes are not supported).');
  }
  const mappings = config.prepareVariables;
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
    throw new Error('prepareVariables must map result fields to named run query operations.');
  }

  const operations = new Map();
  for (const { document } of documents) {
    for (const definition of document?.definitions ?? []) {
      if (definition.kind === Kind.OPERATION_DEFINITION && definition.name) {
        const name = definition.name.value;
        if (operations.has(name)) throw new Error(`Duplicate operation name: ${name}`);
        operations.set(name, definition);
      }
    }
  }

  // Use the same naming logic as typescript-operations, including prefixes,
  // suffixes, namingConvention and omit/dedupeOperationSuffix.
  const visitor = new TypeScriptDocumentsVisitor(schema, config, {
    kind: Kind.DOCUMENT,
    definitions: documents.flatMap(({ document }) => document?.definitions ?? []),
  });
  const overrides = new Map();
  const scalars = { ...config.scalars };
  let index = 0;
  for (const [path, operationName] of Object.entries(mappings)) {
    const parts = path.split('.');
    const type = schema.getType(parts[0]);
    const field = parts.length === 2 && isObjectType(type) && type.getFields()[parts[1]];
    const fieldType = field && (isNonNullType(field.type) ? field.type.ofType : field.type);
    if (!fieldType || !isScalarType(fieldType) || fieldType.name !== 'JSON') {
      throw new Error(`prepareVariables field ${path} must be an object field of type JSON or JSON!.`);
    }
    const operation = operations.get(operationName);
    if (!operation || operation.operation !== 'query') {
      throw new Error(`prepareVariables field ${path} references missing named query ${operationName}. Include its document in codegen.`);
    }
    // Substitute only this field, not every use of the JSON scalar. Delegating
    // to typescript preserves its nullability, readonly and formatting options.
    let scalarName;
    do { scalarName = `ShopifyFunctionPrepareVariables${index++}`; }
    while (schema.getType(scalarName) || Object.hasOwn(scalars, scalarName));
    const variablesType = visitor.convertName(operationName, {
      suffix: visitor.getOperationSuffix(operationName, 'Query') + 'Variables',
    });
    const scalar = new GraphQLScalarType({ name: scalarName });
    overrides.set(path, isNonNullType(field.type) ? new GraphQLNonNull(scalar) : scalar);
    scalars[scalarName] = { input: 'never', output: variablesType };
  }

  const typedSchema = mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (field, fieldName, typeName) => {
      const type = overrides.get(`${typeName}.${fieldName}`);
      return type ? { ...field, type } : undefined;
    },
  });
  const schemaOutput = await typescriptPlugin(typedSchema, documents, { ...config, scalars });
  const operationsOutput = await operationsPlugin(schema, documents, config, info);
  const operationsSource = [...operationsOutput.prepend, operationsOutput.content].filter(Boolean).join('\n');
  const operationNames = declarationNames(operationsSource);
  const schemaSource = [...schemaOutput.prepend, schemaOutput.content].filter(Boolean).join('\n');

  // Codegen 6 operations include the input objects and enums they use. Prefer
  // those definitions (and their enum representation) over the schema copies.
  // Parse declarations rather than editing generated types with regexes.
  const parsed = ts.createSourceFile('schema.ts', schemaSource, ts.ScriptTarget.Latest, true);
  const schemaDeclarations = parsed.statements.filter(statement =>
    !statement.name || !operationNames.has(statement.name.text));
  const printer = ts.createPrinter();
  const combined = schemaDeclarations.map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, parsed)).join('\n')
    + '\n' + operationsSource;
  return deduplicateImports(combined);
};

// Both upstream generators may import the same custom scalar or enum. Prune
// repeated bindings, including overlapping imports such as { A } and { A, B }.
function deduplicateImports(source) {
  const parsed = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true);
  const seen = new Map();
  const printer = ts.createPrinter();
  const keep = (name, origin) => {
    if (!seen.has(name)) { seen.set(name, origin); return true; }
    if (seen.get(name) !== origin) throw new Error(`Conflicting generated import: ${name}`);
    return false;
  };
  return parsed.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) return [statement];
    const clause = statement.importClause;
    const source = statement.moduleSpecifier.text;
    const name = clause.name && keep(clause.name.text, `${source}:default`) ? clause.name : undefined;
    let bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      const elements = bindings.elements.filter(element => keep(element.name.text, `${source}:${element.propertyName?.text ?? element.name.text}`));
      bindings = elements.length ? ts.factory.updateNamedImports(bindings, elements) : undefined;
    } else if (bindings && !keep(bindings.name.text, `${source}:*`)) {
      bindings = undefined;
    }
    if (!name && !bindings) return [];
    return [ts.factory.updateImportDeclaration(statement, statement.modifiers,
      ts.factory.updateImportClause(clause, clause.isTypeOnly, name, bindings),
      statement.moduleSpecifier, statement.attributes)];
  }).map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, parsed)).join('\n');
}

function declarationNames(source) {
  const parsed = ts.createSourceFile('operations.ts', source, ts.ScriptTarget.Latest, true);
  return new Set(parsed.statements.flatMap(statement => statement.name ? [statement.name.text] : []));
}

exports.validate = function (_schema, _documents, _config, _outputFile, plugins) {
  if (plugins.some(plugin => Object.hasOwn(plugin, 'typescript') || Object.hasOwn(plugin, 'typescript-operations'))) {
    throw new Error('Use prepare-variables instead of typescript and typescript-operations, not alongside them.');
  }
};
