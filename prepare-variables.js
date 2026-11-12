// Checks what each prepare target's export returns against the variables its run target's input query declares.
// Type annotations and casts are ignored, and values are followed back to where they're created. Values that can't be
// followed are warnings rather than passes.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const {
  GraphQLInputObjectType,
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLNonNull,
  GraphQLScalarType,
  GraphQLString,
  Kind,
  buildSchema,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isScalarType,
  isSpecifiedScalarType,
  parse,
  typeFromAST,
} = require("graphql");

const unknownScalar = new GraphQLScalarType({ name: "Unknown" });

// The TypeScript type Shopify CLI's codegen config gives each custom scalar, which a function's config can change
const codegenScalars = {
  Date: "string",
  DateTime: "string",
  DateTimeWithoutTimezone: "string",
  Decimal: "string",
  Handle: "string",
  JSON: "unknown",
  TimeWithoutTimezone: "string",
  URL: "string",
  Void: "null",
};
const scalarsByType = { string: GraphQLString, number: GraphQLFloat, boolean: GraphQLBoolean };

/** The prepare targets whose run target has an input query. */
function preparePairs(targets) {
  return targets.flatMap(({ target, export: name }) => {
    const run = targets.find((other) => other.target === target.replace(/\.prepare$/, ".run"));
    return target.endsWith(".prepare") && name && run?.inputQuery ? [{ target, name, query: run.inputQuery }] : [];
  });
}

/**
 * Returns `{message, warning}` for each problem, where `message` is `file:line:column message`, relative to `directory`.
 * Values that can't be checked are warnings, and mismatches are errors. `scalars` is the function's codegen config.
 */
