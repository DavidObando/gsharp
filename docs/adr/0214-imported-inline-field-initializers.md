# ADR-0214: Imported inline field initializers

- **Status**: Proposed
- **Date**: 2026-10-25
- **Phase**: Compiler correctness
- **Related**: [#5296](https://github.com/DavidObando/gsharp/issues/5296), ADR-0032, ADR-0154

## Context

Public-only, non-generic data struct literals evaluate inline initializers for
omitted fields. An explicit member overrides its declaration initializer without
evaluating that initializer. The existing literal binder implements this contract
for source-local types.

Imported aggregates reconstruct collection zero values, but cannot reconstruct
arbitrary initializer expressions from fields alone. Their literals silently lose
nonzero defaults. Calling a constructor instead would change initializer
selection and evaluation order, and could execute an authored constructor body.

## Decision

Preserve initializer expressions in compiler-generated static methods on the
declaring data struct. Use the existing initialization planner, function-body
pipeline, and method emitter. Each method returns one explicit field initializer.
Its reserved metadata name is `<>fieldInitializer$` followed by the field name.
The method is public for cross-assembly calls and has the CLR `SpecialName` flag.
It is not a source member or an imported source-visible static method.

Generate methods in field declaration order, only for source data structs whose
literal initializers do not require an owning constructor. Existing generic,
primary-constructor, non-public-storage, and collection-zero protocols stay
unchanged. Do not export another method for an implicit collection zero value.

When reconstructing an imported aggregate, represent each method as an existing
bound CLR static call in its field-initializer map. Let the existing literal
binder select omitted fields and preserve evaluation order. Use collection-zero
reconstruction only when no initializer method exists for that field.

## Consequences

Separate producer and consumer assemblies preserve source-local literal behavior.
Initializer expressions retain access to private declaring-type members. Their
normal lowering supports nonconstant values without serialized bound expressions.
Repeated compilation reuses generated method symbols without losing their bodies.

Both projects must use the corrected compiler. Older producer assemblies do not
contain recoverable arbitrary initializer expressions. Their existing collection
markers remain supported. Raw defaults, array elements, authored constructor
calls, and primary positional defaults do not change.

ADR-0154 coverage uses separate G# producer and consumer invocations of the real
compiler driver, IL verification, and exact runtime-output assertions. It covers
the reported defaults, explicit overrides, evaluation order, private calls, and
explicit collection initializers.

## Alternatives considered

- Call the default constructor: changes omitted-only evaluation and may execute
  an authored body.
- Serialize initializer syntax or bound trees: duplicates binding and lowering,
  and cannot safely recover the declaring scope.
- Export constant values only: leaves effectful and other nonconstant
  initializers silently incorrect.
