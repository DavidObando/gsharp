# ADR-0192: First-class Index/Range expressions and recognized runtime declarations

- **Status**: Accepted (implemented for issue #4350)
- **Date**: 2026-09-21
- **Issue**: [#4350](https://github.com/DavidObando/gsharp/issues/4350)
- **Related**: [ADR-0115](0115-csharp-to-gsharp-migration-tool.md),
  [ADR-0154](0154-test-oracle-strength.md),
  [ADR-0181](0181-readonly-managed-reference-contracts.md),
  [ADR-0190](0190-native-slices-and-clr-array-interoperability.md)

## Maintainer direction — September 21, 2026

The maintainer approved the declaration-view design and requested two changes:

1. Restoring the nightly is operational recovery, not part of accepting or
   implementing this ADR. `Gsharp.Runtime.Values` remains C# and is temporarily
   excluded from self-migration until this design is implemented and proven.
2. G# gains first-class C#-equivalent `System.Index` and `System.Range`
   expressions. cs2gs preserves their readable syntax rather than lowering
   reusable values to explicit BCL factory calls.

The ADR was **Proposed** until the language/compiler work landed. The
temporary corpus exclusion merged independently (#4351) and is removed by the
implementation PR once the re-entry criteria below pass.

## Implementation notes

- **Parser.** Prefix `^` produces `FromEndIndexExpressionSyntax` at unary
  precedence in every expression context. The historical bracket-bound and
  range-upper-bound positions keep reading the whole bound as the operand
  (`a[^n + 1]` is `a[^(n + 1)]`); that only accepts programs C# rejects, so
  no C#-valid program changes meaning. `~` is a new `TildeToken` for unary
  one's-complement and for `operator ~()` declarations (`op_OnesComplement`).
- **Binder.** A bare `^x` binds to `new System.Index(x, fromEnd: true)`.
  Range bounds are bound once, left to right: an integer converts to a
  from-start Index, a `^n` bound stays a from-end marker, and a bound that is
  already a `System.Index` is used as-is. Direct array/string/span slicing
  resolves saved Index bounds with `Index.GetOffset(length)`; native slices
  switch to the runtime's `Subslice(Range)` overload for them. `GS0410` is
  retired.
- **cs2gs.** `System.Index`/`System.Range` map as ordinary imported types.
  `^x`, all range forms, and `~x` print verbatim, and the #1894/#1967
  loud-gap guards are gone. `CSharpTypeMapper.IsRecognizedRuntimeConsumerType`
  keeps `Slice`/`ReadOnlySlice`/`ManagedRef`/`ReadOnlyManagedRef` nominal when
  their original definition lives in the compilation being translated.

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

G# already supports:

- bracket-scoped from-end and range syntax such as `items[^1]`,
  `items[1..^1]`, and `items[..]`;
- standalone `System.Range` values such as `let r = 1..3`, `..3`, `1..`, and
  `..`;
- a from-end upper bound in a standalone range, such as `1..^1`.

It does not yet reach C# equivalency:

- bare `^n` outside an index bracket is parsed as integer ones-complement;
- a standalone range cannot begin with a from-end bound (`^3..^1`);
- `System.Index` therefore has no readable literal expression;
- cs2gs rejects reusable `Index`/`Range` API surfaces rather than preserving
  their source form.

This split is especially visible in the native slice runtime, whose public C#
API naturally accepts `Index` and `Range` values.

## Operational recovery, separate from this design

Until the design is implemented, self-migration will:

- exclude `src/Sdk/Gsharp.Runtime.Values/Gsharp.Runtime.Values.csproj` from the
  discovered migration apps;
- preserve the excluded project and its checked-in C# sources verbatim in the
  migrated repository so translated consumers can build against it;
- keep the existing 56-app `greenFloor`, `greenApps`, and readability ceilings;
- retain focused source-compatible fixes for the two independent native-slice
  test regressions recorded by #4350.

This is a temporary dependency boundary, not a claim that the project is
unmigratable or outside cs2gs's intended scope.

## Decision

### 1. Make `System.Index` a first-class G# expression

Prefix `^` becomes the from-end index operator everywhere, matching C#:

```gs
let last = ^1
let thirdFromEnd System.Index = ^3
consume(^2)
let value = items[last]
```

The expression has type `System.Index`. Its operand is converted to `int32`,
evaluated once, and used to construct an index with `IsFromEnd == true`.
Creating the value does not inspect a collection length; `GetOffset(length)`
or the eventual index operation resolves it, matching .NET semantics.

`^0` is a valid `System.Index` value and fails only when a consuming operation
rejects the resulting offset, as it does in C#.

### 2. Complete first-class `System.Range` expressions

The existing range expression remains a `System.Range` value, but both bounds
now accept the same index-expression forms as C#:

```gs
let middle = 1..4
let tail = ^3..
let trimmed = ^4..^1
let prefix = ..^2
let all = ..
```

An ordinary integer bound converts to `System.Index.FromStart`. A `^n` bound
is already a `System.Index` value. Omitted lower and upper bounds use
`System.Index.Start` and `System.Index.End`.

Each written bound is evaluated exactly once, left to right. The resulting
range remains reusable in fields, locals, parameters, returns, generic
arguments, and indexer calls.

The existing direct slicing optimizations may remain implementation details,
but they must be observationally equivalent to constructing and consuming the
corresponding `System.Index`/`System.Range` values.

### 3. Move unary ones-complement to `~`

Prefix `^` cannot simultaneously mean an inferred `System.Index` expression
and integer ones-complement. G# will use C#'s `~` spelling for unary
ones-complement:

```gs
let inverted = ~mask
let combined = left ^ right
let fromEnd = ^count
```

Binary `^` remains bitwise XOR. This removes the current context-sensitive
restriction and makes all three operators match C#:

| spelling | meaning |
|---|---|
| `~x` | unary integer/enum ones-complement |
| `x ^ y` | binary bitwise XOR |
| `^x` | `System.Index` from-end expression |

The old prefix-`^` complement spelling is a source-breaking change. The
compiler, formatter, specification, samples, and cs2gs must change together.
Existing G# code uses `~` after migration; cs2gs stops rewriting C# `~` to
prefix `^`.

Parentheses do not restore the old meaning: `(^x)` is still an Index. Write
`(~x)` when a complemented integer is a range bound.

### 4. Bind Index/Range through their CLR identities

The language feature uses the ordinary imported `System.Index` and
`System.Range` CLR structs. It does not add parallel compiler-only runtime
types or change their ABI.

Binding and emission must support:

- inference (`let i = ^1`, `let r = ^3..^1`);
- explicit type clauses, nullable containers, fields, parameters, returns, and
  generic arguments;
- conversions from ordinary integer bounds to from-start Index values;
- indexing and slicing by saved Index/Range values;
- calls to imported members such as `GetOffset`, `Start`, `End`, and `All`;
- exact evaluation order and exception behavior.

### 5. Teach cs2gs to preserve the source constructs

cs2gs maps C# `System.Index` and `System.Range` type symbols to those imported
G# types instead of reporting `CS2GS-GAP`.

It preserves readable expressions:

| C# | G# |
|---|---|
| `Index i = ^2;` | `let i System.Index = ^2` |
| `Range r = ^4..^1;` | `let r System.Range = ^4..^1` |
| `values[^1]` | `values[^1]` |
| `values[r]` | `values[r]` |
| `~mask` | `~mask` |

Existing array/span/native-slice lowering may still optimize a direct bracket
operation, but a reusable C# value stays a reusable, readable G# value.

### 6. Separate a recognized runtime type's declaration view from its consumer view

cs2gs classifies recognized runtime types by symbol provenance, not only by
assembly and metadata name:

- A recognized type whose original definition is declared in the compilation
  currently being translated retains its ordinary nominal G# spelling
  everywhere in that compilation.
- The same type loaded from referenced metadata retains its native G# consumer
  view.
- This rule applies to all recognized `Gsharp.Runtime.Values` types, including
  mutable and readonly slices and managed references.

For the declaring compilation, `Slice<T>` remains
`Gsharp.Values.Slice[T]`; its constructors remain constructors of that nominal
struct; `IEquatable<Slice<T>>`, operators, nested `Enumerator`, and internal
self-references preserve the CLR identity being implemented.

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

The provenance check derives from Roslyn symbols in the current compilation.
No project-path allowlist or assembly-name mode is added.

### 7. Keep native recognition an ABI view

The migrated runtime assembly exposes the same public CLR names and member
signatures as the C# assembly. Native slice and managed-reference behavior is
activated when another compilation references that assembly and the compiler
recognizes its identity and required surface.

cs2gs must not:

- rename the runtime structs to native keywords;
- synthesize a second native implementation;
- replace nominal constructors with code-model AST constructors;
- remove `Index`/`Range` overloads from the migrated public API.

## Rejected alternatives

### Lower reusable values to explicit BCL factories only in cs2gs

Rejected. `System.Index.FromEnd(n)` and explicit `System.Range(...)`
construction are mechanically faithful but lose the readable C# source shape
and leave handwritten G# behind C#. First-class expressions solve the language
and migration gaps together.

### Keep prefix `^` as ones-complement and infer Index from context

Rejected. `let x = ^1`, overload arguments, `object` sinks, and generic
inference would remain ambiguous or context-sensitive. Distinct `~`, binary
`^`, and prefix `^` spellings are simpler and C#-equivalent.

### Map recognized runtime types natively inside their declaring assembly

Rejected. A source declaration cannot simultaneously be the nominal CLR
implementation and a consumer projection of itself. This is the direct cause
of the constructor, interface, operator, and nested-type failures.

### Permanently exclude the runtime project

Rejected. The temporary exclusion restores the nightly while the design is
implemented. The project returns to the corpus after the re-entry gates pass.

### Rebaseline the failed nightly

Rejected. Banked green apps regressed and the null-assertion ceiling breach is
downstream fallout from compile failures. Baseline weakening would record the
defect as intended behavior.

## Implementation plan

### Recovery PR: restore the existing corpus now

1. Preserve excluded C# projects as C# passthrough projects in repository
   mirrors.
2. Temporarily exclude `Gsharp.Runtime.Values` in the shared classic/sharded
   self-migration configuration.
3. Keep all existing floors, banked green identities, and ceilings unchanged.
4. Resolve the native-slice test round-trip and explicit metadata-byte fixture
   failures so the remaining 56 apps return to green.

This recovery can merge before any ADR implementation.

### Phase 1: language syntax and binding

1. Parse prefix `^` as a first-class `FromEndIndexExpressionSyntax` everywhere.
2. Parse and bind prefix `~` as integer/enum ones-complement.
3. Remove GS0410's leading-from-end range restriction.
4. Bind `^x` to `System.Index` and all range forms to `System.Range`.
5. Preserve single evaluation, left-to-right bound order, conversions, and
   imported Index/Range indexer behavior.
6. Update formatter, syntax visitors, semantic model coverage, diagnostics,
   specification, samples, and versioned documentation.

### Phase 2: cs2gs equivalency

1. Map `System.Index` and `System.Range` type symbols as imported named types.
2. Emit `^x` and all C# range-expression forms directly.
3. Emit C# unary `~` as G# unary `~`; keep binary XOR as `^`.
4. Add declarations, locals, fields, returns, arguments, generics, nullable
   containers, omitted bounds, nested expressions, and side-effect-order tests.

### Phase 3: recognized runtime declarations

1. Centralize the recognized-runtime-type test in `CSharpTypeMapper`.
2. Preserve nominal named types for source-owned definitions and references in
   their declaring compilation.
3. Retain native syntax for referenced metadata consumers.
4. Remove remaining shared translation/compiler defects instead of adding
   runtime-specific exceptions.

### Phase 4: Runtime.Values re-entry

1. Run a targeted migration of `Gsharp.Runtime.Values` and its direct dependent
   closure.
2. Require translate, compile, ILVerify, and test parity.
3. Run the complete repository corpus with the exclusion removed.
4. Add `Gsharp.Runtime.Values` to `greenApps` only after it is fully green.
5. Remove the temporary passthrough/exclusion commentary while keeping generic
   passthrough support for intentional future exclusions.

## Acceptance criteria

- [ ] `^x` is a reusable `System.Index` expression in every expression context.
- [ ] `^a..^b` and all omitted-bound forms produce reusable
      `System.Range` values.
- [ ] `~x` is unary ones-complement and binary `x ^ y` remains XOR.
- [ ] Saved Index/Range values preserve C# evaluation and runtime behavior.
- [ ] cs2gs translates Index/Range declarations and expressions without
      unsupported diagnostics or factory-noise fallbacks.
- [ ] Source declarations of every compiler-recognized runtime type remain
      nominal during translation of their declaring compilation.
- [ ] Referenced metadata types retain native consumer spelling and semantics.
- [ ] `Gsharp.Runtime.Values` passes all four migration stages after re-entry.
- [ ] The full corpus is green with the existing ratchets and without the
      temporary Runtime.Values exclusion.
- [ ] C# and G# consumers observe the same runtime assembly/type/member ABI.

## Compatibility

The CLR ABI is unchanged. The language change is source-breaking only for
prefix `^` ones-complement, which moves to C#'s `~` spelling. Binary XOR,
existing bracket indexing, existing standalone Range values, and runtime
Index/Range identities remain intact.
