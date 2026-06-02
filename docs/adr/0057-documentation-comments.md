# ADR-0057: Documentation comments — Markdown authoring with lossless CLR XML-doc round-trip

- **Status**: Proposed
- **Date**: 2026-06-02
- **Phase**: Hover revamp, Phase 4 (foundational)
- **Related**: issue #388 (hover revamp); ADR-0047 (attribute/annotation syntax); ADR-0051 (property declarations); ADR-0052 (event declarations); ADR-0034 (imported CLR interop); `docs/lexical.md` (Comments); `docs/lsp.md` (hover)

## Context

G# hover (`textDocument/hover`) can show a symbol's *signature* but never its *documentation*, because the language has no doc-comment concept. The lexer scans `//` single-line and `/* */` multi-line comments (`src/Core/CodeAnalysis/Syntax/Lexer.cs:454-524`) and the parser then **discards** every `CommentToken` before parsing (`Parser.cs:35-39`). There is no trivia model and no place on a `Symbol` to carry documentation. Issue #388 identifies this as the foundational blocker for the "doc/metadata" half of class, function, and property hover.

**Enterprise requirement (the decisive constraint).** For G# to be a fully enterprise-ready .NET language, documentation must **round-trip with C# in both directions**:

- **G# → C#**: a C# project that references a G#-compiled library must see G#-authored docs in IntelliSense/hover, including `<summary>`, parameters, returns, and exceptions.
- **C# → G#**: a G# project that references a C# (or BCL/NuGet) library must see that library's docs in G# hover.

In the .NET ecosystem this interchange is **not** carried in assembly metadata. It is carried by a companion **XML documentation file** (`MyLib.dll` + `MyLib.xml`) whose `<member name="…">` entries are keyed by **documentation-comment ID strings** (DocIDs such as `M:Ns.Type.Method(System.Int32)`). C#, VB, and F# all interoperate through exactly this file + DocID scheme. Therefore the canonical interchange format for G# documentation **must be standard .NET XML documentation**, and the compiler must both **emit** an `.xml` file (G#→C#) and **ingest** referenced `.xml` files (C#→G#).

