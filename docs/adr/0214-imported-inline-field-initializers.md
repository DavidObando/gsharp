# ADR-0214: Constructor-owned data struct construction

- **Status**: Accepted (maintainer approval on October 26, 2026)
- **Date**: 2026-10-25
- **Revised**: 2026-10-26
- **Phase**: Language semantics and cross-assembly construction
- **Related**: [#5296](https://github.com/DavidObando/gsharp/issues/5296), [#5364](https://github.com/DavidObando/gsharp/issues/5364), [PR #5349](https://github.com/DavidObando/gsharp/pull/5349)

## Status and scope

The maintainer approved the full policy and implementation on October 26, 2026, at 09:34 PDT: "Policy approved, proceed implementation of 5349".

This decision is accepted. Implementation and validation remain in progress. Approval alone does not fix either issue or establish test results.

This revision replaces the per-field public-helper proposal previously recorded in this ADR. The helper implementation in PR #5349 is obsolete. It must be removed and replaced before that PR can merge. Its historical tests do not prove the design below.

The scope is fresh `data struct` construction, including literals and structural projections. It includes ordinary constructor calls where they share this construction plan. It does not change class inheritance, plain-struct semantics, constant fields, or static-field declaration rules.

## Problem

[#5296](https://github.com/DavidObando/gsharp/issues/5296) reports lost defaults in independently compiled data structs. The consumer cannot recover arbitrary declaration expressions from public field metadata.

[#5364](https://github.com/DavidObando/gsharp/issues/5364) reports a related constructor-selection error. An imported empty-primary data struct already has an ordinary constructor. Its literal bypasses that constructor. The local equivalent runs it.

The previous proposal exported each declaration expression from a public nested helper host. It preserved omitted-only initialization. That design added a public compiler protocol and left constructor ownership inconsistent.

This proposal deliberately replaces omitted-only semantics with constructor-owned semantics. It is a language behavior change, not an implementation refactor.

## C# basis and G# boundaries

The following Microsoft sources were checked on October 26, 2026:

| Primary source | Applicable contract |
| --- | --- |
| [C# structs, §16.5.3.2 and §16.8.8–§16.8.9](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/structs) | Instance declaration initializers belong to constructors. An implicit zero constructor does not execute arbitrary declaration expressions. |
| [C# expressions, §12.6.2 and §12.8.17.2](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/expressions) | Constructor arguments precede construction. Object-initializer member assignments follow construction. |
| [C# records reference](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record) | Record structs have value semantics. Positional properties and their accessors differ from readonly fields. |
| [C# structs, §16.8.5 and §16.8.10](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/structs) | Raw defaults remain zero. Calling an explicit instance constructor can trigger the struct's static constructor. |
| [C# classes, §15.5.3 and §15.11](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/classes) | A declaring constructor can write its readonly fields. An external object initializer cannot write those fields. |

Alignment means ordinary constructor ownership, constructor-before-member phases, and an ordinary public constructor ABI. It does not mean identical syntax or all C# record synthesis rules.

G# retains its existing primary-member brace binding, described below. G# readonly `let` fields remain fields. They do not become C# record `init` properties.

[ADR-0029](0029-data-struct-synthesized-members.md) and [ADR-0199](0199-data-types-synthesize-the-csharp-record-abi.md) remain the basis for other synthesized members. This proposal does not expand their property or deconstruction contracts.

## Construction phases

Resolve the constructor and classify all entries before execution. Use the same ownership decision for source and imported types.

1. Evaluate explicit constructor arguments once. Preserve their written order, then place their values in parameter order.
2. Invoke the selected ordinary instance constructor once. Its initialization plan establishes required sound zeros, assigns primary storage, and executes declaration initializers in declaration order. Execute an authored body afterward. A delegating constructor must not replay the delegated initialization plan.
3. Evaluate each remaining member value once, then perform its assignment. Process member assignments and collection population in their written order.

Only constructor arguments belong to phase 1. A value for an ordinary body field belongs to phase 3. Do not evaluate all explicit literal values before construction.

The existing constructor ownership rules determine how primary storage and declaration expressions share scope. Do not insert declaration expressions into the consumer's field-initializer map.

For a primary input that corresponds to readonly storage, pass the value to the constructor. Do not follow that call with an external field store.

### Primary inputs are a G# distinction

Keep the existing `T{PrimaryMember: value, BodyMember: value}` syntax. Use the existing primary-member mapping to distinguish constructor inputs from post-construction members.

Brace omission retains the existing G# rule. Supply a legal zero or sound collection zero for a missing primary input. Do not substitute the parameter's optional-call default. Reject an illegal missing managed-reference value with `GS0604`.

For example, given primary parameters `A int32, B int32 = 5`, `P{A: 3}` passes `(3, 0)`. An ordinary `P(3)` call uses the declared optional default and passes `(3, 5)`. Both calls execute the same selected constructor body once.

Preserve written order within each phase, not a single order across constructor arguments and later member assignments. A body-field value remains post-construction even if its entry precedes a primary input textually. Preserve existing `GS0622` rejection of primary inputs after braced or content initialization.

This is not C# object-initializer parameter binding. For an equivalent C# consumer, use `new P(3, 0)` followed by its object initializer. C# `new P()` can instead select the implicit zero path for a positional struct without an emitted parameterless constructor. It is not equivalent to G# `P{}`.

## Constructor selection and ownership

For newly compiled body-only data structs, emit an ordinary public parameterless constructor if no authored parameterless constructor exists. Emit it even when its initialization plan is empty. An empty declared primary list uses its ordinary public zero-argument constructor.

This body-only constructor synthesis is a G# rule. C# source can require an explicit constructor declaration instead. Both consumers call the same emitted method.

An authored accessible parameterless constructor is selected for `T{...}` when no nonempty primary constructor owns the brace inputs. Its declaration initializers and body execute once before caller assignments. This intentionally removes the old ban on authored-body execution.

An authored inaccessible parameterless constructor is not bypassed. Do not generate a second constructor with the same signature. Report an ordinary constructor-resolution error.

| Declaration or producer | Fresh brace construction | Ordinary call and metadata |
| --- | --- | --- |
| No primary list; no authored parameterless constructor | Call the emitted public `.ctor()`, then apply member entries. | `T()` selects that same signature. |
| Empty primary list, including `data struct S()` | Call its public `.ctor()` even when every field is explicitly supplied. | `S()` and imported `S{}` select the same method. |
| Authored accessible parameterless constructor | Call it, including its body, then apply member entries. | No hidden alternative constructor and no duplicate declaration initialization. |
| Authored inaccessible parameterless constructor | Reject construction from an inaccessible site. | Ordinary accessibility remains in force. |
| Nonempty primary list with required parameters | Pass supplied primary entries and legal omitted zero values to the canonical primary constructor. | Ordinary `T(...)` still requires applicable arguments. Braces do not select an unrelated overload. |
| Nonempty primary list with optional parameters | Brace omission uses legal zero values, not optional-call defaults. | Ordinary calls use the existing optional-argument rules. Do not add a parameterless overload just for braces. |
| Generic data struct or private initialized storage | Use the same selected owning constructor on the closed type. | Bind declaration expressions inside the declaring type. Preserve normal private access. |
| Old G# producer with a usable ordinary constructor | Select the same constructor by its signature and existing primary mapping. | A correct existing constructor body needs only a corrected consumer. This covers #5364. |
| Old G# producer missing the required constructor | Report `GS0267` at the construction type. Do not silently substitute raw zero. | Recompile the producer and consumer. Explicit raw defaults remain a separate operation where legal. |
| Foreign struct without G# primary metadata | Use its accessible parameterless constructor, if present. Otherwise retain its ordinary implicit-zero construction. | Never infer a parameterized constructor from field names or field order. A foreign type's own language controls its constructor body. |
| Implementation assembly or `/refout` reference | Select the same constructor signature and classify the same primary inputs. | Reference metadata must expose the constructor, visibility, generic signature, primary mapping, and ordinary parameter defaults. |

Use existing authoritative G# type identity and primary-member metadata. Validate a mapped primary constructor against the actual constructor signature after generic substitution. Reject incomplete or inconsistent G# construction metadata instead of guessing.

Do not use `ClrType == nil` as a constructor-ownership gate. Do not require recovery of the source distinction between an empty primary list and no primary list. Both zero-argument cases use ordinary `.ctor()` metadata.

Do not infer ownership from a constructor name, a field shape, or optional parameters alone. Do not choose an unrelated parameterized constructor because all its arguments have defaults.

Do not add a new marker, serialized expression, helper-host convention, or per-field expression import. Existing type identity can identify a legacy G# producer that lacks its required constructor. It cannot recover missing executable expressions.

## Required result for #5364

The producer declares this public type in a separate assembly:

```gsharp
public data struct S() {
    public var X int32 = Effects.Next()
}
```

`Effects.Next()` appends `I` and returns `1` after each reset. A source-local `Local` has the same declaration.

Reset the effect state before each operation below:

| Operation | Expected value and effect trace |
| --- | --- |
| `Local{}` | `1:I` |
| Imported `S{}` | `1:I` |
| `Local{X: 9}` | `9:I` |
| Imported `S{X: 9}` | `9:I` |
| Ordinary imported `S()` | `1:I` |

The complete expected stdout is `1:I\n1:I\n9:I\n9:I\n1:I\n`. Every operation invokes its constructor once. Supplying `X` does not suppress `Effects.Next()`.

The existing producer already emits a constructor for this case. A corrected consumer must call it through either implementation or reference metadata. It must not depend on producer syntax.

## Compatibility changes

The old omitted-only path skipped a declaration initializer when the caller supplied that field. The proposed path executes the declaration initializer, then overwrites its value.

This can add allocations, observable side effects, and exceptions. A throwing default prevents evaluation of post-construction values, even when the caller supplies an override.

For a nonprimary mutable `X` whose default appends `D`, `T{X: Effects.Value("E", 9)}` must produce trace `DE`, not `E`. For a primary input that appends `A`, the corresponding constructor-and-member case must produce `ADE`.

Some existing constructor-owned literals stage explicit values before construction. Their phase order also changes. Historical `EI` expectations cannot establish the new `IE` contract.

Authored parameterless bodies now run. The old restriction against calling them preserved the old literal model; it is not part of this proposal.

Use the normal CLR static-initialization contract of the selected constructor. An explicit declaring-type static constructor can now run where the old literal used only `initobj` and field stores. A constant instance initializer does not justify suppressing that trigger.

Do not promise an exact trigger point for a `beforefieldinit` type beyond the CLR contract. Use explicit static constructors for exact-order tests. Propagate constructor and initializer exceptions normally, including ordinary type-initialization exception behavior.

These changes require release and migration notes when implemented. This document does not claim that they have shipped.

## Readonly fields and access

A constructor can legally initialize its declaring type's CLR `InitOnly` fields. An omitted readonly declaration default must therefore succeed through that constructor, including from a separate consumer.

A post-construction explicit write to the same field is illegal. Report `GS0127` at the caller's field name and emit no image. A primary argument assigned inside the constructor is not such a write.

Do not turn fields into properties, add accessors, remove `InitOnly`, or widen accessibility. C# record `init` properties permit operations that G# readonly fields do not permit.

For example, let imported `R` declare `public let X int32 = 7`. Compile this consumer as `consumer.gs`:

```gsharp
import Producer
let x = R{X: 9}
```

Require `GS0127` at the one-based, end-exclusive span `(2,11)-(2,12)`, with filename `consumer.gs` and no output image. By contrast, `R{}` must yield `7` with no external `stfld R.X`.

Use the shared construction/write-legality check for literals, structural projections, nested constructions, and ordered population. Do not restore the old rule that diagnosed every imported readonly declaration default.

For synthesized children, retain the enclosing consumer construction anchor. Keep constructor-initializer anchor precedence. Do not attach one consumer's syntax to a shared imported tree.

Private declaration expressions run inside the declaring constructor. Friend access can admit internal caller-visible members, but it does not make readonly stores legal. Existing aggregate accessibility checks remain authoritative.

## Zeros, collections, projections, and copies

[ADR-0159](0159-magic-collection-zero-values-and-nil-comparison.md) distinguishes sound collection zeros from raw defaults. Preserve that distinction.

For fresh construction, the owning constructor establishes required sound zeros before declaration expressions or population can use them. An explicit declaration initializer replaces its field's initial zero in the constructor. Never reset that completed field to an empty collection afterward.

A field without a declaration expression does not recursively call its field type's fresh-construction constructor. Establish only its required sound-zero state. Do not replay that nested type's scalar declaration defaults.

After construction, mixed literals execute assignments and `Add` operations in their existing lexical order. If an `Add` precedes an explicit replacement, it sees the constructor's current collection. This includes an effectful declaration default. It no longer sees a substituted empty collection merely because a later entry replaces that field.

This supersedes the omitted-only default rule in [ADR-0180](0180-mixed-composite-initializer-elements.md) only for fresh data-struct construction. Keep its syntax, accessibility, ordering constraints, and single-evaluation rules.

Structural projection creates a fresh target. Capture its source once. Read constructor-bound inputs before the target constructor, then read and assign the other projected members in their established order. Apply the same constructor-selection and readonly checks. Do not replay source initialization.

Raw `default(T)`, `initobj`, and zero-initialized array elements remain zero. They do not call the constructor or replay declaration expressions. Existing `GS0604` rejection of illegal managed-reference defaults remains in force.

Bare declarations and existing sound-zero-only helpers retain their ADR-0159 behavior. In particular, they must not start replaying arbitrary scalar declaration defaults. This proposal removes the per-field helper protocol, not every existing collection-zero helper.

`with` and `.copy` remain value copy/update operations under [ADR-0032](0032-data-struct-ergonomics.md). They capture their source once and do not call a fresh-construction constructor or replay declaration initializers. Their existing update legality remains unchanged.

Use the initialization ownership rules in [ADR-0188](0188-heap-storable-managed-references.md). A nested value, generic substitution, or managed-reference slot must not lose its required initialization or diagnostics.

## Public ABI and implementation boundaries

The selected ordinary public constructor is the cross-assembly construction ABI. Both implementation and reference assemblies must expose the same callable contract. Declaration expressions exist only in implementation constructor bodies.

A Roslyn C# consumer uses `new S()` or `new S { X = 9 }` for the zero-argument case. It calls the emitted constructor before legal member assignments. A nonempty-primary equivalent supplies its arguments explicitly through `new P(...)`.

C# consumers do not need G# per-field helpers or original source. Readonly fields remain readonly to C#. They do not acquire record-property initialization privileges.

Replacing a library cannot change an already compiled consumer's `initobj` into a constructor call. Recompile that consumer. Recompile an old producer when its constructor is absent or its body does not implement the required initialization.

Reference assemblies cannot provide missing executable initializer bodies. Preserve their signatures and mappings, then execute against the matching implementation. Reject missing or inconsistent constructor metadata with `GS0267`; preserve `GS0160` for ambiguous ordinary overload resolution.

Share selection, initialization ownership, and write-legality decisions across binder and backend paths. Use the existing initialization planner and normal constructor emission. Do not create a parallel expression importer or runtime evaluator.

The emitted program, REPL, and supported expression-tree lowering must select the same constructor and preserve the same phases. Unsupported expression-tree cases must retain explicit diagnostics, not silently use raw zero.

Emit constructors and their metadata deterministically. Use declaration and stable signature order, never hash iteration order. Repeated compilation of the same input must preserve constructor selection, member order, and emitted bytes.

## Acceptance matrix for later implementation

These are required future witnesses, not results from the helper implementation.

Use [ADR-0154](0154-test-oracle-strength.md) for every new or changed behavior test. Demonstrate a genuine unfixed or buildable product-mutant RED, then fixed GREEN. Record exact commands, bytes, diagnostic IDs, filenames, and spans.

Compile producers and consumers independently through the actual user driver. Do not use an ambient migrated test assembly as the producer. Exercise both implementation references and `/refout` references against the matching implementation. Use Roslyn for the C# contracts.

| Case | Required oracle |
| --- | --- |
| #5296 reported defaults and explicit control | Exact stdout `160\n160\n180\n160\n`, with source-local and independent imported data structs. |
| #5364 empty-primary case | Exact five-line stdout specified above. Verify one constructor invocation per operation, including ordinary `S()`. |
| Body-only default followed by override | Exact value `9` and trace `DE`. The default still runs when overwritten. |
| Primary input, declaration effect, post-member effect | Exact trace `ADE`, with each event occurring once. Cover optional-call defaults versus brace zeros. |
| Authored parameterless body | Declaration trace `D`, body trace `B`, then caller trace `E`: exact `DBE`. Reject inaccessible constructors without output. |
| Throwing default or explicit static constructor | A fresh process records the exact prefix and exception type. No later member expression executes. Test explicit static-constructor order separately from `beforefieldinit`. |
| Private access and closed generics | Constructor-owned private calls and substituted field initialization match source-local results. No consumer private access or expression import appears. |
| Readonly default versus caller override | `R{}` yields `7` and strictly verifies. The consumer above reports located `GS0127`, emits no image, and never emits an external readonly store. |
| Projection and synthesized nested readonly values | A legal constructor-owned default succeeds. An illegal explicit write reports located `GS0127`. Preserve outer construction and constructor-initializer anchors. |
| Collection invariants and mixed population | Compare source-local, imported, and friend consumers. Verify initial sound zeros, constructor-default contents, and each lexical `Add` before later replacement. No double reset or double default effect. |
| Raw defaults, array elements, bare declarations | Scalar values remain zero and declaration-effect count stays zero. Preserve sound-zero-only behavior and located `GS0604` negatives. |
| `with` and `.copy` | Copies retain source values. Updates execute once. Constructor/default effect counters do not increase. |
| Legacy G# producer | A usable existing constructor succeeds, including #5364. A missing required constructor reports `GS0267` at the type identifier and emits no image. Never infer arbitrary parameterized ownership. |
| Foreign C# producer | An explicit public parameterless constructor runs once. A type without one retains implicit zero. A parameterized-only overload is not guessed from fields. |
| Roslyn consumer of new G# producer | `new S()` and `new S { X = 9 }` produce `1:I\n9:I\n` after separate resets. Match explicit primary calls; keep readonly-field assignments as compile errors. |
| Constructor and helper metadata | Inspect actual emitted metadata: required public constructors and mappings exist in implementation and reference assemblies. No `<>FieldInitializers` host or `<>fieldInitializer$...` method exists. |
| Backend, REPL, and expression-tree paths | Each supported path preserves constructor identity, exact effect order, exception behavior, and diagnostics. Pin explicit unsupported-case diagnostics. |
| Repeat emission | Identical input and options produce identical bytes. Constructor and field metadata order is stable. |

For a missing-constructor negative, use `let x = Legacy{}` on line 2 of `consumer.gs`. Require `GS0267` at `(2,9)-(2,15)` and no output image. Other constructor/accessibility cases must pin their existing applicable diagnostic and source location.

Run strict, unsuppressed IL verification on every positive producer and consumer, including the Roslyn consumers. Assert constructor calls and the absence of external readonly stores in actual IL. Metadata inspection alone does not prove runtime behavior.

## Delivery and review gates

1. Review this proposed behavior and its compatibility changes. Approval of the direction does not approve every table entry.
2. Remove the superseded helper implementation. Replace it with the shared constructor-owned construction path.
3. Replace obsolete omitted-only test expectations. Preserve historical RED evidence without presenting it as proof of the new model.
4. Complete the acceptance matrix with real driver and metadata witnesses.
5. Update normative specification and release notes only when implementation and validation support them.

PR #5349 must remain draft until the replacement implementation and its acceptance witnesses are complete. It must not merge with the obsolete helper implementation.

The complete policy is approved. It includes authored parameterless bodies, legacy-producer rejection, preserved G# brace-zero inputs, and the stated readonly limits. No public per-field helper ABI approval is requested.

## Alternatives not selected

- Keep the public helper host: preserves omitted-only effects but adds a second public construction protocol.
- Import or serialize declaration expressions: duplicates binding, access scope, and lowering across assemblies.
- Guess constructors from fields: can execute an unrelated constructor or silently change ownership.
- Retain zero fallback for missing G# constructors: silently loses initialization and leaves #5296 unresolved.
- Convert readonly fields to `init` properties: changes storage, accessors, and mutability beyond this scope.
