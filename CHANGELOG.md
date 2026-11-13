# @shopify/shopify_function

## 2.0.2

### Patch Changes

- 7f41037: Fix type errors in generated types when an input query uses enums or input objects. `typescript-operations` 6 re-declares the enums and input objects that the `typescript` plugin already writes to the same file, so this uses GraphQL Codegen CLI 6.3.1, `typescript` 5.0.10 and `typescript-operations` 5.1.0 instead. lodash stays removed.
- 68a515a: Remove the vulnerable lodash dependency from the GraphQL code generation toolchain.

## 2.0.1

### Patch Changes

- d029dea: fix pnpm graphql package duplication
