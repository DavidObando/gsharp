# ADR-0057: Documentation comments — `///` Markdown doc blocks

- **Status**: Proposed
- **Date**: 2026-06-02
- **Phase**: Hover revamp, Phase 4
- **Related**: issue #388 (hover revamp); ADR-0047 (attribute/annotation syntax); ADR-0051 (property declarations); ADR-0052 (event declarations); `docs/lexical.md` (Comments); `docs/lsp.md` (hover)

## Context

G# hover (`textDocument/hover`) can show a symbol's *signature* but never its *documentation*, because the language has no doc-comment concept. The lexer scans `//` single-line and `/* */` multi-line comments (`src/Core/CodeAnalysis/Syntax/Lexer.cs:454-524`) and the parser then **discards** every `CommentToken` before parsing (`Parser.cs:35-39`). There is no trivia model and no place on a `Symbol` to carry a summary. Issue #388 (the hover revamp) identifies this as the single foundational blocker for the "doc/metadata" half of class, function, and property hover — the C#/Roslyn experience we are chasing surfaces an XML `<summary>` for exactly these cases (`ISymbol.GetDocumentationCommentXml` → `DocumentationComment` → hover "Documentation" section).

We need a doc-comment mechanism that:

- gives an **unambiguous** signal that a comment is documentation (not incidental or code-disabling), so tooling never guesses;
- attaches docs to declarations deterministically, so a symbol can answer "what is your summary";
- renders well in a VSCode hover card (Markdown is the lingua franca of LSP `MarkupContent`);
- fits G#'s Go-flavored, "no hidden behavior" philosophy while staying familiar to C#/Rust/Kotlin developers;
- can later be **carried into** CLR XML documentation so C#/other-language consumers of a G#-emitted assembly see the summary text (with the caveat that Markdown is not XML-doc structure — see Consequences).

Constraints worth calling out: G# block comments are *not yet implemented* in practice (`docs/lexical.md` "Comments"; the `/* */` path exists in the lexer but the language docs treat block comments as unimplemented), so a block-style doc form would force that decision prematurely. And a full Roslyn-style red/green trivia rework is disproportionate to the need — we only need docs attached to *declarations*.

Precedents: **Go** puts plain prose in `//` lines immediately above a declaration (no markers, no tags) — maximally simple but ambiguous with ordinary comments. **C#** uses `///` XML doc comments with a rich tag vocabulary (`<summary>`, `<param>`, `<returns>`, …) — structured and round-trippable but verbose and XML-heavy. **Rust** uses `///` with Markdown content — a clean middle ground that the Markdown-native LSP world renders directly. **Kotlin** (KDoc) uses `/** */` with Markdown plus `@param`/`@return` tags.

## Decision

Introduce **`///` line documentation comments whose content is Markdown**. A contiguous run of `///` lines immediately preceding a declaration (annotations permitted in between) is that declaration's documentation. This is the Rust-style middle ground: an unambiguous doc marker familiar from C#, with Markdown content that renders natively in the hover card.

### 1. Lexical form

```
doc_comment_line = "///" { any_char_except_newline } newline
```

- The lexer recognizes a line beginning with exactly `///` and emits a distinct `DocumentationCommentToken` instead of a plain `CommentToken`. A leading `///` and one optional following space are stripped; the remainder of the line (up to the newline) is the doc content. The `name`/value-stripping mirrors the existing `ReadSingleLineComment` (`Lexer.cs:454`), including CRLF handling. The token is named `…Token` deliberately: this ADR does **not** introduce a general Roslyn-style trivia model; it is only a new token kind retained in a side-channel (§2).
- The marker is exactly three slashes. A fourth slash is **content**, so the dispatch is unambiguous against the existing `/`, `//`, `/* */`, `/=` cases at `Lexer.cs:115-128` (doc detection only fires once at least `//` has been seen). Concrete tokenization:
  - `// x` → ordinary comment (discarded).
  - `/// x` → doc content `x`.
  - `///` (nothing after) → doc content `` (empty line, preserved for Markdown paragraph breaks).
  - `//// x` → doc content `/ x` (the fourth slash is content; only the first `///` and one space are stripped).
  - `///= x` → doc content `= x` (no interaction with `/=`).
  - `/// /path` → doc content `/path`.
