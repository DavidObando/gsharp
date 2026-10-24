# ADR-0211: UTF-8 literals over static readonly byte spans

- **Status**: Accepted
- **Date**: 2026-10-23
- **Phase**: Design approved; implementation and certification pending
- **Approval**: The maintainer stated “ADR 0211 is approved” on 2026-10-23.
- **Release scope**: The maintainer selected native span aliases and native
  UTF-8 literal `+` folding on 2026-10-23.
- **Issue**: [#5218](https://github.com/DavidObando/gsharp/issues/5218)
- **Related**: [ADR-0204](0204-immutable-bytestring-values.md),
  [ADR-0056](0056-span-consumption-v1.md),
  [ADR-0058](0058-ref-safe-to-escape.md),
  [ADR-0181](0181-readonly-managed-reference-contracts.md),
  [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md),
  [ADR-0193](0193-nullability-queries-are-type-level-and-funnelled.md),
  [ADR-0115](0115-csharp-to-gsharp-migration-tool.md),
  [ADR-0154](0154-test-oracle-strength.md)

## Context

The maintainer suggested `u8"..."` and `readonly span[byte]` in issue #5218.
Neither spelling exists on the inspected `main`, commit `04069285a`.
The issue's static-lambda request is outside this proposal.

G# already consumes CLR `System.ReadOnlySpan[T]`.
Its element reads, readonly-reference permissions, scoped escape checks, and
async liveness analysis are not missing prerequisites.
The lowercase span spelling is missing.
The limitations section in `website/docs/ref/clr-interop.md` also lists
span creation as unsupported, although stack allocation now has an emitter.
Implementation must check current code rather than copy that historical list.

ADR-0204 supplies a different capability: an immutable, heap-storable byte value.
Its literal can contain arbitrary bytes, not necessarily UTF-8.
The runtime exposes copying exports, but no public backing span.
`b"text".ToArray()` followed by an array-to-span conversion copies and allocates.
`ByteString.CopyFrom(span)` copies in the opposite direction.
Neither operation provides a static-data literal.

The present bytestring literal binds to `ByteString.FromLiteral(hex)`.
That method caches a descriptor and private array through a weak-key table.
Warm reuse avoids repeated byte buffers, but it is not a direct PE-data view.
Using that factory would also add an unnecessary runtime dependency here.

cs2gs already recognizes Roslyn `Utf8StringLiteralExpression`.
`TranslateLiteral` currently emits `ArrayLiteralExpression` with hexadecimal
`uint8` elements.
G#'s array emitter uses `newarr` and element stores.
This loses C#'s static-data allocation guarantee and hidden trailing terminator.
The existing `Utf8StringLiteral_MappedToByteSlice` test only checks printed
substrings; it does not establish type, lifetime, allocation, or emitted bytes.

The [C# lexical specification][csharp-lexical] describes the implemented
UTF-8 literal forms and their type.
The [C# 11 proposal][csharp-proposal] describes literal-only addition.
Its later alternative sections include conversions that were not implemented.
They are not requirements for G#.
The proposal also contains a misleading surrogate example.
The lexical specification and executable compiler diagnostics take precedence.

## Decision

**Provide a native `u8"..."` expression of CLR type
`System.ReadOnlySpan[uint8]`, backed directly by static module bytes.**
The maintainer approved this design, not an implemented or certified capability.
No SDK, runtime, compiler, translator, or test behavior changes in this ADR.
Implementation, release, SDK-pin adoption, and merge require their own authorization.

The maintainer explicitly selected both initial-release choices:

- Include `span[T]` and `readonly span[T]` aliases, as defined in section 2.
- Include native UTF-8 literal-only `+` folding, as defined in section 7.

Neither release-scope choice remains unresolved.
The managed-helper emission in section 5 remains a candidate subject to its proof gates.
Approval is not evidence that G# emission, strict ILVerify, NativeAOT, or translation works.

### 1. Three distinct contracts

| Form | Type and contract |
| --- | --- |
| `"text"` | CLR `string`; existing UTF-16 text semantics remain unchanged. |
| `b"\xFF"` | `Gsharp.Values.ByteString`; arbitrary immutable bytes with content operations and owned storage. |
| `u8"text"` | CLR `System.ReadOnlySpan[uint8]`; readonly byte view with compile-time UTF-8 encoding and static backing storage. |

UTF-8 validity belongs to literal construction, not to every value of the span type.
An ordinary readonly byte span can contain invalid UTF-8.
Indexing and slicing operate on bytes, not Unicode scalars.
Slicing a literal span can split a multibyte encoding.
Span equality retains its existing CLR view semantics, not bytestring content equality.
Use `SequenceEqual` when comparing contents.

The literal has this natural type even when no target type is present.
It does not change type for an overload or a user-defined name.
An ordinary string never implicitly becomes a UTF-8 literal.
Do not introduce a wrapper type, text encoder at runtime, or compiler-only ABI.

### 2. Native type spelling

Provide these contextual aliases:

```gsharp
let utf8span readonly span[byte] = u8"Hello, World!"
let inferred = u8"Hello, World!"
```

`span[T]` denotes CLR `System.Span[T]`.
`readonly span[T]` denotes CLR `System.ReadOnlySpan[T]`.
`byte` retains its existing identity with `uint8`.
These aliases do not denote native slices, fixed arrays, or managed references.
They add no span constructors, allocation rules, or implicit conversions.
The CLR-qualified forms remain available.

Follow native slice lookup precedence.
A visible user type or alias named `span` wins ordinary unqualified lookup.
`$span` always uses ordinary lookup.
Apply `readonly` only to the recognized native span form.
Diagnose its use with a shadowing ordinary type rather than ignoring the modifier.
Qualified CLR names avoid collisions in generated code.
Use target-reference identities and existing constructed-type machinery.
Preserve support for symbolic element types and source-defined enum elements.
Do not bind a user-defined lookalike `System.ReadOnlySpan`.

Existing CLR type spelling remains valid:

```gsharp
import System
let utf8span ReadOnlySpan[byte] = u8"Hello, World!"
```

This spelling has identical literal semantics and names the same CLR type.
Both native aliases are part of the initial release, not an optional follow-up.
They introduce no wrapper types or new runtime identity.

### 3. Lexical forms and exact encoding

Recognize adjacent lowercase `u8"` at an unescaped identifier boundary.
Do not reserve `u8`, recognize an uppercase prefix, or accept a C# postfix.
`u8`, `$u8`, `au8`, and `u8 "text"` keep their ordinary tokenization.
Add one literal token carrying immutable exact bytes, as for byte strings.
Retain its original spelling and source span for formatting and diagnostics.

The first release supports the ordinary quoted form only.
Literal newlines, prefixed backticks, and C# triple-quote delimiters are errors.
Native raw and multiline syntax is deferred, not silently normalized.
This does not prevent translation of C# raw or verbatim UTF-8 literals.
Their decoded values can always use the ordinary target form.

There is no interpolation.
`$name` and `${expression}` are literal text, as in `b"..."`.
They do not evaluate expressions.
Do not reuse ordinary string interpolation or its dollar-escaping printer.

Use ordinary text escape values:
`\"`, `\'`, `\\`, `\0`, `\a`, `\b`, `\f`, `\n`, `\r`, `\t`, and `\v`.
`\x` consumes one through four hexadecimal digits, as in ordinary G# strings.
`\u` consumes exactly four hexadecimal digits.
`\U` consumes exactly eight hexadecimal digits and requires a Unicode scalar.
Unlike `b"\xFF"`, `u8"\xFF"` encodes U+00FF as `C3 BF`, not byte `FF`.
The printer should prefer fixed-width Unicode escapes to ambiguous `\x` forms.

Validate the decoded literal as complete UTF-16 before encoding.
A high surrogate followed by a low surrogate contributes one scalar.
This includes `u8"\uD83D\uDE00"`.
Reject lone or reversed surrogates, malformed escapes, and values above U+10FFFF.
Do not repair them with U+FFFD.
Use shortest-form UTF-8, with no normalization or inserted BOM.
U+FEFF in the literal contributes `EF BB BF`; noncharacters remain scalar values.

Reuse `AppendUtf8Scalar` and source-encoding provenance from the byte lexer.
Do not reuse byte-valued `\x` handling.
Do not route supplementary `\U` escapes through `ReadLongUnicodeEscape` unchanged:
that existing helper returns one `char` and rejects values above U+FFFF.
Keep unrelated ordinary string and character behavior unchanged.
An invalid on-disk source encoding must diagnose before bytes can be repaired.
Interpolation-hole parsing must share the containing document's provenance.

Allocate diagnostic IDs during implementation.
GS0630 is reserved for fixed-array ABI/import failures in #5236; do not reuse it.
This ADR reserves no diagnostic ID.
Assert exact spans for malformed escapes, invalid scalar sequences, bad prefixes,
unsupported raw forms, and unavailable target support.
Recovery must not produce a successful executable containing replacement bytes.

### 4. Logical length and termination

`Length` counts encoded bytes.
Embedded NUL contributes a byte and remains inside the logical length.
Each complete literal has one additional zero byte in its static backing data.
That hidden terminator lies outside the logical length.
An empty literal has logical length zero and a backing terminator.

For example, `u8"A\0é"` contains `41 00 C3 A9`, with length four.
Its complete backing blob is `41 00 C3 A9 00`.
This matches the C# interop contract without treating embedded zero as an endpoint.
Normal indexing cannot read the hidden terminator.
Copies, enumeration, and conversion factories observe only logical contents.
An arbitrary slice does not acquire a terminator at its new logical end.
Do not promise a non-null pointer from ordinary empty-span `fixed` syntax.
Empty-span pinning and `MemoryMarshal.GetReference` have different contracts.

### 5. Storage, lifetime, and emitted metadata

Store bytes and the terminator in compiler-owned RVA fields.
Evaluating a literal constructs a descriptor over those bytes.
It performs no text encoding, managed byte-buffer allocation, cache lookup, or copy.
First-use runtime initialization is not an application allocation guarantee.
Require zero recurring managed allocation in warmed witnesses.
No managed array cache is an acceptable implementation of this contract.

The value may leave its declaring function because its bytes are not stack storage.
Use ordinary managed span lifetime rules for module-backed data.
Do not promise that a detached unmanaged pointer survives module unloading.
No supported writable alias or public ownership-transfer API is introduced.

Prefer verifiable IL using this shape:

```text
ldtoken <private RVA field containing payload and terminator>
call RuntimeHelpers.CreateSpan<byte>(RuntimeFieldHandle)
store descriptor in a planned local
load descriptor address; load 0; load logical length
call ReadOnlySpan<byte>.Slice(int32, int32)
```

[`RuntimeHelpers.CreateSpan`][createspan] accepts an RVA field and supports byte data.
The [runtime implementation][runtime-helpers] requires a recognized intrinsic
sequence for NativeAOT.
Keep `ldtoken` adjacent to its `CreateSpan` call.
Do not hide the handle in a reflective lookup, delegate, or runtime wrapper.
Strict IL verification and actual NativeAOT execution remain acceptance gates.
If this shape fails, stop for a reviewed emission decision.
Do not silently choose allocating storage or suppress verification failures.

[Roslyn's byte-span path][roslyn-emission] instead emits an address-based
`ReadOnlySpan<byte>(void*, length)` construction.
Its success does not prove that a different G# emission shape works.
The proposed managed-helper shape avoids introducing pointer-typed application IL.
It still needs independent JIT, AOT, and verifier evidence.

Reuse `EmitContext`, metadata handles, BCL member references, slot planning,
and deterministic PE serialization.
No current reusable RVA-data registry was found in the inspected emitter.
`ManagedPEBuilder` does not currently receive `mappedFieldData`.
Add only the private field/blob registration needed for these literals.
Do not reuse `DataStructSynthesizer` merely because its name contains “Data”:
it implements source data structs, not a literal blob pool.

Precollect validated blobs before parallel method emission.
Deduplicate by exact complete bytes, including the terminator.
Sort entries lexicographically before assigning fields, offsets, and size types.
Names may use a stable content digest, with exact-byte collision checking.
Resolve collisions deterministically, never by insertion or hash iteration order.
Keep dictionary use to lookup rather than metadata ordering.
Equal values may share storage; cross-module pooling and identity are not contracts.

An RVA field needs an exact-size primitive or private explicit-layout value type.
Do not depend on a proposed native fixed-array feature for that implementation.
Share size descriptors deterministically.
Metadata-only emission keeps public CLR signatures and omits private literal data.
No constant-table entry or custom UTF-8 type annotation is needed.
Reference-assembly consumers see `ReadOnlySpan<byte>`, not the source literal.

### 6. Valid contexts, escape, and async boundaries

Allow inference, assignment, arguments, indexing, slicing, synchronous returns,
and computed properties under existing span rules.
Fields in an eligible `ref struct` use existing restrictions.
Reject ordinary class/static span fields, arrays of spans, boxing, captures,
and unsupported generic uses.
A static property returning a fresh descriptor is valid; a static span field is not.

The literal is not a language or CLR metadata constant.
Reject `const`, attribute arguments, optional-parameter defaults, and constant patterns.
No expression-tree representation is added.

The result is a non-nullable byref-like value.
Empty is not `nil`; nullable span storage is not enabled.
Do not change platform types, imported nullability, or nullable lifting.
Any touched imported signature reader must use the canonical ADR-0193 query APIs.
Keep `--nullability=platform-types` as the default.

Represent a literal root as caller-safe storage in existing escape analysis.
Propagate safety through existing local, conversion, member, and slicing paths.
Do not make arbitrary readonly spans caller-safe because their type matches.
Scoped parameters remain scoped.

Current G# permits ref-struct async locals that are dead before suspension.
Reuse `RefStructAsyncLivenessAnalyzer`, not the obsolete blanket prohibition.
Still reject a live descriptor across `await`, iterator hoisting, or closure capture.
Static bytes do not make a ref-struct state-machine field legal.
Users can reacquire a literal after suspension or explicitly copy to heap storage.

### 7. Literal-only concatenation

Provide native `+` only between UTF-8 literal representations.
Each operand must be a literal or another such concatenation, allowing parentheses.
Validate each literal independently, then concatenate its bytes during compilation.
Emit one payload and one final hidden terminator.
Check combined logical and backing lengths before constructing the blob.

This is not general `ReadOnlySpan<byte> + ReadOnlySpan<byte>` support.
Locals, getters, calls, and conditional expressions do not gain that operator.
A cast or assignment does not preserve “literal representation” status.
No effectful operand may be evaluated, duplicated, or discarded by folding.
Reject mixed text/bytestring/span operands through ordinary diagnostics.
There is no adjacent-literal concatenation or UTF-8 `const` evaluation.
Invalid surrogate halves cannot be repaired by joining separate literals.

This choice preserves C# literal addition directly.
Native folding applies to handwritten and translated G#.
Translator-only folding does not replace this language capability.
Do not emit or introduce general span addition.

### 8. Explicit conversion and ownership boundaries

No new implicit conversions connect the three literal types.
No literal converts implicitly to writable `span[byte]`, arrays, native slices,
bytestring, `ReadOnlyMemory[byte]`, or CLR text.
Existing identity and ordinary span operations remain available.

- `ByteString.CopyFrom(literal)` snapshots only its logical bytes.
  This is heap-storable immutable ownership, with a copy.
- `literal.ToArray()` creates independent mutable CLR array contents.
  Existing array-to-native-slice APIs can then provide a view of that owned array.
- Native readonly slices are heap-storable descriptors with different identity
  and ownership rules; they cannot adopt an RVA pointer through their array ABI.
- Encoding CLR text or decoding bytestring retains ADR-0204's explicit policies.
  Existing BCL UTF-8 decoding APIs remain ordinary explicit calls.
- Pointer interop uses existing unsafe/fixed rules.
  A terminator does not add implicit pointer conversion or automatic marshalling.

Do not add a public bytestring backing-span API as part of this work.
Such an API requires the separate ownership review already required by ADR-0204.

### 9. Faithful cs2gs translation and tooling

Use the existing Roslyn semantic model and literal conversion path.
Ordinary, verbatim, single-line raw, multiline raw, lowercase suffix, and uppercase
suffix forms all have `Utf8StringLiteralExpression`.
Token kinds distinguish ordinary and both raw forms.
Use Roslyn `ValueText`, not suffix trimming, raw source slicing, or manual indentation.
Preserve decoded CR/LF distinctions, NUL, quotes, dollars, and supplementary scalars.
Reject invalid UTF-16 explicitly; `Encoding.UTF8` replacement fallback is not faithful.
Some UTF-8 validity errors arise during Roslyn emit rather than parsing.
A syntax-only success check is insufficient.

Extend existing `LiteralKind` and `LiteralExpression` with one UTF-8-text factory.
Store validated text separately from arbitrary-byte `Bytes` hexadecimal values.
Print canonical `u8"..."` with fixed-width escapes and literal dollar characters.
Do not send it through ordinary string raw selection or bytestring byte escaping.
Source spelling need not survive translation; the exact decoded contents must.
Printer output must reparse to the same literal kind and exact bytes.

Recognize literal-only addition through the original validated expression tree.
Do not infer it merely from the operands' `ReadOnlySpan<byte>` static types.
Keep collision-safe CLR type printing if the native alias cannot be used.
Do not introduce a generic translation framework or target-capability registry.

Change the default translation only after the released target SDK supports it.
At the existing SDK-selection boundary, reject an explicitly older target.
Report the original C# construct and required capability through existing
`TranslationContext.ReportUnsupported` and pipeline triage.
Thread one bounded capability fact only where target selection needs it.
A target lacking `ReadOnlySpan<byte>`, `CreateSpan<byte>`, or its required members
must produce a compiler diagnostic, not array fallback.
Direct translator APIs that do not select an SDK use the translator's documented
minimum supported released target; they must not pretend to detect a target.

Reuse `GNode` author comments and statement/member comment attachment.
Preserve file associations and original C# diagnostic locations.
Current triage does not provide precise reverse coordinates for stage-2 errors.
Keep those coordinates null rather than infer them from transformed literal columns.
No character-level source-map subsystem is proposed.
Test multiline canonicalization and following comments for location drift.

Update token/parser classifications, syntax lookahead, formatter roundtrips,
hover, semantic tokens, REPL highlighting, and both editor grammars.
The compiled REPL path must preserve the same value semantics or diagnose an
unsupported use before evaluation.
Do not provide a separate interpreter string or array representation.

### 10. Acceptance evidence

Each new behavioral test needs ADR-0154 red-before or product-mutant evidence,
then green-after evidence.
The following are required witnesses, not results claimed by this study.

| Area | Discriminating observation and failing implementation |
| --- | --- |
| Bytes and length | Hand-authored `41`, `C3 A9`, `F0 9F 98 80`, embedded `00`, U+007F/U+0080, U+07FF/U+0800, U+D7FF/U+E000, U+10FFFF, U+FEFF, composed/decomposed text, and empty vectors; reject UTF-16 storage, normalization, BOM insertion, or terminator counted in length. |
| Escapes and source | `u8"\xFF"` gives `C3 BF` while `b"\xFF"` gives `FF`; pair escapes produce one scalar; lone/reversed surrogates, malformed digits, and lossy disk decoding report exact diagnostic IDs/spans. |
| Type and readonly | Overloads distinguish `string`, bytestring, writable span, and readonly span; inferred result is readonly byte span; writable element/ref exposure fails. |
| Terminator | An independent C# helper observes the following zero through a fixed reference; logical copying excludes it; embedded zero does not truncate; empty backing uses a reference-aware witness, not ordinary empty-span pinning. |
| Lifetime and scopes | Return literal and derived slice, force collections, then read exact bytes; scoped parameter escape, closure capture, class/static fields, boxing, and unsupported generic arguments still fail. |
| Async | A consumed-before-await local succeeds; a read-after-await local fails; reacquisition after await succeeds. Include nested control flow and iterator restrictions. |
| Allocation and IL | Warm no-inline repeated getters; allocation counter stays zero with a genuinely allocating array control; inspect RVA bytes and method IL for no `newarr`, encoding, or cached-array calls. A heap-backed mutant must fail. |
| Concatenation | Parenthesized literal trees emit one byte sequence and final zero; reject span variables/getters and separately invalid surrogate halves; reject mixed operands and adjacent literals. |
| Ownership | Copy to bytestring and two arrays; mutate each writable export; original bytes and sibling exports remain unchanged; copies exclude hidden zero. |
| Determinism and metadata | Compile identical inputs twice and compare PE bytes; duplicate sites share a verified exact blob; changed source order does not derive metadata from hash enumeration; inspect reference assembly signatures and absence of private payloads. |
| Translation | Execute original C# and real cs2gs-driver output; compare exact stdout bytes, explicit lengths, overload choices, terminator observations, and warmed allocation deltas for ordinary/verbatim/raw/multiline/uppercase/pair-escape/addition cases. Old-target rejection must have original source coordinates. |
| Tooling | Code-model factory/printer/reparse/compiler chain; formatter preserves kind and bytes and is idempotent; comments, hover, coloring, REPL, following-line diagnostics, and null reverse-map coordinates remain correct. |
| Deployment | Strict ILVerify without a feature-specific suppression; emitted G# JIT execution; published NativeAOT execution with exact bytes, terminator, return lifetime, and allocation checks. Parsing alone cannot satisfy any storage gate. |

Reuse `NativeSliceLanguageTests.Fixture`, `IlVerifier`, and `EmittedOracle`
where applicable.
Use the driver and pipeline tests used by cs2gs users, not just `TranslateUnit`.
Keep fixture programs as strings or allowed C# inputs until N-1 permits new syntax.
Record compile-error coverage gaps in issue #5218.
Do not call a printer substring assertion an allocation or semantic witness.

### 11. Bounded implementation sequence

1. Design approval is recorded above.
   The maintainer selected native aliases and native literal-only folding.
   Obtain implementation authorization.
   Preserve the approved encoding, raw deferral, termination, and static-storage contracts.
2. Implement compiler token/binding and minimal static-data emission in G#.
   Reuse existing BCL symbols, escape analysis, metadata, and slot planning.
   Cover diagnostics, exact bytes, type, lifetime, allocation, and strict IL.
3. Complete formatter, IDE, editor grammar, REPL, reference-assembly,
   deterministic-emit, and NativeAOT witnesses.
   Add public specification, lexical, CLR interop, feature matrix, and release notes.
4. Release the language capability.
   Keep the compiler source building with the published SDK already pinned
   in `global.json`; do not raise that pin in the feature implementation.
5. Adopt that published release in a separate SDK-pin PR, with clean-build evidence.
6. Replace cs2gs's array fallback using the existing code model and printer.
   Add real-driver semantic and allocation parity, source locations, and old-target
   diagnostics; update ADR-0115, translator documentation, corpus and coverage data.
   Adopt new syntax in translator source only after the separate pin permits it.

The inspected pin is `Gsharp.NET.Sdk` 0.5.212.
Do not use a local unreleased compiler, change source inclusion, or bypass a defect.
Fix a blocking compiler defect separately using the released compiler.
Wait for its release and a separate pin change before depending on the correction.

### 12. Current implementation touchpoints

Paths below identify the inspected components, not files changed by this study.

| Slice | Existing files and symbols |
| --- | --- |
| Lexing and recovery | `src/Core/CodeAnalysis/Syntax/Lexer.gs`: dispatcher, `ReadByteString`, `AppendUtf8Scalar`, `ValidateByteStringSourceEncoding`; `Text/SourceText.gs` encoding provenance; `SyntaxKind.gs`. |
| Expression parsing | `Parser.Expressions.gs`, `Parser.Expressions.Creation.gs`, `Parser.Declarations.gs`: literal dispatch and statement/expression lookahead. |
| Native aliases | `Parser.TypeClauses.gs`, `TypeClauseSyntax.gs`, `GenericNameExpressionSyntax.gs`; `Binding/Binder.gs: BindTypeClause`; `BinderContext.CanUseNativeBufferAlias`; symbol display and native type completions. Regenerate syntax children with `build/generate-syntax-children.py` when adding child properties. |
| Binding and folding | `Binding/ExpressionBinder.Literals.gs: BindLiteralExpression`; binary-expression binding must distinguish literal representations before ordinary operator lookup. Add one typed static-byte literal bound node and preserve it through rewriting. |
| Escape and async | `Binding/StatementBinder.Jumps.gs: HasFunctionLocalEscapeScope`; `RefCapabilities.gs`; `RefStructAsyncLivenessAnalyzer.gs`; existing closure checks and async capture walker. |
| Emission | `Emit/EmitContext.gs`, `ReflectionMetadataEmitter.gs: WritePe`, `MethodBodyEmitter.Expressions.gs`, `WellKnownReferences.gs`, `MetadataTokenCache.gs`, `ImportedMemberRefFactory.gs`, `MethodBodyPlanner.gs`, and `SlotPlanner.gs`. |
| Existing bytestring comparison | `Symbols/ByteStringTypes.gs`; `src/Sdk/Gsharp.Runtime.Values/ByteString.gs: FromLiteral, CopyFrom, ToArray, ToSlice`. No backing-span API or runtime change is required. |
| cs2gs AST and printing | `tools/cs2gs/Cs2Gs.CodeModel/Ast/LiteralKind.gs`, `Ast/GExpression.gs: LiteralExpression`, `Printing/GSharpPrinter.gs: RenderLiteral`. |
| cs2gs conversion | `Cs2Gs.Translator/CSharpToGSharpTranslator.Expressions.gs: TranslateLiteral`; `.Patterns.gs: TranslateExpression`; `CSharpTypeMapper.gs`; existing binary translation and `TranslationContext.ReportUnsupported`. |
| Driver and mapping | `Cs2Gs.Pipeline/PipelineOptions.gs: SdkVersion`; `TranslateStage.gs`, `CompileStage.gs`, `TriageBuilder.gs`, and `TriageArtifact.gs`; `GNode` comments and `AttachSourceComments` in translator constructors. |
| Formatter and IDE | `src/Formatting/GSharp.Formatting/GSharpFormatter.gs`; language-server `HoverComputer.gs`, `SemanticTokensHandler.gs`, `TypeClauseCompletions.gs`; `src/Repl/Engine/Highlight.gs`. |
| Editors | `src/vscode-gsharp/syntaxes/gsharp.tmLanguage.json` and grammar tests; inspect shared Visual Studio assets and classifiers. Keep Visual Studio implementation in C# and preserve its framework conditionals. |
| Existing test patterns | `ByteStringLexerTests.gs`, `ByteStringLanguageTests.gs`, `ByteStringRuntimeTests.gs`, `ByteStringFormattingTests.gs`, `ByteStringToolingTests.gs`, `Issue2350AsyncRefStructLiveness*Tests.gs`, cs2gs `ByteStringPrinterTests.gs`, and `OahuDecryptTranslationTests.gs`. |

## Study evidence and limitations

During the original study on 2026-10-23, the remote `main` SHA remained
`04069285a4eb967b59182343944ccd20cec61712`.
The latest issue comment at that time was the maintainer's prefix suggestion,
created at `2026-10-23T23:58:43Z`.
Remote ADR enumeration ended at 0210.
The concurrent fixed-array study confirmed that it needs no new ADR number.

A standalone C# fixture used installed .NET SDK 10.0.401, Roslyn 5.9.0.0,
and runtime 10.0.12.
This respects `global.json`'s .NET roll-forward policy; the G# SDK pin was unchanged.
The executable checked Roslyn diagnostics, reflection IL bytes, RVA data,
reference-aware terminators, and warmed thread allocation counters.

- `"Aé😀\0"u8` and its literal-addition equivalent produced
  `41 C3 A9 F0 9F 98 80 00`, logical length eight.
  Both methods referenced the same RVA field and constructed a span of length eight.
  The backing data contained one additional zero.
- `""u8` had length zero and a non-null reference to a zero backing byte.
- 100,000 no-inline literal getter calls measured zero managed allocated bytes.
  A separate no-inline array-returning control measured 10,400,000 bytes.
  That control budget is an observation, not a portable per-array size contract.
- A direct C# array-expression-to-readonly-span control also optimized to static data.
  It was therefore unsuitable as the allocating control.
  G#'s inspected `EmitArrayLiteral` does not implement that Roslyn optimization.
- Ordinary, uppercase, verbatim, and both raw forms used the expected UTF-8
  expression kind; raw forms had distinct token kinds.
  A valid escaped surrogate pair compiled.
  Lone halves and invalid separate concatenation halves produced CS9026.
  Addition with a span-returning call produced CS9047.
  An out-of-range `\U` escape produced CS1009.

The probe initially failed for missing restore assets, then repository C# style
analyzers, then an oversized section read in the probe.
After restoring its assets, disabling style analyzers only for that standalone
fixture, and bounding the read, it completed successfully.
No product compiler settings changed.
Probe sources and final stdout are session artifacts, not product tests.

Validation commands and results:

- `dotnet run --project .utf8-study/Probe.csproj --configuration Release --no-restore -p:RunAnalyzers=false`:
  passed after the fixture corrections described above.
- `git diff --check`: passed.
- A Python check resolved every relative ADR link: passed.
- `cd website && npm run typecheck`: initially failed because `tsc` was absent.
- `cd website && npm ci --quiet`: passed after that missing-tool failure.
- `cd website && npm run typecheck`: passed after dependency installation.
- `cd website && npm run test:content`: passed.
- `cd website && npm run build`: passed.

No G# product code or behavioral tests changed.
No G# solution build, cs2gs driver run, strict ILVerify, NativeAOT execution,
or proposed managed-helper emission was certified by this study.
The measured Roslyn implementation uses the pointer-constructor path.
It does not certify the candidate G# emission.
Those missing proofs are explicit implementation gates.

## Consequences

Handwritten and translated programs gain explicit UTF-8 static data without
changing CLR text or immutable bytestring ownership.
The exact CLR type enables existing APIs and existing ref-safety checks.
The literal does not become a heap-storable UTF-8 string type.

The main new compiler work is RVA data emission, not a runtime value library.
Tooling and translator integration must preserve a distinct literal kind.
Native aliases belong to the initial release and reuse existing CLR span identities.
Native literal-only folding is part of the compiler contract, not only translator lowering.
Raw target syntax and general span concatenation remain outside the first release.

## Alternatives considered

| Alternative | Reason not to select as the recommended contract |
| --- | --- |
| Reuse `b"..."` as a span through target typing | Changes a heap value into a view depending on context and confuses arbitrary bytes with validated text. |
| Add `ByteString.AsSpan` | Requires an ownership review and retains managed-array storage and literal-cache initialization. |
| Translate to array or native slice | Loses the static-data guarantee, terminator contract, and possibly natural type. |
| Runtime `Encoding.UTF8.GetBytes` | Adds encoding and managed allocation to literal evaluation. |
| C# postfix `"..."u8` | Compatible precedent, but does not follow the maintainer's prefix suggestion or the existing byte-prefix style. |
| Defer native span aliases | Not selected. The maintainer explicitly included both aliases in the initial release; CLR spelling remains available for interop and name collisions. |
| Translator-only UTF-8 literal folding | Not selected as a replacement for native folding. Handwritten and translated G# must support the same literal-only operator. |
| General readonly-span `+` | Requires runtime ownership/allocation semantics that are unnecessary for literal folding. |
| Native raw/multiline UTF-8 immediately | Adds delimiter and newline-policy decisions; faithful C# translation needs only escaped target syntax. |
| New UTF-8 wrapper type | Duplicates existing CLR interop and bytestring concerns without solving this issue more directly. |
| Cached managed array as emission fallback | Violates the selected static-data contract; unavailable support must diagnose. |

## References

[csharp-lexical]: https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/lexical-structure#6456-string-literals
[csharp-proposal]: https://github.com/dotnet/csharplang/blob/main/proposals/csharp-11.0/utf8-string-literals.md
[roslyn-emission]: https://github.com/dotnet/roslyn/blob/main/src/Compilers/CSharp/Portable/CodeGen/EmitArrayInitializer.cs
[createspan]: https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.runtimehelpers.createspan?view=net-10.0
[runtime-helpers]: https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/RuntimeHelpers.cs
