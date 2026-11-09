const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const ts = require('typescript');
const { buildSchema, parse } = require('graphql');
const { codegen } = require('@graphql-codegen/core');
const prepare = require('../prepare-variables.cjs');

const schema = buildSchema(`
  scalar JSON
  enum Mode { STRICT LENIENT }
  input Rule { handle: String!, mode: Mode, children: [Rule!] }
  type PrepareResult { variables: JSON, metadata: JSON }
  type OtherPrepareResult { variables: JSON! }
  type Query { value(handle: String, rules: [Rule!]): String, count: Int }
`);
const documents = [{ document: parse(`
  query Run($handle: String!, $defaulted: String! = "default", $rules: [Rule!], $mode: Mode) {
    value(handle: $handle, rules: $rules)
  }
  query OtherRun($count: Int!) { value }
  query NoVariables { value }
`) }];
const config = {
  defaultScalarType: 'unknown',
  scalars: { JSON: 'unknown' },
  prepareVariables: { 'PrepareResult.variables': 'Run' },
};

function generate(overrides = {}, docs = documents) {
  return codegen({
    filename: 'api.ts', schema, documents: docs,
    config: { ...config, ...overrides },
    plugins: [{ prepare: {} }],
    pluginMap: { prepare },
  });
}

function diagnostics(source, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prepare-variables-'));
  try {
    const file = join(dir, options.allowJs ? 'example.js' : 'example.ts');
    writeFileSync(file, source);
    const program = ts.createProgram([file], {
      strict: true, noEmit: true, skipLibCheck: true,
      target: ts.ScriptTarget.ES2022, types: [], ...options,
    });
    return ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function checkTypes(generated, body) {
  return diagnostics(`${generated}\n${body}`);
}

test('valid variables, omitted defaults, nullable variables, recursive input objects and unrelated JSON', async () => {
  const generated = await generate();
  assert.deepEqual(checkTypes(generated, `
    const valid: PrepareResult = { variables: { handle: 'rules', rules: [{ handle: 'nested', children: [] }] } };
    const nullable: PrepareResult = { variables: { handle: 'rules', mode: null } };
    const omitted: PrepareResult = {};
    const nullVariables: PrepareResult = { variables: null };
    const metadata: PrepareResult = { metadata: { arbitrary: true } };
    const unrelated: OtherPrepareResult = { variables: { anything: 42 } };
  `), []);
  assert.equal(schema.getType('PrepareResult').getFields().variables.type.toString(), 'JSON');
});

test('type checking rejects renamed, missing, retyped, null and invalid nested variables', async () => {
  const generated = await generate();
  for (const variables of [
    `{ handl: 'rules' }`, '{}', '{ handle: 42 }', '{ handle: null }',
    '{ handle: undefined }', `{ handle: 'rules', defaulted: null }`,
    `{ handle: 'rules', mode: 'INVALID' }`,
    `{ handle: 'rules', rules: [{ handle: 42 }] }`,
    `{ handle: 'rules', rules: [null] }`,
    `{ handle: 'rules', rules: [{ handle: 'nested', typo: true }] }`,
  ]) {
    assert.notEqual(checkTypes(generated, `const result: PrepareResult = { variables: ${variables} };`).length, 0, variables);
  }
});

test('run query edits change the prepare contract', async () => {
  for (const declaration of ['$renamed: String!', '$handle: String!, $added: Int!', '$handle: Int!']) {
    const generated = await generate({}, [{ document: parse(`query Run(${declaration}) { value }`) }]);
    assert.notEqual(checkTypes(generated, `const result: PrepareResult = { variables: { handle: 'rules' } };`).length, 0);
  }
});

test('multiple mappings, non-null fields and operations without variables', async () => {
  const generated = await generate({ prepareVariables: {
    'PrepareResult.variables': 'NoVariables', 'OtherPrepareResult.variables': 'OtherRun',
  } });
  assert.deepEqual(checkTypes(generated, `
    const a: PrepareResult = { variables: {} };
    const b: OtherPrepareResult = { variables: { count: 2 } };
  `), []);
  for (const body of [
    `const a: PrepareResult = { variables: { extra: true } };`,
    `const b: OtherPrepareResult = { variables: null };`,
    `const b: OtherPrepareResult = {};`,
  ]) assert.notEqual(checkTypes(generated, body).length, 0);
});

test('uses operation naming options and preserves readonly and nullability options', async () => {
  for (const options of [
    { typesPrefix: 'Api', typesSuffix: 'Type' },
    { omitOperationSuffix: true },
    { dedupeOperationSuffix: true },
    { namingConvention: 'keep' },
    { immutableTypes: true, avoidOptionals: true, maybeValue: 'T | null | undefined' },
  ]) {
    const generated = await generate(options);
    assert.deepEqual(checkTypes(generated, `const result: ${options.typesPrefix ?? ''}PrepareResult${options.typesSuffix ?? ''} = {
      ${options.avoidOptionals ? "__typename: 'PrepareResult', metadata: null," : ''}
      variables: { handle: 'rules', ${options.avoidOptionals ? 'rules: null, mode: null, defaulted: "default",' : ''} }
    };`), [], JSON.stringify(options));
  }
});

test('JavaScript JSDoc returns are checked when checkJs is enabled', async () => {
  const generated = await generate();
  const dir = mkdtempSync(join(tmpdir(), 'prepare-js-'));
  try {
    writeFileSync(join(dir, 'api.ts'), generated);
    const file = join(dir, 'prepare.js');
    writeFileSync(file, `/** @returns {import('./api').PrepareResult} */
      export function prepare() { return { variables: { handl: 'rules' } }; }`);
    const program = ts.createProgram([file], { allowJs: true, checkJs: true, strict: true, noEmit: true, types: [] });
    const errors = ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    assert.ok(errors.some(error => error.includes('handl')), errors.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('custom scalar imports are not duplicated between generators', async () => {
  const generated = await generate({ scalars: { JSON: './custom#JsonValue' } }, [{
    document: parse('query Run($data: JSON) { value }'),
  }]);
  const dir = mkdtempSync(join(tmpdir(), 'prepare-imports-'));
  try {
    writeFileSync(join(dir, 'custom.ts'), 'export type JsonValue = string | { [key: string]: JsonValue };');
    writeFileSync(join(dir, 'api.ts'), generated);
    const program = ts.createProgram([join(dir, 'api.ts')], { strict: true, noEmit: true, types: [] });
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('plugin loads through the codegen CLI using the published package subpath', () => {
  const { symlinkSync, mkdirSync } = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'prepare-cli-'));
  try {
    mkdirSync(join(dir, 'node_modules', '@shopify'), { recursive: true });
    symlinkSync(join(__dirname, '..'), join(dir, 'node_modules', '@shopify', 'shopify_function'), 'dir');
    writeFileSync(join(dir, 'schema.graphql'), `scalar JSON\ntype PrepareResult { variables: JSON }\ntype Query { value(handle: String): String }`);
    writeFileSync(join(dir, 'run.graphql'), 'query Run($handle: String!) { value(handle: $handle) }');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ codegen: {
      schema: 'schema.graphql', documents: 'run.graphql',
      generates: { 'api.ts': { plugins: ['@shopify/shopify_function/prepare-variables.cjs'] } },
      config,
    } }));
    execFileSync(process.execPath, [join(require.resolve('@graphql-codegen/cli'), '..', 'bin.js'), '--config', 'package.json'], { cwd: dir, stdio: 'pipe' });
    const { readFileSync } = require('node:fs');
    const generated = readFileSync(join(dir, 'api.ts'), 'utf8');
    assert.deepEqual(checkTypes(generated, `const result: PrepareResult = { variables: { handle: 'ok' } };`), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid configuration fails early', async () => {
  for (const prepareVariables of [undefined, [], { 'Missing.variables': 'Run' },
    { 'PrepareResult.variables': 'Missing' }, { 'PrepareResult.variables.extra': 'Run' }]) {
    await assert.rejects(generate({ prepareVariables }), /prepareVariables/);
  }
  await assert.rejects(generate({ onlyOperationTypes: true }), /onlyOperationTypes/);
  assert.throws(() => prepare.validate(null, null, null, null, [{ typescript: {} }]), /instead of typescript/);
  assert.throws(() => prepare.validate(null, null, null, null, [{ 'typescript-operations': {} }]), /instead of typescript/);
});
