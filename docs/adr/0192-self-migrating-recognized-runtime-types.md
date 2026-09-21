# ADR-0192: Self-migrating recognized runtime types and reusable CLR ranges

- **Status**: Proposed
- **Date**: 2026-09-21
- **Issue**: [#4350](https://github.com/DavidObando/gsharp/issues/4350)
- **Related**: [ADR-0115](0115-csharp-to-gsharp-migration-tool.md),
  [ADR-0154](0154-test-oracle-strength.md),
  [ADR-0181](0181-readonly-managed-reference-contracts.md),
  [ADR-0190](0190-native-slices-and-clr-array-interoperability.md)

## Context

ADR-0190 gives the CLR types `Gsharp.Values.Slice<T>` and
`ReadOnlySlice<T>` a native G# consumer view: cs2gs prints references to those
metadata types as `slice[T]` and `readonly slice[T]`. The same mechanism applies
to the managed-reference runtime types from ADR-0181.

That mapping is correct for a project consuming `Gsharp.Runtime.Values`, but
not for the project that declares those CLR types. During self-migration the
source symbols have the same assembly and metadata names as the recognized
runtime types, so the mapper rewrites their constructors, interfaces, members,
operators, and self-references as though the native types already existed.
The resulting G# mixes nominal declarations with native use-site types and even
prints constructor calls as the code-model class
`Cs2Gs.CodeModel.Ast.NativeSliceTypeReference`.

The runtime also exposes ordinary .NET APIs accepting `System.Index` and
`System.Range`. G# supports `^n` and `a..b` only inside an index bracket.
cs2gs therefore rejects every reusable `Index` or `Range` type today, although
the CLR structs themselves are available through normal imported-type interop.

The September 20 and 21, 2026 self-migration runs consequently leave 11 of 57
apps red. The new runtime project fails translation, eight dependent apps fail
while compiling its malformed migrated output, and two native-slice test
projects expose separate round-trip and contextual numeric-literal defects.

## Decision

### 1. Separate a runtime type's declaration view from its consumer view

cs2gs will classify recognized runtime types by symbol provenance, not only by
assembly and metadata name:

- A recognized type whose original definition is declared in the compilation
  currently being translated retains its ordinary nominal G# spelling
  everywhere in that compilation.
- The same type loaded from referenced metadata retains its native G# consumer
  view.
- This rule applies to all recognized `Gsharp.Runtime.Values` types, including
  mutable and readonly slices and managed references. It is one shared policy,
  not a slice-only exception.

For the declaring compilation, `Slice<T>` therefore remains
`Gsharp.Values.Slice[T]`; its constructors remain constructors of that nominal
struct; `IEquatable<Slice<T>>`, operators, nested `Enumerator`, and internal
self-references all preserve the CLR identity being implemented.

For consumers, the existing behavior remains:

```csharp
Slice<int> mutable;
ReadOnlySlice<string?> view;
```

continues to migrate as:

```gs
mutable slice[int32]
view readonly slice[string?]
```

when native spelling is unambiguous. Existing qualified nominal spelling used
to escape source-name collisions remains valid because the compiler recognizes
the referenced metadata identity.

The provenance check must derive from Roslyn symbols in the current
compilation. No command-line switch, project-path allowlist, or assembly-name
mode will be added.

### 2. Represent reusable `System.Index` and `System.Range` as imported CLR values

G# will not gain another native index/range value category. cs2gs will use the
existing imported `System.Index` and `System.Range` structs whenever C# carries
one as a parameter, local, field, return, generic argument, or member value.

The translator will lower syntax that cannot be printed faithfully outside an
index bracket:

| C# value expression | Canonical migrated form |
|---|---|
| `^n` | `System.Index.FromEnd(n)` |
| an ordinary start index requiring materialization | `System.Index.FromStart(n)` when the target conversion is not already faithfully bound |
| `start..end` | `System.Range(<materialized start>, <materialized end>)` |
| `..end` | `System.Range(System.Index.Start, <materialized end>)` |
| `start..` | `System.Range(<materialized start>, System.Index.End)` |
| `..` | `System.Range.All` |

Each operand is evaluated once and in C# source order. Explicit C# construction,
static members, properties such as `Start`/`End`, and calls such as
`GetOffset` continue through ordinary imported-member translation.

Direct bracket operations keep their current specialized lowering:

- native slice/array indexing may retain `^n` and `a..b` bracket syntax;
- span/memory ranges may retain the existing `.Slice(start, length)` lowering;
- materialization is used only when the C# program actually carries an
  `Index` or `Range` value beyond that bracket operation.

This removes the broad `CS2GS-GAP` type rejection and the non-bracket
`IndexExpression` rejection only where the factory lowering is faithful.

### 3. Keep native recognition an ABI view, not a source-language rewrite

The migrated runtime assembly must expose the same public CLR names and member
signatures as the C# assembly. Native slice and managed-reference behavior is
activated when another compilation references that assembly and the compiler
recognizes its identity and required surface.

cs2gs must not:

- rename the runtime structs to native keywords;
- synthesize a second native implementation;
- replace nominal constructors with code-model AST constructors;
- remove `Index`/`Range` overloads from the migrated public API;
- special-case the runtime out of the self-migration corpus.

### 4. Treat remaining diagnostics as ordinary focused defects

After the two representation fixes above, any remaining runtime diagnostics
are fixed at their existing shared translation or compiler layer. In
particular, helper qualification, overload selection, ref-return lifetimes,
generic operators, and indexer naming are not accepted as runtime-specific
exceptions.

The two independent regressions recorded by #4350 are companion fixes, not new
language design:

- formatter round-trip failure in `NativeSliceRuntimeTests.cs`;
- contextual constant conversion from tuple literal `int32` elements to
  expected `uint8` elements in `Adr0186PlatformTypeSymbolTests`.

## Rejected alternatives

### Add native G# `Index` and `Range` value types

Rejected. The BCL structs already carry the required reusable state and
semantics. New syntax and compiler types would duplicate CLR interop, enlarge
the language, and still require an ABI conversion policy.

### Map recognized types natively inside their declaring assembly

Rejected. A source declaration cannot simultaneously be the nominal CLR
implementation and a consumer projection of itself. This is the direct cause
of the constructor, interface, operator, and nested-type failures.

### Add a `--self-migrating-runtime-values` mode

Rejected. Symbol provenance already answers the question precisely. A mode
would be easy to omit, would couple translation to project paths, and would
allow the same symbol to be mapped differently for accidental operational
reasons.

### Remove the `Index`/`Range` overloads or exclude the project

Rejected. Both hide supported public API from the migrated assembly and leave
the underlying translator gap for every other library.

### Rebaseline the nightly

Rejected. Ten banked green apps regressed and the null-assertion ceiling breach
is downstream fallout from compile failures. Baseline weakening would record
the defect as intended behavior.

## Implementation plan

### Phase 1: Source-owned recognized runtime types

1. Centralize the recognized-runtime-type test in `CSharpTypeMapper`.
2. Before returning a native slice or managed-reference type reference, test
   whether the original definition belongs to the current source compilation.
3. Emit a nominal named type for source-owned definitions and every reference
   to them in that compilation.
4. Add translation tests using a source compilation named
   `Gsharp.Runtime.Values`, plus controls proving metadata consumers still emit
   native syntax.

This phase should remove the shared 44-error runtime compile wall rather than
patching each diagnostic independently.

### Phase 2: Reusable `Index` and `Range` values

1. Map the BCL structs as ordinary imported named types.
2. Lower non-bracket `^n` to `System.Index.FromEnd(n)`.
3. Lower materialized range expressions to `System.Range` construction/static
   members with single evaluation and source ordering.
4. Keep existing direct-bracket and span/memory range lowering unchanged.
5. Add declaration, local, field, return, argument, generic, omitted-bound,
   side-effect-order, and nullable-container tests.

This phase closes the four `CS2GS-GAP` fingerprints in #4350.

### Phase 3: Focused companion fixes

1. Reduce and fix the native-slice runtime-test formatter round-trip failure.
2. Restore contextual tuple-literal numeric conversion to `uint8`, fixing the
   shared compiler rule if valid G# requires it or inserting an explicit
   conversion if the C# conversion has no implicit G# equivalent.
3. Add one focused regression test for each root.

### Phase 4: Self-migration ratchet

1. Run a targeted migration of `Gsharp.Runtime.Values` and its direct dependent
   closure.
2. Require translate, compile, ILVerify, and test parity for every previously
   green app affected by #4350.
3. Run the complete 57-app corpus.
4. Add the runtime project to `greenApps` only after it is fully green; otherwise
   record its honestly reached `stageFloor`.
5. Keep `greenFloor`, existing `greenApps`, and `nullAssertionCeiling`
   unchanged while closing the regression.

## Acceptance criteria

- [ ] Source declarations of every compiler-recognized runtime type remain
      nominal during translation of their declaring compilation.
- [ ] Referenced metadata types retain their existing native consumer spelling
      and semantics.
- [ ] `Index`/`Range` API declarations and reusable expressions translate
      without unsupported diagnostics or loss of from-end behavior.
- [ ] Side-effecting bounds are evaluated once in source order.
- [ ] `Gsharp.Runtime.Values` translates, compiles, IL-verifies, and passes
      behavioral parity.
- [ ] All ten banked green apps regressed by #4350 return to green.
- [ ] The post-validation null-assertion count returns below the existing
      ceiling without rebaselining.
- [ ] C# and G# consumers observe the same runtime assembly/type/member ABI.

## Compatibility

This proposal adds no G# syntax and changes no existing runtime ABI. It broadens
cs2gs support for ordinary imported CLR structs and corrects an accidental
declaration-time application of an existing consumer projection. Direct native
slice syntax and existing direct-bracket range translations remain unchanged.