- `//` (exactly two slashes) remains an ordinary comment and is discarded as today. `/* */` remains an ordinary block comment. There is **no** block doc form (`/** */`) in v1 — see Alternatives and Follow-ups.
- A `///` line that does **not** attach to a declaration (§2) is still lexed as a `DocumentationCommentToken` but carries no semantic meaning — it is ignored, exactly like an ordinary comment. v1 raises **no** diagnostic for such a "floating" doc comment, but reserves diagnostic id `GS0227` (category: documentation) for an opt-in warning in a follow-up (§Follow-ups). The id is reserved here only to avoid collisions; it is not emitted in v1.

### 2. Block formation and attachment

- **Block formation**: consecutive `///` lines on adjacent source lines (line N, N+1, …) form one documentation block. A blank line, or an ordinary `//` / `/* */` comment, or any other intervening token, terminates the block. Block formation is purely line-adjacency over `DocumentationCommentToken`s and is decided from retained token line spans, not from parser state.
- **Attachment**: a documentation block attaches to the declaration that immediately follows it within the **same declaration-list context** (see below). "Immediately" permits intervening **annotations** (`@Foo`, ADR-0047) and insignificant newlines, but **not** a blank line (a gap of two or more line terminators) and **not** an intervening ordinary comment between the doc block and the first annotation/declaration token. This mirrors Go's "doc comment must abut the declaration" rule and avoids accidental capture.

#### Attachment algorithm (normative)

Because declaration nodes do not exist until parsing, and the parser strips whitespace/comments, attachment is a **position-based pass over the parsed tree** using retained doc-token spans plus the source line map — not a pre-parse guess:

1. **Lex**: retain `DocumentationCommentToken`s (with their text and `TextSpan`) in a side-channel keyed by line. The parser continues to ignore them, so existing parsing is unaffected.
2. **Parse** normally.
3. **Attach pass**: group retained doc tokens into blocks by line-adjacency (above). For each block, find the **nearest documentable declaration node whose start lies after the block** such that, between the block's last line and the declaration's first token (skipping only annotation tokens and single-newline gaps), there is no blank line, no ordinary comment, and no other token. The declaration must be in a **declaration-list context** (compilation unit, type/struct/class/interface/enum body) and in the **same syntactic container** as the block — a block inside a function body never escapes to attach to an outer declaration.
4. Store the block's joined text (lines joined with `\n`, trailing/leading blank lines trimmed) on the declaration node as `LeadingDocumentation` (a string). Binding copies it onto the symbol (§5).
5. Any doc block that does not attach (floating, body-internal, or end-of-file with no following declaration) is dropped (and is the candidate for the reserved `GS0227` diagnostic later).

`SyntaxToken` is **not** given general leading/trailing trivia; this is the only doc-attachment mechanism.

### 3. Declarations that carry documentation

Documentation may precede, and is surfaced for, the following declarations (and their corresponding symbols):

- functions and methods (incl. extension/receiver functions) → `FunctionSymbol`
- constructors (`init` / explicit constructors) → `ConstructorSymbol`
- types: `struct`, `data struct`, `inline struct`, `class`, `record` → `StructSymbol`
- `interface` declarations → `InterfaceSymbol` (interfaces are a distinct symbol in this codebase, not a `StructSymbol`)
- `enum` declarations → `EnumSymbol`; individual enum members → `EnumMemberSymbol`
- `prop` declarations (ADR-0051) → `PropertySymbol`
- field declarations → `FieldSymbol`
- `event` declarations (ADR-0052) → `EventSymbol`
- `package` declarations → `PackageSymbol`
- top-level `let`/`var`/`const` bindings → `GlobalVariableSymbol`
- `import` declarations / aliases → `ImportSymbol`

