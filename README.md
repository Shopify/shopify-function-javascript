# Shopify Function JavaScript

This repository contains the source code for the [`@shopify/shopify_function`][package] npm package.

[package]: https://npm.im/@shopify/shopify_function

## Typed prepare variables

A prepare target returns variables for its run target's input query. By default,
that result field is an untyped JSON scalar. The opt-in
`@shopify/shopify_function/prepare-variables.cjs` codegen plugin gives it the
run operation's generated variables type instead.

### Configure codegen

Replace **both** `typescript` and `typescript-operations` in your function's
`package.json` codegen configuration with this plugin:

```json
{
  "codegen": {
    "schema": "schema.graphql",
    "documents": "src/**/*.graphql",
    "generates": {
      "generated/api.ts": {
        "plugins": ["@shopify/shopify_function/prepare-variables.cjs"]
      }
    },
    "config": {
      "defaultScalarType": "unknown",
      "scalars": { "JSON": "unknown" },
      "prepareVariables": {
        "CartValidationsGeneratePrepareResult.variables": "CartValidationsGenerateRun"
      }
    }
  }
}
```

Mapping keys are schema `Type.field` paths, not target names or export names.
Values are **named GraphQL query operations**, not document filenames. Include
both prepare and run documents in `documents`. Multiple mappings are supported.
The plugin does not read extension TOML or infer prepare/run pairs.

For example, `src/cart_validations_generate_run.graphql` might contain:

```graphql
query CartValidationsGenerateRun($ruleSetHandle: String! = "rules-default") {
  cart {
    validations(handles: [$ruleSetHandle]) {
      title
    }
  }
}
```

After running `shopify app function typegen`, the prepare result's `variables`
field accepts `CartValidationsGenerateRunQueryVariables`. Other JSON fields
remain unchanged. The field retains its schema nullability and optionality.

### Check your prepare implementation

Annotate the return type in TypeScript:

```ts
import type { CartValidationsGeneratePrepareResult } from "../generated/api";

export function cartValidationsGeneratePrepare(): CartValidationsGeneratePrepareResult {
  return { variables: { ruleSetHandle: "rules-custom" } };
}
```

Or use a JSDoc return annotation in JavaScript:

```js
/** @returns {import('../generated/api').CartValidationsGeneratePrepareResult} */
export function cartValidationsGeneratePrepare() {
  return { variables: { ruleSetHandle: "rules-custom" } };
}
```

Run TypeScript checking separately, for example with `tsc --noEmit`. JavaScript
projects also need `allowJs` and `checkJs`; enable `strict` (in particular
`strictNullChecks`) to catch invalid null values.

The generated contract catches missing required variables, incompatible values,
invalid enums and input objects, and unknown keys in object literals. Variables
with defaults can be omitted; a non-null variable with a default still rejects
explicit `null`. GraphQL list input coercion follows the operations generator's
`arrayInputCoercion` option.

**This does not add mandatory build or deploy validation.** The CLI's JavaScript
bundling does not type-check. TypeScript's usual limitations still apply: `any`,
assertions and disabled checking can bypass the contract; structural assignments
can carry extra keys even when fresh object literals would be rejected.

### Compatibility

The plugin composes the package's TypeScript schema and operations generators.
Codegen 6 emits used input objects and enums from the operations generator, so
those declarations take precedence over overlapping schema declarations. Operation
naming options, scalar mappings, readonly types and nullability options are
forwarded to the generators. Do not also list `typescript` or
`typescript-operations` for the same output.

Mapped fields must be `JSON` or `JSON!` on an object type. Anonymous operations
cannot be mapped. `globalNamespace`, `noExport`, `onlyEnums` and
`onlyOperationTypes` are not supported: the plugin needs exported schema and
operation declarations in the same file.

## Development

```sh
npm install
npm test
```

Tests generate types and check valid and invalid prepare results with the
TypeScript compiler, including JavaScript/JSDoc usage.