This forecloses two superficially attractive models: **plain Markdown as the stored format** (C# tooling renders XML-doc structure, not Markdown, so Markdown would appear as literal `**` / backticks in C#), and **summary-only docs** (drops the `<param>`/`<returns>`/`<exception>` content C# developers expect). The interchange is XML; the only open question is the *authoring surface* G# exposes.

**Precedents.** **Go** uses plain prose `//` lines (simple, but no structure and no .NET interchange). **C#** uses `///` XML doc comments with the full tag vocabulary (`<summary>`, `<param>`, `<returns>`, `<see cref>`, …) — perfectly round-trippable but verbose and XML-heavy. **Rust** uses `///` Markdown (ergonomic, but no XML-doc interchange). **Kotlin/Java (KDoc/Javadoc)** use Markdown/HTML with `@param`/`@return`/`@throws` block tags — ergonomic *and* structured.

## Decision

Adopt a **two-layer model**: a structured **internal documentation model that is XML-doc-equivalent** (the canonical interchange), with a **Markdown-first authoring surface** (KDoc-style) that maps **bijectively** onto that model. The wire format is always standard .NET XML documentation, so round-trip is lossless; G# developers author in Markdown, not XML.

**Precise definition of "lossless".** G#-authored documentation is lossless for emit (G#→C#) in the following exact sense: every accepted doc block parses into the internal model, and the internal model serializes to XML such that **every XML-doc construct C# can express is reachable from G# source**. This is guaranteed by two mechanisms together: (a) the bijective Markdown subset (§3) covers the common element set, and (b) a **raw-XML escape hatch** (§3) lets authors write any XML-doc element the subset omits, verbatim. There is therefore **no authored construct that cannot round-trip** — the subset is the *ergonomic* path, the escape hatch is the *completeness* guarantee. The only degradation is for Markdown that is neither in the subset nor inside the escape hatch (e.g. a stray `**bold**`); that is a diagnosed authoring error (§9), not silent loss.

### 1. Layering and the round-trip guarantee

- **Internal model** (`DocumentationComment`): summary, per-parameter, per-type-parameter, returns, remarks, value, exceptions, see-also, and inline runs (text / code / element-reference / link / paragraph / list). This is a 1:1 structural mirror of the XML-doc element set G# supports (§4).
- **Authoring → model** (G# source): `///` blocks containing the Markdown surface (§2–§3) parse into the internal model.
- **Model → XML** (emit, G#→C#): the internal model serializes to a standard `.xml` doc file with correct DocIDs (§5). Because the authoring surface is a **defined, bijective subset**, no information authored in G# is lost on emit.
- **XML → model** (ingest, C#→G#): referenced `.xml` files parse into the *same* internal model for hover (§6). Ingestion is **display-only and full-fidelity**: it renders the entire C# XML-doc vocabulary (including constructs outside the G# authoring subset, e.g. `<list type="table">`), because it never needs to re-emit.

The bijection requirement applies only to **G#-authored** content (author → model → XML must be lossless). Ingestion is a one-way render and therefore need not be bijective.

### 2. Lexical form

```
doc_comment_line = "///" { any_char_except_newline } newline
```

- The lexer recognizes a line beginning with exactly `///` and emits a distinct `DocumentationCommentToken` (not a plain `CommentToken`). A leading `///` and one optional following space are stripped; the remainder of the line is doc content. Stripping mirrors the existing `ReadSingleLineComment` (`Lexer.cs:454`), including CRLF handling. The name is `…Token`, **not** `…Trivia`: this ADR does **not** introduce a general Roslyn-style trivia model; it is only a token kind retained in a side-channel (§7).
- The marker is exactly three slashes; a fourth slash is **content**, so dispatch is unambiguous against the existing `/`, `//`, `/* */`, `/=` cases at `Lexer.cs:115-128` (doc detection fires only after at least `//`). Concrete tokenization:
  - `// x` → ordinary comment (discarded).
  - `/// x` → doc content `x`.
  - `///` (nothing after) → doc content `` (blank line; preserved for paragraph breaks).
  - `//// x` → doc content `/ x` (fourth slash is content).
  - `///= x` → doc content `= x` (no interaction with `/=`).
- `//` and `/* */` remain ordinary comments and are discarded as today. There is **no** block doc form (`/** */`) in v1 — block comments are not a settled feature (`docs/lexical.md`).

### 3. Authoring surface (Markdown + KDoc-style block tags)

A documentation block is **Markdown** with a small set of **block tags** for structure. Leading prose (before any tag) is the **summary**. Subsequent block tags introduce structured sections:

| Tag | Maps to | Notes |
|---|---|---|
| *(leading prose)* | `<summary>` | everything before the first block tag |
| `@param name …` | `<param name="name">` | name must match a parameter (§8) |
| `@typeparam name …` | `<typeparam name="name">` | name must match a type parameter |
| `@returns …` | `<returns>` | omitted for `void` |
| `@remarks …` | `<remarks>` | |
| `@value …` | `<value>` | properties |
| `@exception cref …` | `<exception cref="…">` | cref resolved to a DocID (§5) |
| `@seealso cref|href …` | `<seealso>` | |

**Inline content model.** Doc content is an **ordered tree**, not flat arrays: block content is a sequence of paragraphs, code blocks, and lists; each paragraph and each list item is a sequence of inline runs (text, `<c>`, `<see>`, `<paramref>`). Lists are single-level in the subset; **nested lists and multi-paragraph list items require the escape hatch** (below). `<see cref>` has two surface forms that map to the two XML forms: `[text](cref:Target)` → `<see cref="DocID">text</see>` (with inner text) and `[](cref:Target)` / bare `(cref:Target)` → `<see cref="DocID"/>` (self-closing). Fenced code-block language info is preserved as a non-standard `lang` attribute on `<code>` (ignored by C#, recovered on G# re-ingest).

**Inline Markdown subset** (the bijective core — each maps 1:1 to an XML-doc inline/block element):

| Markdown | XML-doc | 
|---|---|
| `` `code` `` | `<c>code</c>` |
| fenced ` ```lang … ``` ` | `<code lang="lang">…</code>` |
| blank-line-separated paragraphs | `<para>…</para>` |
| `- item` / `* item` | `<list type="bullet"><item>…</item></list>` |
| `1. item` | `<list type="number"><item>…</item></list>` |
| `[text](cref:Target)` | `<see cref="DocID">text</see>` (`Target` resolved to a symbol → DocID) |
| `(cref:Target)` | `<see cref="DocID"/>` (self-closing, no inner text) |
| `[text](https://…)` | `<see href="https://…">text</see>` |
| `` [`name`](paramref) `` | `<paramref name="name"/>` |

**Raw-XML escape hatch (completeness guarantee).** Any XML-doc construct the subset omits — `<list type="table">`, nested lists, `<typeparamref>`, `<note>`, custom/DocFX elements, or simply a verbatim element — is authored inside a fenced block tagged `xmldoc`:

````gs
/// ```xmldoc
/// <list type="table">
///   <listheader><term>Name</term><description>Meaning</description></listheader>
///   <item><term>Width</term><description>extent in X</description></item>
/// </list>
/// ```
````

The block's body is parsed as an XML fragment, validated as well-formed, and spliced into the internal model as an `UnknownXmlElement` run (§4). It serializes back out verbatim on emit, so **any** XML-doc construct round-trips losslessly even when no Markdown shorthand exists.

Example:

```gs
/// Computes the area of `r`.
///
/// Returns `Width * Height`; see [Rect](cref:Rect) for field semantics.
///
/// @param r the rectangle to measure
/// @returns the area in square units
/// @exception OverflowException when the product exceeds int32 range
func area(r Rect) int32 {
    return r.Width * r.Height
}
```

**Out-of-subset Markdown** (tables, ATX headings `#`, blockquotes `>`, emphasis `**bold**`/`*italic*`, raw HTML written *outside* an `xmldoc` block) has no XML-doc equivalent and is **not** silently degraded: it raises `GS0230` (§9) pointing the author at either the inline subset or the `xmldoc` escape hatch. This keeps the contract crisp — supported subset *or* explicit raw XML — and avoids the lossy "best-effort text" behavior an earlier draft proposed.

### 4. Internal documentation model

```csharp
public sealed record DocumentationComment(
    ImmutableArray<DocInline> Summary,
    ImmutableArray<DocParam> Parameters,        // name + inlines
    ImmutableArray<DocParam> TypeParameters,
    ImmutableArray<DocInline> Returns,
    ImmutableArray<DocInline> Remarks,
    ImmutableArray<DocInline> Value,
    ImmutableArray<DocException> Exceptions,     // cref + inlines
    ImmutableArray<DocReference> SeeAlso);
// DocInline = Text | Code | CodeBlock(lang) | Para | List | SymbolRef(DocID, inner?) | Link(href) | ParamRef(name) | UnknownXmlElement(rawXml)
```

`Para` and each `List` item hold an ordered `ImmutableArray<DocInline>` (the inline content model of §3). `UnknownXmlElement` carries a verbatim, well-formed XML fragment and is the model node behind both the authoring escape hatch (§3) and **full-fidelity ingestion** (§6): any imported XML element the model has no first-class case for — `<list type="table">`, `<note>`, `<inheritdoc>`, DocFX `<include>`, unknown custom tags — is preserved as `UnknownXmlElement` rather than flattened or dropped, so hover can render it and (for authored content) emit reproduces it byte-for-byte.

The model is exposed on `Symbol`:

```csharp
DocumentationComment? GetDocumentation();   // null when undocumented
```

It is populated from the authored Markdown (G# symbols) or the ingested XML (imported CLR symbols) — a single surface for every IDE feature (hover, signature help, completion).

### 5. Emission — G# → C# (`.xml` doc file + DocIDs)

- **Doc file**: when documentation generation is enabled, the compiler writes a standard `<doc><assembly><name>…</name></assembly><members>…</members></doc>` file next to the assembly. Hook: `Compilation.Emit(...)` (`src/Core/CodeAnalysis/Compilation/Compilation.cs:308`) gains a documentation output stream; `src/Compiler/Program.cs` gains a `--doc <path>` flag (alongside `--out`/`--refout`); `src/Sdk/Gsharp.NET.Sdk/Sdk/Sdk.props` maps the MSBuild `GenerateDocumentationFile` / `DocumentationFile` properties for C# parity.
- **DocID generation (highest-risk item) — a single shared component.** DocID computation lives in one `DocumentationIdProvider` used by **both** emission (source `Symbol`s, §5) and ingestion (reflected `Type`/`MethodInfo`/… from `MetadataLoadContext`, §6). The two paths must never diverge, so they share code and a single golden test corpus. The provider must reproduce Roslyn's `DocumentationCommentId` format exactly. Covered cases (each a golden test against Roslyn output):
  - **Prefixes**: `T:` type, `M:` method/ctor, `P:` property/indexer, `F:` field, `E:` event, `N:` namespace, `!:` error.
  - **Nested types** use `.` (not the CLR `+`): `T:Ns.Outer.Inner`.
  - **Generic arity**: open types `` Type`1``; **method** type parameters `` ``0``/`` ``1`` in both the member arity suffix and parameter positions; constructed generic args as `{…}` (e.g. `System.Collections.Generic.List{System.Int32}`).
  - **Parameters**: fully-qualified type names; by-ref/`out`/`in` → trailing `@`; arrays `[]` and multidim `[0:,0:]`; pointers `*`; function pointers; nullable value types as `System.Nullable{T}` (reference nullability is erased). `params` does **not** affect the ID (only the array type shows).
  - **Operators**: `op_Addition`, … ; conversion operators (`op_Implicit`/`op_Explicit`) carry the `~ReturnType` suffix.
  - **Accessors & members with no own ID**: docs attach to the **property/event** ID (`P:`/`E:`), never the synthesized `get_`/`set_`/`add_`/`remove_` method; indexers are `P:` with a parameter list; explicit interface implementations encode the interface in the member name with `#` for `.`.
- **G# construct → CLR artifact → DocID** (the constructs that are not 1:1 with C# must pin down their emitted shape so a C# consumer's expected DocID matches):

  | G# construct | Emitted CLR shape | DocID form |
  |---|---|---|
  | `func`/method | instance/static method | `M:Ns.Type.Name(params)` |
  | extension/receiver `func (r T) F(...)` | `static` method, receiver as first param | `M:Ns.Ext.F(T,...)` (matches how C# sees the static method; extension-syntax sugar is a C#-side concern) |
  | `data`/`inline`/`ref struct`, `record`, `class` | `struct`/`class` type | `T:Ns.Name` |
  | `interface` | interface type | `T:Ns.IName` |
  | `enum` member | `static literal` field | `F:Ns.Enum.Member` |
  | `prop` (ADR-0051) | property | `P:Ns.Type.Name` |
  | `event` (ADR-0052) | event | `E:Ns.Type.Name` |
  | `package` | namespace / module type | `N:Ns` (package) |
  | top-level `let`/`var`/`const` | static field | `F:Ns.Module.Name` |
  | `import`/alias | *(no CLR member — G#-local; not emitted)* | n/a — see §8 |

  Constructs marked "no CLR member" (import aliases, local variables) are documentable **only** for G#-side hover and are intentionally absent from the emitted `.xml` — they have no identity a C# consumer could key on. The ADR is explicit about this rather than implying everything round-trips.
- **cref resolution**: `[text](cref:Target)` and `@exception cref` resolve `Target` to a symbol at bind time and emit the canonical `cref="T:Ns.Target"` DocID; unresolved crefs warn (§9).

### 6. Ingestion — C# → G# (read referenced `.xml`)

- **Discovery (deterministic search order, per resolved reference)**: (1) sibling `.xml` next to the resolved `.dll`; (2) for framework references, the targeting/ref pack's documentation location (ref assemblies under `packs/` frequently have **no** sibling xml — the docs ship beside the implementation/targeting pack); (3) for NuGet references, the `.xml` beside the selected `lib`/`ref` asset in the package folder; (4) culture fallback (a localized `xx/Asm.xml` then the invariant `Asm.xml`). Missing xml ⇒ docs simply unavailable, **no diagnostic**. Hook: `ReferenceResolver` (`src/Core/CodeAnalysis/Symbols/ReferenceResolver.cs`) already holds the resolved `.dll` paths via `MetadataLoadContext`; it attaches a documentation provider per assembly.
- **Index (lazy + cached)**: BCL xml files are large, so parse each `.xml` **lazily** on first lookup for that assembly and cache the resulting DocID → `<member>` map; never eagerly parse all references.
- **Parsing is XXE-safe**: documentation xml comes from arbitrary NuGet/local references, so it is parsed with DTD processing **prohibited**, `XmlResolver = null`, and bounded size/depth. Malformed xml ⇒ "docs unavailable" for that assembly, never a compilation/hover failure.
- **Resolve**: imported CLR symbols (`ImportedFunctionSymbol`, imported types/properties/fields/events) expose `GetDocumentation()` by computing the member's DocID **via the shared `DocumentationIdProvider` (§5)** — the same component emit uses — looking it up, and parsing the XML fragment into the internal model (§4). Reusing one provider is what makes P1 de-risk P3.
- **Fidelity**: ingestion renders the **full** XML-doc vocabulary; elements with no first-class model case are preserved as `UnknownXmlElement` (§4), not flattened. `<inheritdoc>` resolution (pull docs from the base member/interface) renders as absent in P1 and is a reserved follow-up (§Follow-ups).

### 7. Block formation and attachment

- **Block formation**: consecutive `///` lines on adjacent source lines form one block. A blank line, an ordinary `//` / `/* */` comment, or any other token terminates it. Decided from retained token line spans, not parser state.
- **Attachment (normative algorithm)** — declaration nodes do not exist until parsing, and the parser strips whitespace/comments, so attachment is a **position-based pass over the parsed tree**:
  1. **Lex**: retain `DocumentationCommentToken`s (text + `TextSpan`) in a side-channel; the parser keeps ignoring them, so parsing is unaffected.
  2. **Parse** normally.
  3. **Attach**: group retained tokens into blocks by line-adjacency. For each block, find the nearest documentable declaration whose start lies after it such that, between the block's last line and the declaration's first token (skipping only annotation tokens and single-newline gaps), there is no blank line, no ordinary comment, and no other token. The declaration must be in a **declaration-list context** (compilation unit, type/interface/enum body) and the **same syntactic container** — a block inside a function body never escapes outward.
  4. Store the block text on the declaration node as `LeadingDocumentation`; binding parses it into the model (§4) on the symbol.
  5. Non-attaching blocks (floating, body-internal, EOF) are dropped (candidate for `GS0227`, §9).

`SyntaxToken` is **not** given general trivia; this is the only attachment mechanism.

### 8. Declarations that carry documentation

- functions and methods (incl. extension/receiver) → `FunctionSymbol`
- constructors (`init` / explicit) → `ConstructorSymbol`
- `struct` / `data struct` / `inline struct` / `class` / `record` → `StructSymbol`
- `interface` → `InterfaceSymbol` (a distinct symbol in this codebase, **not** `StructSymbol`)
- `enum` → `EnumSymbol`; enum members → `EnumMemberSymbol`
- `prop` (ADR-0051) → `PropertySymbol`; field declarations → `FieldSymbol`
- `event` (ADR-0052) → `EventSymbol`
- `package` → `PackageSymbol`; top-level `let`/`var`/`const` → `GlobalVariableSymbol`; `import`/alias → `ImportSymbol`

Enum members are attachable within the enum body (doc above a member attaches to it; doc after a comma attaches to the next member). Body-internal docs (above a `let` inside a function) are ignored. Local variables and parameters carry no own docs — parameters are documented via the containing member's `@param`.

### 9. Diagnostics (opt-in; reserved IDs)

- `GS0227` — *(warning)* misplaced/floating doc comment that does not abut a documentable declaration.
- `GS0228` — *(warning)* missing documentation on a public/exported API member (C# `CS1591` analog; opt-in via project setting).
- `GS0229` — *(warning)* `@param`/`@typeparam` name does not match any parameter, or a parameter is undocumented (C# `CS1572`/`CS1573` analog); unresolved `cref` (C# `CS1574` analog).
- `GS0230` — *(warning)* unsupported Markdown construct in a doc comment with no XML-doc equivalent (e.g. `**bold**`, ATX heading, table written as Markdown); the author is directed to the inline subset or the `xmldoc` escape hatch (§3). Raised instead of silently degrading to text.

(GS0226 is already in use by ADR-0056.)

### 10. Hover integration & coverage matrix

- `HoverComputer` (issue #388, Phases 2–3) renders `GetDocumentation()` into hover sections beneath the fenced signature: summary, then `@param`/`@returns`/`@remarks` sections — mirroring Roslyn's `DocumentationComment` → QuickInfo-sections pipeline. Undocumented symbols render the signature only (unchanged).
- Adding `SyntaxKind.DocumentationCommentToken` requires updating **both** `test/Core.Tests/CoverageMatrix/coverage-matrix.golden.txt` and `docs/coverage-matrix.md`, or `CoverageMatrixGoldenTests` fails.

## Implementation phasing

Ordered so value ships early and the high-risk emit work is isolated:

- **P1 — Ingestion + hover (C# → G#)**: the shared `DocumentationIdProvider` (§5, computing DocIDs for **reflected** symbols); `ReferenceResolver` loads sibling `.xml` (XXE-safe, lazy, cached); imported symbols expose `GetDocumentation()`; hover renders C# library docs. **No language change** — pure win, and validates the internal model and the shared DocID component against real C#/BCL XML before emit depends on it.
- **P2 — Authoring + model + hover (G# symbols)**: `///` lexing, attachment pass, Markdown→model parse (incl. the `xmldoc` escape hatch), `Symbol.GetDocumentation()`, hover sections for G#-authored docs.
- **P3 — Emission (G# → C#)**: extend the **same** `DocumentationIdProvider` to source `Symbol`s (golden-tested against Roslyn — see below), deterministic `.xml` writer (stable member ordering, fixed encoding/newlines), `--doc` flag + SDK property, cref→DocID. Closes the round-trip.
- **P4 — Validation**: `GS0227`–`GS0230` diagnostics; `<inheritdoc>` resolution on ingest.

## Consequences

Positive:

- **Full, lossless documentation round-trip with C#/.NET in both directions** — the enterprise requirement — using the ecosystem-standard `.xml` doc file + DocID interchange that C#/VB/F# already share.
- G# developers author in **Markdown** (KDoc-style), not XML — ergonomic and familiar — while the wire format stays canonical XML.
- A single internal `DocumentationComment` model serves hover, signature help, and completion for both G#-authored and imported symbols.
- P1 delivers immediate value (C# library docs in G# hover) with no language change and exercises the riskiest shared piece (DocID computation) against real data before emit depends on it.

Negative:

- **Authoring has two paths, not one**: the ergonomic Markdown subset *plus* a raw-`xmldoc` escape hatch for everything else. Authors who want a construct outside the subset must drop to verbatim XML in an `xmldoc` block — slightly less ergonomic, but the round-trip stays lossless and there is no silent data loss.
- **DocID generation is exacting** — it must match Roslyn byte-for-byte or C# silently shows no docs. This is the dominant implementation risk and must be golden-tested.
- Larger scope than a summary-only model: ingestion, emission, an SDK/MSBuild flag, and a Markdown parser/serializer.

Neutral:

- Ingestion is intentionally asymmetric (full-fidelity display, no bijection) because G# never re-emits C#-authored docs.
- The attachment pass and "no trivia model" decision are unchanged from the prior draft and remain valid.

## Alternatives considered

- **Plain Markdown as the stored/interchange format (no XML)**: rejected — C# tooling renders XML-doc structure, so Markdown appears as literal `**`/backticks to C# consumers, and there is no `.xml` for IntelliSense to read. Fails the round-trip requirement outright. (Markdown survives here only as the *authoring skin* over an XML-equivalent model.)
- **Summary-only docs**: rejected — drops `<param>`/`<returns>`/`<exception>`, which enterprise C# consumers expect; not round-trippable for anything but the summary.
- **Pure C#-style XML authoring (`/// <summary>…</summary>`)**: a valid, perfectly lossless option, but rejected as the *authoring surface* for ergonomics — it is verbose and un-Go-like. We keep its XML as the *interchange* layer and put Markdown on top. (Could be offered later as an alternate input syntax.)
- **Full red/green trivia model**: rejected as disproportionate; the targeted attachment pass suffices.
- **Block doc form (`/** */`)**: deferred until block comments are a settled feature.

## Follow-ups

- `<inheritdoc>` resolution on ingest (and emit), pulling docs from base members/interfaces.
- DocFX/`<include>` file support.
- Per-parameter/per-type-parameter docs surfaced in signature help and parameter hover.
- An alternate **pure-XML authoring** input mode for teams that prefer C# parity.
- `cref` navigation (go-to-definition from a rendered `<see cref>` link in hover).