**Enum members** are attachable within the enum body even though they are list elements rather than statement-shaped declarations. A doc block on the line(s) immediately above a member attaches to that member; a doc block after a member's comma but before the next member attaches to the **next** member:

```gs
type Color enum {
    /// The primary warning color.
    Red,
    /// The all-clear color.
    Green
}
```

**Body-internal docs are ignored.** Documentation is only considered in declaration-list contexts (compilation unit, type/interface/enum bodies). A `///` block inside a function body or expression context (e.g. above a `let`) does not attach to anything and is dropped:

```gs
func f() {
    /// not documentation — ignored
    let x = 1
}
```

Local variables and parameters do **not** carry documentation (consistent with C#, which documents parameters via the *containing method's* `<param>` tags rather than at the local site). Per-parameter docs are deferred to the structured-tags follow-up.

### 4. Content model — Markdown, summary-only in v1

The documentation block is **free-form Markdown** and is treated in its entirety as the symbol's **summary**. There is no tag vocabulary in v1 — no `<summary>`, no `<param>`, no `<returns>`. Rationale: the immediate consumer is the hover card, which renders Markdown directly; the summary alone closes the doc half of hover requests 1, 2, and 3 in issue #388. Structured sections (`params`/`returns`/`remarks`/`typeparam`/`exception`) are explicitly deferred (§Follow-ups) so we do not litigate an XML-vs-`@tag` syntax before the simpler win ships.

```gs
/// Computes the area of the rectangle.
///
/// The result is `Width * Height` and never negative for valid inputs.
func area(r Rect) int32 {
    return r.Width * r.Height
}
```

Hovering `area` renders the signature fence followed by the Markdown summary as a prose section (the multi-section hover model from issue #388, Phase 3).

### 5. Symbol surface

Add a documentation accessor to the symbol model so any IDE feature can read it uniformly:

```csharp
// On Symbol (or via a dedicated provider):
string? DocumentationSummary { get; }   // raw Markdown, or null when undocumented
```

The accessor is populated during binding from the declaration's `LeadingDocumentation`. A forward-compatible shape is to expose a small `DocumentationComment` record (`Summary` now; `Params`/`Returns`/`Remarks`/`Exceptions` reserved for the follow-up) so the structured upgrade does not change the call sites.

### 6. Hover integration

`HoverComputer` (issue #388, Phases 2–3) renders `DocumentationSummary` as the hover's prose section beneath the fenced signature:

```
```gsharp
func area(r Rect) int32
```

Computes the area of the rectangle.

The result is `Width * Height` and never negative for valid inputs.
```

When `DocumentationSummary` is null, hover output is unchanged from today (signature only).

### 7. Coverage matrix

Adding a `SyntaxKind` (`DocumentationCommentToken`) requires updating **both** `test/Core.Tests/CoverageMatrix/coverage-matrix.golden.txt` and `docs/coverage-matrix.md`, or `CoverageMatrixGoldenTests` fails. The implementation PR must include those updates.

### 8. Implementation constraints / required tests

The implementation PR must cover at least:

- **Lexer slash-count cases**: `// x`, `/// x`, `///` (empty), `//// x` (content `/ x`), `///= x` (content `= x`), `/// /path`; CRLF and LF line endings.
- **Block formation**: adjacent `///` lines merge; a blank line, an ordinary `//`, or any other token breaks the block.
- **Attachment positive**: doc attaches across intervening annotations (`@Foo`) with no blank line; attaches to func, constructor, struct/class/interface, enum, enum member, prop, field, event, package, top-level binding, and import.
- **Attachment negative**: blank line between doc and declaration → not attached; ordinary comment between doc and declaration → not attached; doc inside a function body → not attached; doc at end of file with no following declaration → not attached.
- **Same-container**: a doc block inside a body never attaches to an outer declaration.
- **Hover**: documented symbol renders summary section; undocumented symbol renders signature only (unchanged).
- **Coverage matrix**: golden + `docs/coverage-matrix.md` updated for the new `SyntaxKind`.

## Consequences

Positive:

- Unblocks the documentation half of hover requests 1, 2, 3 in issue #388 with a minimal, Markdown-native model that VSCode renders for free.
- `///` is an unambiguous doc signal — no heuristic guessing whether a `//` comment is documentation — while remaining instantly familiar to C#/Rust developers.
- Markdown content is strictly more expressive in a hover card than escaped XML, and needs no tag parser in v1.
- The targeted doc-attachment pass avoids a disproportionate red/green trivia rework; `SyntaxToken` is untouched, limiting blast radius on parser/emit.
- Forward-compatible: the `DocumentationComment` shape and the `///` marker leave room for structured tags and CLR XML-doc emission without re-litigating syntax.

Negative:

- Markdown-as-summary does not, by itself, produce the structured `<param>`/`<returns>` sections C# shows; those await the follow-up. v1 hover shows a single summary blob.
- Two slash-count-sensitive forms (`//` vs `///`) add a small lexer subtlety (the fourth-slash-is-content rule must be specified and tested).
- No CLR XML-doc file is emitted in v1, so C# consumers of a G#-emitted assembly do not yet see these docs (deferred).

Neutral:

- The attachment rule (doc must abut the declaration, annotations allowed in between) must be specified precisely and covered by tests for the annotation-interleaving case.
- "Floating" doc comments are silently ignored in v1; a lint/diagnostic for misplaced docs can be added later if desired.

## Alternatives considered

- **Go-style plain `//` docs (any comment directly above a declaration is its doc)**: rejected for v1 because it is ambiguous — incidental comments and temporarily commented-out code above a declaration would be captured as documentation. An explicit `///` marker removes the guesswork while keeping the "abuts the declaration" attachment rule that makes Go's model pleasant.
- **C#-style `///` XML doc comments with full tag vocabulary**: rejected as the v1 content model because it front-loads the entire tag-syntax decision and an XML parser before the simplest, highest-value outcome (show the summary) ships. The `///` *marker* is adopted; the XML *content* is not. Structured tags are a deliberate follow-up.
- **KDoc-style `/** */` Markdown block docs**: rejected for v1 because G# block comments are not yet a settled, implemented feature (`docs/lexical.md`); choosing a block doc form would force that decision prematurely. Can be added later as an equivalent block form once block comments land.
- **Full Roslyn-style red/green trivia model on `SyntaxToken`**: rejected as disproportionate. We only need docs on declarations; a targeted attachment side-channel achieves that with far less risk to the parser and emitter.
- **`@tag`-based structured docs (Markdown with `@param`/`@returns` lines) in v1**: deferred — useful, but bundling it now couples the foundational "retain and attach docs" work to a content-syntax debate. Decoupling ships value sooner and keeps this ADR's decision crisp.

## Follow-ups

- **Structured documentation tags** (`params`, `returns`, `remarks`, `typeparam`, `exception`): a follow-up ADR choosing the syntax (XML `<param>` vs Markdown `@param` lines) and mapping each to a dedicated hover section, paralleling Roslyn's `DocumentationComment` groups.
- **CLR XML-doc emission**: emit a companion `.xml` documentation file (and/or `<summary>` metadata). Note that v1 stores **Markdown**, not XML-doc structure: emission would place the Markdown summary inside a `<summary>` element (XML-escaped), which preserves the text but not C# XML-doc semantics — Markdown links/code spans become plain text unless a follow-up translates them. The "structured tags" follow-up is the natural place to produce richer XML.
- **Block doc form** (`/** */`) once block comments are a settled language feature.
- **`<see cref>`-style cross-references** resolved to symbols for navigable, colorized links in hover (Roslyn `CrefToSymbolDisplayParts`).
- **Per-parameter / per-type-parameter docs** surfaced in signature help and parameter hover.
- **Misplaced-doc diagnostic**: optionally warn (reserved `GS0227`) on a `///` block that does not abut a documentable declaration.
