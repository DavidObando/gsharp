# ADR-0220: Constant provenance and reference null values

- **Status**: Proposed
- **Date**: 2026-11-07
- **Issues**: [#5805](https://github.com/DavidObando/gsharp/issues/5805),
  [#5823](https://github.com/DavidObando/gsharp/issues/5823),
  [#5825](https://github.com/DavidObando/gsharp/issues/5825)
- **Related**: [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md),
  [ADR-0193](0193-nullability-queries-are-type-level-and-funnelled.md),
  [ADR-0208](0208-narrowing-as-flow-state-with-a-query.md),
  [ADR-0154](0154-test-oracle-strength.md)

## Context

An explicit boxing conversion and a pattern input conversion can have the same target type.
Unwrapping both loses the user's equality semantics.
CLR decimal constants use attribute metadata rather than the primitive Constant table.
A source reference type can lack a runtime `Type` while its constant value is known to be null.

## Decision

1. Mark only the conversion that the pattern binder adds to the input type.
   Preserve this marker through ordinary rewrites and asynchronous spills.
   Equality emission and R19 effects consume the same classification.
   Explicit boxing therefore retains `object.Equals`, including its NaN behavior and possible user-code call.
   An implicitly boxed floating-point pattern retains its type guard and primitive comparison.
2. Read imported decimal constant attributes without reading runtime field storage.
   Decode both signed and unsigned attribute constructor payloads.
   Ordinary readonly fields without constant metadata remain nonconstant.
   Loop effects use the same metadata constant decision and do not execute attributed field initializers.
   Folded imported field literals retain the selected field metadata for semantic queries and language-server navigation.
   Continue emitting decimal constants through initialized readonly storage and `DecimalConstantAttribute`.
   Preserve their scale and zero sign during runtime materialization.
3. Admit reference null constants in fields and locals, including reference defaults.
   Keep their CLR representation null and inline null reads.
   A known null constant cannot establish an explicitly non-null declaration type.
   Use the type-level `ForNullConstant` operation to make that declaration nullable.
   Apply this operation after every initializer path, before establishing declaration and flow facts.
   Statement and loop pattern effects recognize known null field, local, and global constants through one symbol predicate.
   Null recognition stops at conversions that materialize pointers or function pointers.
   Loop constant-read provenance remains separate from type-origin paths.
   Reassigned or copied mutable locals cannot inherit a constant's null value from their type origin.
   Existing nullable and platform wrappers retain their distinct kinds.
   Do not permit non-null, non-string reference constants.
   Preserve existing named local function-literal `const` bindings; these are not CLR field constants.
   Do not widen the ordinary `nil` conversion rule or add nullable-value constant declarations.

## Existing coverage gaps

Region-local null constant patterns still report false `GS0158` on safe captured-local reads.
The class and string reproductions fail identically before and after these changes.
[Issue #5881](https://github.com/DavidObando/gsharp/issues/5881) tracks immutable initializer value provenance inside regions.
[Issue #5879](https://github.com/DavidObando/gsharp/issues/5879) tracks predefined cast call classification inside loops.

## Verification

The focused binder, compiler-driver, and translator tests compare diagnostics, runtime results, and emitted metadata.
Compiler and translator images undergo IL verification.
Record pre-fix and mutant discrimination witnesses in the PR body.
Build product source with the released SDK specified by `global.json`, under the N-1 rule.
