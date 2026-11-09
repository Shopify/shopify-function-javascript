---
"@shopify/shopify_function": patch
---

Keep generated types compiling when an input query selects an enum field or uses enum or input object variables. Use GraphQL Codegen CLI 6.3.1, `typescript` 5.0.10 and `typescript-operations` 5.1.0: `typescript-operations` 6 re-declares the enums and input objects that the `typescript` plugin already emits into the same file. lodash stays removed.