function prepareVariablesProblems({ directory, entry: entryPath, schema: schemaPath, targets, scalars = {} }) {
  const scalarTypes = { ...codegenScalars };
  for (const [name, type] of Object.entries(scalars)) scalarTypes[name] = typeof type === "object" ? type?.input : type;
  const pairs = preparePairs(targets);
  if (pairs.length === 0) return [];
  if (!entryPath) {
    return [{ message: "The function has no entry file, such as src/index.js, to check its prepare targets in", warning: false }];
  }
  const entry = path.resolve(directory, entryPath);
  // Paths in messages use forward slashes, as Shopify CLI's do, on Windows too
  const relative = (file) => path.relative(directory, file).split(path.sep).join("/");

  const schema = buildSchema(fs.readFileSync(path.resolve(directory, schemaPath), "utf8"));
  const options = {
    allowJs: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2022.d.ts"],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // An element of an array, like `list[0]`, can be undefined
    noUncheckedIndexedAccess: true,
  };
  const host = ts.createCompilerHost(options, true);
  // Annotations and casts are claims nothing checks against the value (`@ts-ignore` silences the compiler), so they're
  // blanked out of the function's own files, leaving types to come from the values. Parameter types and non-null
  // assertions (`!`, like Rust's `unwrap`) are kept. Blanking keeps positions, so errors point at the original source.
  const { getSourceFile } = host;
  host.getSourceFile = (fileName, language, ...rest) => {
    const file = getSourceFile(fileName, language, ...rest);
    if (!file || file.isDeclarationFile || fileName.includes("/node_modules/")) return file;
    const text = file.text.split("");
    const blank = (start, end) => {
      for (let index = start; index < end; index++) if (text[index] !== "\n" && text[index] !== "\r") text[index] = " ";
    };
    const visit = (node) => {
      for (const tag of ts.getJSDocTags(node)) {
        const typing =
          ts.isJSDocTypeTag(tag) || ts.isJSDocReturnTag(tag) || ts.isJSDocSatisfiesTag(tag) || ts.isJSDocOverloadTag(tag);
        if (typing && !ts.isParameter(tag.parent.parent)) blank(tag.pos, tag.end);
      }
      if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
        blank(node.expression.end, node.end);
      } else if (ts.isTypeAssertionExpression(node)) {
        blank(node.type.pos - 1, node.expression.pos);
      } else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.typeArguments) {
        blank(node.typeArguments.pos - 1, node.typeArguments.end + 1);
      } else if (
        (ts.isVariableDeclaration(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isGetAccessorDeclaration(node)) &&
        node.type
      ) {
        blank(node.type.pos - 1, node.type.end);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return ts.createSourceFile(fileName, text.join(""), language);
  };
  const program = ts.createProgram([entry], options, host);
  // A syntax error stops the check. The bundler reports it too, unless the bundle leaves the file out, such as one
  // only imported with `import type`.
  const local = program.getSourceFiles().filter((file) => !file.isDeclarationFile && !program.isSourceFileFromExternalLibrary(file));
  const syntaxErrors = local.flatMap((file) => program.getSyntacticDiagnostics(file).slice(0, 1));
  if (syntaxErrors.length > 0) {
    return syntaxErrors.map(({ file, start, messageText }) => {
      const { line, character } = file.getLineAndCharacterOfPosition(start);
      const error = ts.flattenDiagnosticMessageText(messageText, " ");
      return { message: `${relative(file.fileName)}:${line + 1}:${character + 1} can't be checked because of a syntax error: ${error}`, warning: true };
    });
  }
  const checker = program.getTypeChecker();
  const entryFile = program.getSourceFile(entry);
  const entrySymbol = entryFile && checker.getSymbolAtLocation(entryFile);
  const problems = new Map();
  let muted = false;

  const report = (node, message, warning = false) => {
    if (muted) return;
    const file = node.getSourceFile();
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart());
    problems.set(`${relative(file.fileName)}:${line + 1}:${character + 1} ${message}`, warning);
  };
  const join = (base, key) => (base ? `${base}.${key}` : key);
  const subject = (at) => (at ? `\`${at}\`` : "The result");
  // A type parameter, such as `T` in a generic helper, can be anything
  const generic = (type) =>
    Boolean(type.flags & ts.TypeFlags.InstantiableNonPrimitive) || (type.isIntersection() && type.types.some(generic));
  const unchecked = (type) => Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || generic(type);

  const unwrap = (node) => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);

  const functionOf = (node) => {
    if (!node) return;
    if (ts.isVariableDeclaration(node)) return node.initializer && functionOf(unwrap(node.initializer));
    const local =
      !node.getSourceFile().isDeclarationFile && !program.isSourceFileFromExternalLibrary(node.getSourceFile());
    if (local && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
      return node.body && node;
    }
  };

  const symbolOf = (node) =>
    ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);

  // A reference that could change the value after it's created: assigning to it or a member, deleting or
  // incrementing a member, calling a method on it, or passing, aliasing or reassigning the binding itself.
  // An assignment with a written-out key, `object.key = value` or `object["key"] = value`, to a reference to the object
  const functionAround = (node) => ts.findAncestor(node.parent, ts.isFunctionLike);

  const assignmentOf = (reference) => {
    const access = reference.parent;
    const assignment = access.parent;
    const direct = (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) && access.expression === reference;
    if (!direct || !ts.isBinaryExpression(assignment) || assignment.left !== access) return;
    if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const name = ts.isPropertyAccessExpression(access) ? access.name : access.argumentExpression;
    const key = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
    return key === undefined ? undefined : { key, name, value: assignment.right, node: assignment };
  };

  const changes = (reference) => {
    let top = reference;
    while (
      (ts.isPropertyAccessExpression(top.parent) || ts.isElementAccessExpression(top.parent)) &&
      top.parent.expression === top
    ) {
      top = top.parent;
    }
    const { parent } = top;
    if (top === reference) {
      return !(ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent) || ts.isTypeOfExpression(parent));
    }
    return (
      (ts.isBinaryExpression(parent) &&
        parent.left === top &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ts.isDeleteExpression(parent) ||
      ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isCallExpression(parent) && parent.expression === top)
    );
  };

  for (const { target, name, query } of pairs) {
    const queryPath = path.resolve(directory, query);
    const queryName = relative(queryPath);
    const operation = parse(fs.readFileSync(queryPath, "utf8")).definitions.find(
      (definition) => definition.kind === Kind.OPERATION_DEFINITION,
    );
    const variables = new GraphQLInputObjectType({
      name: "Variables",
      fields: Object.fromEntries(
        (operation?.variableDefinitions ?? []).map((definition) => [
          definition.variable.name.value,
          // A type the schema doesn't have is left to codegen, which reports it
          { type: typeFromAST(schema, definition.type) ?? unknownScalar, defaultValue: definition.defaultValue },
        ]),
      ),
    });
    // The prepare target's result type, from its mutation field such as `cartValidationsGeneratePrepare(result: …)`, with
    // `variables` typed as the run query's variables, as the Rust override does. Without one, it only has `variables`.
    const field = schema.getMutationType()?.getFields()[target.replace(/[.-](\w)/g, (_, letter) => letter.toUpperCase())];
    const schemaResult = field && getNamedType(field.args.find((argument) => argument.name === "result")?.type);
    const result = new GraphQLInputObjectType({
      name: isInputObjectType(schemaResult) ? schemaResult.name : "PrepareResult",
      fields: {
        ...(isInputObjectType(schemaResult) ? schemaResult.toConfig().fields : {}),
        variables: { type: new GraphQLNonNull(variables) },
      },
    });
    const owner = (type) => (type === variables ? `declared by ${queryName}` : `a field of ${type.name}`);
    const followed = new Map();
    const checkedReferences = new Set();
    const visiting = new Set();
    const changed = new Map();
    const assigned = new Map();
    const passed = new Map();
    const returning = [];
    // An assignment after the return being checked doesn't change what it returns, unless a loop around both runs it first
    const beforeReturn = ({ node }) => {
      const fn = functionAround(node);
      const statement = returning.findLast((candidate) => functionAround(candidate) === fn);
      if (!statement || node.pos < statement.end) return true;
      const loop = ts.findAncestor(statement, (ancestor) => (ancestor === fn ? "quit" : ts.isIterationStatement(ancestor, false)));
      return Boolean(loop && node.end <= loop.end);
    };

    // The variable an object literal property is written in, such as `variables` in `const variables = {a: 1}`
    const bindingOf = (property) => {
      const declaration = property.valueDeclaration;
      const assignment =
        declaration && (ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration));
      const binding = assignment && declaration.parent.parent;
      return binding && ts.isVariableDeclaration(binding) && ts.isIdentifier(binding.name) ? binding : undefined;
    };
    // A variable changed or passed on after it's created may not hold what it was created with, so it's not checked
    // An object assigned to by name is checked with its assignments, but only where it's created
    const skipChanged = (declaration, at, node) => {
      const assignments = assigned.get(declaration);
      const changes = changed.get(declaration) ?? (assignments && assignments.object !== node ? assignments.nodes : undefined);
      for (const node of changes ?? []) {
        report(node, `${subject(at)} is changed or passed on after it's created, so it can't be checked`, true);
      }
      return Boolean(changes);
    };

    // Whether a built-in scalar or an enum accepts a value, by GraphQL's own coercion: "yes", "no", or "maybe" when it
    // depends on which of its type's values it is. A type like `number` is tried with one of its values.
    const scalarMatch = (type, named) => {
      const accepts = (value) => {
        try {
          return named.parseValue(value) !== undefined;
        } catch {
          return false;
        }
      };
      if (type.isStringLiteral() || type.isNumberLiteral()) return accepts(type.value) ? "yes" : "no";
      if (type.flags & ts.TypeFlags.BooleanLiteral) return accepts(type === checker.getTrueType()) ? "yes" : "no";
      if (type.flags & ts.TypeFlags.StringLike) return isEnumType(named) ? "maybe" : accepts("") ? "yes" : "no";
      if (type.flags & ts.TypeFlags.NumberLike) return accepts(0) ? "yes" : "no";
      return "no";
    };

    const typed = (type, expected, at, omittable, node) => {
      const named = getNamedType(expected);
      // A custom scalar is checked as the TypeScript type codegen gives it, so a `Handle` is a string. The server
      // decides what other ones, such as JSON, accept, but not whether they can be null or a list.
      const custom = isScalarType(named) && !isSpecifiedScalarType(named);
      const codegenType = custom ? scalarTypes[named.name] : undefined;
      const loose = custom && codegenType !== "null" && !scalarsByType[codegenType];
      if (unchecked(type)) {
        if (!loose) report(node, `${subject(at)} is typed ${checker.typeToString(type)}, so it can't be checked`, true);
        return;
      }
      if (type.isUnion()) return type.types.forEach((member) => typed(member, expected, at, omittable, node));
      if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
        if (isNonNullType(expected) && !omittable) report(node, `${subject(at)} can be undefined, but ${expected} has no default`);
        return;
      }
      if (type.flags & ts.TypeFlags.Null) {
        if (isNonNullType(expected)) report(node, `${subject(at)} can be null, but ${expected} can't`);
        return;
      }
      const inner = isNonNullType(expected) ? expected.ofType : expected;
      if (isListType(inner)) {
        const element =
          (checker.isArrayType(type) || checker.isTupleType(type)) && checker.getIndexTypeOfType(type, ts.IndexKind.Number);
        return element ? typed(element, inner.ofType, `${at}[]`, false, node) : typed(type, inner.ofType, at, false, node);
      }
      // An intersection, such as what Object.assign returns, is checked like an object
      if (isInputObjectType(inner) && (type.flags & ts.TypeFlags.Object || type.isIntersection()) && !checker.isArrayType(type)) {
        if (checker.getIndexInfosOfType(type).length > 0) {
          return report(node, `${subject(at)} can have any keys, so it can't be checked`, true);
        }
        const properties = checker.getPropertiesOfType(type);
        const bindings = new Set(properties.map(bindingOf).filter(Boolean));
        // A spread object adds what it holds when it's spread, which may not be what it was created with
        for (const spread of ts.isObjectLiteralExpression(node) ? node.properties.filter(ts.isSpreadAssignment) : []) {
          const expression = unwrap(spread.expression);
          const declaration = ts.isIdentifier(expression) && symbolOf(expression)?.valueDeclaration;
          if (declaration && ts.isVariableDeclaration(declaration)) {
            followed.set(declaration, at);
            bindings.add(declaration);
          }
          const spreadType = checker.getTypeAtLocation(spread.expression);
          if (unchecked(spreadType) || checker.getIndexInfosOfType(spreadType).length > 0) {
            return report(spread, `${subject(at)} spreads an object that can have any keys, so it can't be checked`, true);
          }
        }
        if ([...bindings].map((binding) => skipChanged(binding, at, node)).some(Boolean)) return;
        const fields = inner.getFields();
        // A oneOf input object takes exactly one of its fields, which can't be null
        const fieldType = (field) => (inner.isOneOf ? new GraphQLNonNull(field.type) : field.type);
        const assignments = ([...assigned.values()].find((candidate) => candidate.object === node)?.assignments ?? []).filter(
          beforeReturn,
        );
        const assignedKeys = new Set(assignments.map((assignment) => assignment.key));
        for (const property of properties) {
          // A property assigned after the object is created is checked with its assignments
          if (assignedKeys.has(property.name)) continue;
          const field = fields[property.name];
          const key = join(at, property.name);
          // A property written in an object literal is followed to its value, keeping literal types (like an enum
          // value) that the object's type widens. A key written twice has its last value.
          const declaration = property.declarations?.at(-1) ?? property.valueDeclaration;
          const assignment =
            declaration && (ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration))
              ? declaration
              : undefined;
          if (!field) {
            report(assignment ?? node, `${subject(key)} isn't ${owner(inner)}`);
          } else if (assignment) {
            const binding = bindingOf(property);
            if (binding) followed.set(binding, at);
            const initializer = ts.isPropertyAssignment(assignment) ? assignment.initializer : assignment.name;
            value(initializer, fieldType(field), key, field.defaultValue !== undefined);
          } else {
            typed(checker.getTypeOfSymbol(property), fieldType(field), key, field.defaultValue !== undefined, node);
          }
        }
        for (const { key, name, value: assignedValue } of assignments) {
          const field = fields[key];
          if (!field) report(name, `${subject(join(at, key))} isn't ${owner(inner)}`);
          else value(assignedValue, fieldType(field), join(at, key), field.defaultValue !== undefined);
        }
        const keys = new Set([...properties.map((property) => property.name), ...assignedKeys]);
        if (inner.isOneOf && keys.size !== 1) {
          const optional = properties.some((property) => property.flags & ts.SymbolFlags.Optional);
          if (optional && keys.size > 1) report(node, `${subject(at)} may set more than one field of ${inner}, so it can't be checked`, true);
          else report(node, `${subject(at)} must set exactly one field of ${inner}`);
        }
        for (const [key, field] of Object.entries(fields)) {
          if (!isNonNullType(field.type) || field.defaultValue !== undefined || checker.getPropertyOfType(type, key)) continue;
          const setBy = assignments.filter((assignment) => assignment.key === key);
          if (setBy.some((assignment) => assignment.always)) continue;
          if (setBy.length > 0) report(setBy[0].name, `${subject(join(at, key))} is only set on some paths, so it can't be checked`, true);
          else report(node, `${subject(join(at, key))} is missing, and ${field.type} has no default`);
        }
        return;
      }
      if (loose) return;
      const match = isInputObjectType(inner) || codegenType === "null" ? "no" : scalarMatch(type, scalarsByType[codegenType] ?? inner);
      if (match === "no") {
        report(node, `${subject(at)} must be ${expected}, not ${checker.typeToString(type)}`);
      } else if (match === "maybe") {
        report(node, `${subject(at)} is ${checker.typeToString(type)}, which ${inner} may not accept, so it can't be checked`, true);
      }
    };

    const returns = (fn, expected, at, omittable) => {
      const body = fn.body;
      if (!body) return;
      if (!ts.isBlock(body)) return value(body, expected, at, omittable);
      const visit = (node) => {
        if (ts.isReturnStatement(node)) {
          returning.push(node);
          if (node.expression) value(node.expression, expected, at, omittable);
          else typed(checker.getUndefinedType(), expected, at, omittable, node);
          returning.pop();
        } else if (!ts.isFunctionLike(node)) {
          ts.forEachChild(node, visit);
        }
      };
      ts.forEachChild(body, visit);
    };

    const value = (node, expected, at, omittable) => {
      const expression = unwrap(node);
      const inner = isNonNullType(expected) ? expected.ofType : expected;

      if (ts.isIdentifier(expression)) {
        const declaration = symbolOf(expression)?.valueDeclaration;
        // A helper's parameter holds what the call passes for it
        if (declaration && passed.has(declaration)) return value(passed.get(declaration), expected, at, omittable);
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
          followed.set(declaration, at);
          checkedReferences.add(expression);
          if (skipChanged(declaration, at, unwrap(declaration.initializer))) return;
          return value(declaration.initializer, expected, at, omittable);
        }
      } else if (ts.isConditionalExpression(expression)) {
        value(expression.whenTrue, expected, at, omittable);
        return value(expression.whenFalse, expected, at, omittable);
      } else if (
        ts.isBinaryExpression(expression) &&
        (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      ) {
        // `??` uses the left side unless it's null or undefined, and `||` only when it's truthy
        const or = expression.operatorToken.kind === ts.SyntaxKind.BarBarToken;
        const left = checker.getTypeAtLocation(expression.left);
        for (const member of left.isUnion() ? left.types : [left]) {
          if (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) continue;
          if (or && (member === checker.getFalseType() || ((member.isStringLiteral() || member.isNumberLiteral()) && !member.value))) continue;
          typed(member, expected, at, omittable, expression.left);
        }
        return value(expression.right, expected, at, omittable);
      } else if (ts.isCallExpression(expression)) {
        const fn = functionOf(checker.getResolvedSignature(expression)?.declaration);
        // A generic helper is checked by what its call returns, where its type parameters are known
        if (fn?.typeParameters) return typed(checker.getTypeAtLocation(expression), expected, at, omittable, expression);
        if (fn && !visiting.has(fn)) {
          visiting.add(fn);
          const spread = expression.arguments.some(ts.isSpreadElement);
          fn.parameters.forEach((parameter, index) => {
            const argument = expression.arguments[index] ?? parameter.initializer;
            if (!spread && argument && ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken) passed.set(parameter, argument);
          });
          returns(fn, expected, at, omittable);
          fn.parameters.forEach((parameter) => passed.delete(parameter));
          visiting.delete(fn);
          return;
        }
      } else if (ts.isArrayLiteralExpression(expression) && isListType(inner)) {
        for (const element of expression.elements) {
          if (ts.isSpreadElement(element)) typed(checker.getTypeAtLocation(element), expected, at, omittable, element);
          else value(element, inner.ofType, `${at}[]`, false);
        }
        return;
      }
      typed(checker.getTypeAtLocation(expression), expected, at, omittable, expression);
    };

    const exported = entrySymbol && checker.getExportsOfModule(entrySymbol).find((symbol) => symbol.name === name);
    const resolved = exported && (exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported);
    const fn = functionOf(resolved?.valueDeclaration);
    if (fn && fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      report(fn, `\`${name}\` is async, so it returns a promise instead of its result`);
      continue;
    }
    if (!fn) {
      // The bundler reports a missing export
      if (resolved?.valueDeclaration) {
        report(resolved.valueDeclaration, `\`${name}\` isn't a function it can follow, so it can't be checked`, true);
      }
      continue;
    }
    // The first pass finds the variables the result is built from, and the second checks it, skipping the ones
    // changed after they're created
    muted = true;
    returns(fn, new GraphQLNonNull(result), "", false);
    muted = false;
    for (const declaration of followed.keys()) {
      const symbol = checker.getSymbolAtLocation(declaration.name);
      const nodes = [];
      const visit = (node) => {
        if (
          ts.isIdentifier(node) &&
          node !== declaration.name &&
          !checkedReferences.has(node) &&
          symbolOf(node) === symbol &&
          changes(node)
        ) {
          nodes.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(declaration.getSourceFile());
      if (nodes.length === 0) continue;
      const object = unwrap(declaration.initializer);
      const assignments = nodes.map(assignmentOf);
      // An assignment in a nested function, such as a callback, may run at any time or not at all
      const nested = nodes.some((node) => functionAround(node) !== functionAround(declaration));
      if (ts.isObjectLiteralExpression(object) && assignments.every(Boolean) && !nested) {
        // An assignment in the block the object is created in always runs, unlike one in an `if`, loop or callback
        const block = declaration.parent.parent.parent;
        for (const assignment of assignments) {
          assignment.always = ts.isExpressionStatement(assignment.node.parent) && assignment.node.parent.parent === block;
        }
        assigned.set(declaration, { object, nodes, assignments });
      } else {
        changed.set(declaration, nodes);
      }
    }
    visiting.clear();
    followed.clear();
    returns(fn, new GraphQLNonNull(result), "", false);
  }

  return [...problems].map(([message, warning]) => ({ message, warning }));
}

module.exports = { prepareVariablesProblems };
