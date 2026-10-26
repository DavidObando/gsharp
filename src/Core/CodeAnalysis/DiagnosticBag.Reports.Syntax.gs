// <copyright file="DiagnosticBag.Reports.Syntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

partial class DiagnosticBag : IEnumerable[Diagnostic] {
    /// Reports a bad character during lexing.
    /// @param location The text location where the error was found.
    /// @param character The unexpected bad character.
    func ReportBadCharacter(location TextLocation, character char) -> Report(
        location,
        DiagnosticDescriptors.BadCharacter,
        character
    )

    /// Reports an unterminated comment.
    /// @param location The text location where the error was found.
    func ReportUnterminatedComment(location TextLocation) -> Report(location, DiagnosticDescriptors.UnterminatedComment)

    /// Reports an unterminated string literal.
    /// @param location The text location where the error was found.
    func ReportUnterminatedString(location TextLocation) -> Report(location, DiagnosticDescriptors.UnterminatedString)

    /// Reports malformed exact-byte literal syntax.
    func ReportInvalidByteStringLiteral(location TextLocation, reason string) -> Report(
        location,
        DiagnosticDescriptors.InvalidByteStringLiteral,
        reason
    )

    /// Reports a missing or incompatible immutable-byte-string runtime.
    func ReportByteStringRuntime(location TextLocation) -> Report(location, DiagnosticDescriptors.ByteStringRuntime)

    internal func ReportInvalidUtf8StringLiteral(location TextLocation, reason string) -> Report(
        location,
        DiagnosticDescriptors.InvalidUtf8StringLiteral,
        reason
    )

    /// Reports a number literal as invalid.
    /// @param location The text location where the error was found.
    /// @param text Text found in the source document.
    /// @param type Expected type.
    func ReportInvalidNumber(location TextLocation, text string, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.InvalidNumber,
        text,
        type
    )

    /// Reports an unexpected token while parsing.
    /// @param location The text location where the error was found.
    /// @param actualKind The kind of syntax encountered.
    /// @param expectedKind The kind of syntax expected.
    func ReportUnexpectedToken(location TextLocation, actualKind SyntaxKind, expectedKind SyntaxKind) -> Report(
        location,
        DiagnosticDescriptors.UnexpectedToken,
        actualKind,
        expectedKind
    )

    /// Reports that the `inline` modifier was combined with `data` or `record`.
    /// @param location The text location of the conflicting modifier.
    func ReportInlineCannotBeCombinedWithData(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.InlineCannotBeCombinedWithData
    )

    /// Reports that inline and open modifiers were combined.
    /// @param location The text location of the conflicting modifier.
    func ReportInlineCannotBeCombinedWithOpen(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.InlineCannotBeCombinedWithOpen
    )

    /// Reports that the `record` alias cannot be combined with the `data` contextual keyword.
    /// @param location The text location of the `data` keyword.
    func ReportRecordCannotBeCombinedWithDataKeyword(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.RecordCannotBeCombinedWithDataKeyword
    )

    /// Reports that the `async` modifier was used in a type-clause position
    /// without being followed by `sequence` or `func` (ADR-0042 / ADR-0043).
    /// @param location The text location of the `async` modifier.
    /// @param actualKind The kind of the token actually following `async`.
    func ReportAsyncModifierInTypeClauseRequiresSequenceOrFunc(location TextLocation, actualKind SyntaxKind) -> Report(
        location,
        DiagnosticDescriptors.AsyncModifierInTypeClauseRequiresSequenceOrFunc,
        actualKind
    )

    /// Reports that top-level statements appear in more than one *package* in
    /// the same compilation, which is not allowed (ADR-0066). The earlier
    /// ADR-0028 widened the rule from "one source file" to "one package";
    /// the message text matches the package-scoped rule the binder actually
    /// enforces.
    /// @param location A location in one of the offending files.
    func ReportMultipleTopLevelFiles(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.MultipleTopLevelFiles
    )

    /// Reports that the compilation contains both top-level statements and an
    /// explicit Main function, which is ambiguous. ADR-0066 D6: this is a
    /// warning rather than an error — when both shapes coexist, the
    /// synthesized top-level entry point wins and the explicit Main is
    /// shadowed. C# behaves the same way (CS7022 is a warning).
    /// @param location The location of the explicit Main function declaration.
    func ReportTopLevelStatementsConflictWithMain(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.TopLevelStatementsConflictWithMain
    )

    /// ADR-0066 D2: reports that top-level statements mix bare `return;` and
    /// `return <expr>;` shapes. The synthesized entry point has a
    /// single return type (either `void` or `int`), so the user must
    /// pick one return shape across all TLS.
    /// @param location The location of the first offending return statement.
    func ReportTopLevelReturnShapeMismatch(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.TopLevelReturnShapeMismatch
    )

    /// ADR-0067: reports that a field declaration inside a `struct`,
    /// `class`, or `shared` block was written without a leading
    /// `var` or `let` keyword. Field declarations now require
    /// one of these binding keywords to distinguish mutable (`var`)
    /// from read-only (`let`) storage and to keep type bodies
    /// visually consistent with property, event, and method members.
    /// @param location The location of the offending token.
    func ReportFieldDeclarationRequiresVarOrLet(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.FieldDeclarationRequiresVarOrLet
    )

    /// Reports that top-level statements within a single source file are not
    /// contiguous — they are split into two or more blocks separated by a
    /// type or function declaration (ADR-0066 deferred decision D5). Emitted
    /// as a <b>warning</b> so the established G# Go-style trailing-TLS
    /// idiom (decls first, then a single TLS block) keeps working
    /// unchanged, while genuinely interleaved layouts still surface a hint.
    /// @param location The location of the misplaced top-level statement.
    func ReportTopLevelStatementsMustBeContiguous(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.TopLevelStatementsMustBeContiguous
    )

    /// ADR-0066 deferred decision D4: reports that top-level statements appear
    /// in a compilation that produces a library, not an executable. Mirrors
    /// C#'s CS8805. Without this guard the binder would silently synthesize
    /// a `<Main>$` inside the emitted `.dll` that the runtime
    /// will never invoke.
    /// @param location The location of the first offending top-level statement.
    func ReportTopLevelStatementsInLibrary(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.TopLevelStatementsInLibrary
    )

    /// Reports an accessibility modifier (`public`/`internal`/`private`) appearing on a construct that does
    /// not accept one.
    /// @param location The text location of the modifier token.
    /// @param modifier The modifier text.
    func ReportAccessibilityModifierNotAllowedHere(location TextLocation, modifier string) -> Report(
        location,
        DiagnosticDescriptors.AccessibilityModifierNotAllowedHere,
        modifier
    )

    /// Reports a character literal that is missing a closing quote or
    /// whose body crosses a line terminator (ADR-0046).
    /// @param location The literal's location.
    func ReportUnterminatedCharLiteral(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.UnterminatedCharLiteral
    )

    /// Reports an empty character literal `''` (ADR-0046).
    /// @param location The literal's location.
    func ReportEmptyCharLiteral(location TextLocation) -> Report(location, DiagnosticDescriptors.EmptyCharLiteral)

    /// Reports a character literal containing more than one code unit
    /// (e.g. `'ab'`) per ADR-0046.
    /// @param location The literal's location.
    func ReportMultiCharCharLiteral(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.MultiCharCharLiteral
    )

    /// Reports an unknown escape sequence inside a character literal
    /// (ADR-0046).
    /// @param location The literal's location.
    /// @param escapeChar The unrecognised escape character.
    func ReportInvalidCharEscape(location TextLocation, escapeChar char) -> Report(
        location,
        DiagnosticDescriptors.InvalidCharEscape,
        escapeChar
    )

    /// Reports a malformed Unicode escape (`\\u`, `\\U`, or
    /// `\\x`) inside a character literal: too few hex digits, or in
    /// the case of `\\U`, a value outside the basic multilingual
    /// plane (ADR-0046).
    /// @param location The literal's location.
    func ReportInvalidUnicodeEscape(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.InvalidUnicodeEscape
    )

    /// Reports an unrecognized backslash escape sequence inside a double-quoted
    /// string literal. Issue #531: interpreted strings now process C#/Go style
    /// escape sequences; any `\X` that is not in the recognized set is an
    /// error.
    /// @param location The source location of the escape sequence.
    /// @param escapeChar The character following the backslash.
    func ReportInvalidStringEscape(location TextLocation, escapeChar char) -> Report(
        location,
        DiagnosticDescriptors.InvalidStringEscape,
        escapeChar
    )

    /// Reports an annotation lead-in (`@`) that is not followed by an
    /// identifier or a use-site target qualifier (ADR-0047 §1).
    /// @param location The source location of the offending token.
    func ReportAnnotationExpected(location TextLocation) -> Report(location, DiagnosticDescriptors.AnnotationExpected)

    /// Reports an annotation use-site target qualifier whose kind is not one
    /// of the canonical kinds defined in ADR-0047 §2 (`field`,
    /// `param`, `return`, `type`, `method`,
    /// `property`, `event`, `module`, `assembly`,
    /// `genericparam`).
    /// @param location The source location of the offending kind identifier.
    /// @param kind The unrecognized kind text.
    func ReportAnnotationTargetInvalid(location TextLocation, kind string) -> Report(
        location,
        DiagnosticDescriptors.AnnotationTargetInvalid,
        kind
    )

    /// Reports GS0206 when an annotation lead-in (`@Name`) precedes a
    /// statement that does not accept annotations (only local
    /// `var`/`let`/`const` declarations do — see ADR-0047 §2
    /// and issue #187).
    /// @param location The source location of the leading `@`.
    func ReportAnnotationsNotAllowedOnStatement(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.AnnotationsNotAllowedOnStatement
    )

    /// ADR-0175 (#3820/#3824): reports GS9305 when a
    /// `@SuppressDiagnostic` annotation's argument is not a constant
    /// string shaped like a diagnostic identifier.
    /// @param location The source location of the offending argument.
    /// @param text The rejected argument text.
    func ReportSuppressDiagnosticInvalidId(location TextLocation, text string) -> Report(
        location,
        DiagnosticDescriptors.SuppressDiagnosticInvalidId,
        text
    )

    /// ADR-0186 §9: reports GS9307 when an `@Oblivious` or
    /// `@NullabilityEnabled` scope annotation is written in a shape it
    /// does not support — with arguments, with a target specifier, or both on
    /// one declaration.
    /// @param location The source location of the offending syntax.
    /// @param annotationName The annotation as written (`@Oblivious` / `@NullabilityEnabled`).
    /// @param problem What is wrong with it.
    func ReportNullabilityScopeAnnotationInvalid(
        location TextLocation,
        annotationName string,
        problem string
    ) -> Report(location, DiagnosticDescriptors.NullabilityScopeAnnotationInvalid, annotationName, problem)

    /// ADR-0055: reports an interpolation hole whose alignment clause
    /// (`${expr,alignment}`) is not a constant integer.
    /// @param location The text location of the offending hole.
    /// @param text The offending alignment text.
    func ReportInvalidInterpolationAlignment(location TextLocation, text string) -> Report(
        location,
        DiagnosticDescriptors.InvalidInterpolationAlignment,
        text
    )

    /// Issue #368: reports an interpolated string passed to an
    /// `[InterpolatedStringHandler]` parameter whose
    /// `[InterpolatedStringHandlerArgument]` forwarding could not be
    /// satisfied (an unknown referenced argument, a missing receiver, or no
    /// matching handler constructor).
    /// @param location The text location of the interpolated argument.
    /// @param reason A human-readable description of the failure.
    func ReportInterpolatedStringHandlerArgument(location TextLocation, reason string) -> Report(
        location,
        DiagnosticDescriptors.InterpolatedStringHandlerArgument,
        reason
    )

    /// ADR-0055: reports an interpolation hole (`${ … }`) that is never
    /// closed by a matching `}` before the end of the source.
    /// @param location The text location of the unterminated hole.
    func ReportUnterminatedInterpolationHole(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.UnterminatedInterpolationHole
    )

    /// ADR-0055: reports an empty interpolation hole (`${}`), which has no
    /// expression to evaluate.
    /// @param location The text location of the empty hole.
    func ReportEmptyInterpolationHole(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.EmptyInterpolationHole
    )

    /// ADR-0055: reports an interpolation hole whose format clause is present
    /// but empty (`${expr:}`).
    /// @param location The text location of the offending hole.
    func ReportEmptyInterpolationFormat(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.EmptyInterpolationFormat
    )

    /// ADR-0055: reports a raw newline in the literal portion of an
    /// interpolated string. Newlines are only permitted inside `${ … }`
    /// holes, not in the literal text segments.
    /// @param location The text location of the newline.
    func ReportNewlineInInterpolatedStringLiteral(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.NewlineInInterpolatedStringLiteral
    )

    /// ADR-0057 §P4: reports a documentation comment block that does not precede
    /// any documentable declaration (a "floating" doc comment).
    /// @param location The text location of the floating documentation comment.
    func ReportFloatingDocumentationComment(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.FloatingDocumentationComment
    )

    /// ADR-0057 §P4: reports a public API member that lacks documentation (opt-in via /warnondoc or similar
    /// mechanism).
    /// @param location The text location of the undocumented declaration.
    /// @param symbolName The undocumented public symbol name.
    func ReportMissingDocumentation(location TextLocation, symbolName string) -> Report(
        location,
        DiagnosticDescriptors.MissingDocumentation,
        symbolName
    )

    /// ADR-0057 §P4: reports a @param or @typeparam tag whose name does not match
    /// any parameter in the documented member's signature.
    /// @param location The text location of the documented declaration.
    /// @param paramName The unmatched parameter or type-parameter name.
    /// @param symbolName The documented symbol name.
    func ReportDocParamMismatch(location TextLocation, paramName string, symbolName string) -> Report(
        location,
        DiagnosticDescriptors.DocParamMismatch,
        paramName,
        symbolName
    )

    /// ADR-0057 §P4: reserved for unsupported Markdown constructs that cannot be
    /// represented in the documentation model.
    /// @param location The text location of the unsupported Markdown construct.
    /// @param detail Details about the unsupported Markdown construct.
    func ReportUnsupportedDocumentationMarkdown(location TextLocation, detail string) -> Report(
        location,
        DiagnosticDescriptors.UnsupportedDocumentationMarkdown,
        detail
    )

    /// Reports GS0231 when a documentation comment contains an unknown block tag
    /// (e.g. `@return` instead of `@returns`).
    /// @param location The location of the documentation comment.
    /// @param tagName The unrecognised tag text.
    func ReportUnknownDocumentationTag(location TextLocation, tagName string) -> Report(
        location,
        DiagnosticDescriptors.UnknownDocumentationTag,
        tagName
    )

    /// ADR-0059 / issue #255: reports that a delegate declaration
    /// (`type Name = delegate …`) was not followed by a `func(...)`
    /// signature. Named delegates must take the shape
    /// `type Name = delegate func(params) ret`.
    /// @param location The text location of the offending token.
    func ReportDelegateDeclarationRequiresFunc(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.DelegateDeclarationRequiresFunc
    )

    /// Issue #3510: reports the retired `type Name = delegate func(...)`
    /// delegate spelling, pointing at the canonical
    /// `delegate Name(parameters) ReturnType;` replacement.
    /// @param location The text location of the legacy `type` token.
    /// @param delegateName The declared delegate name, spliced into the migration suggestion.
    func ReportRetiredDelegateDeclarationForm(location TextLocation, delegateName string) -> Report(
        location,
        DiagnosticDescriptors.RetiredDelegateDeclarationForm,
        delegateName
    )

    /// ADR-0182 / issue #4240: reports the retired ADR-0165
    /// `func extension (receiver Type) Name(...)` marker. Every
    /// receiver clause is unconditionally an extension now, so the marker
    /// is redundant; the fix is to delete the `extension` word.
    /// @param location The text location of the `extension` token.
    func ReportRetiredExplicitExtensionReceiverModifier(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.RetiredExplicitExtensionReceiverModifier
    )

    /// Reports that the identifier `null` was used where the G# null
    /// literal `nil` is required. G# does not recognise `null` as
    /// a keyword — the correct spelling is `nil` (ADR-0081).
    /// @param location The source location of the `null` identifier.
    func ReportUseNilInsteadOfNull(location TextLocation) -> Report(location, DiagnosticDescriptors.UseNilInsteadOfNull)

    /// ADR-0074 / issue #714: GS0302 (warning) — a switch-expression arm
    /// used the deprecated `->` separator. The token is being
    /// repurposed as the lambda-expression arrow; arms should use `:`.
    /// One release of overlap is provided; the `->` form is removed
    /// in a later release.
    /// @param location The source location of the offending `->` token.
    func ReportSwitchExpressionArmArrowDeprecated(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.SwitchExpressionArmArrowDeprecated
    )

    /// ADR-0075 / issue #715: GS0303 (warning) — a type-clause slot used the
    /// legacy `func(T1, T2, ...) R` spelling. The canonical form is the
    /// arrow function type `(T1, T2, ...) -> R` (Kotlin/Swift style).
    /// Both forms are accepted for one release; the legacy form is removed in
    /// a later release.
    /// @param location The source location of the offending `func` keyword.
    func ReportFunctionTypeClauseFuncKeywordDeprecated(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.FunctionTypeClauseFuncKeywordDeprecated
    )

    /// ADR-0077 / issue #717: GS0305 — the legacy short variable-declaration
    /// operator `:=` has been removed. Every binding site must spell
    /// `let name = expr` (immutable) or `var name = expr` (mutable).
    /// The lexer continues to tokenise `:=` so the parser can emit a
    /// single high-quality diagnostic at the offending token rather than
    /// cascading parse errors.
    /// @param location The source location of the offending `:=` token.
    /// @param migration A context-specific replacement snippet
    /// (e.g. `let x = 1` or `var x = 1`) shown in the message.
    func ReportColonEqualsRemoved(location TextLocation, migration string) -> Report(
        location,
        DiagnosticDescriptors.ColonEqualsRemoved,
        migration
    )

    /// ADR-0078 / issue #718: GS0306 — the legacy `type Name <agg-kw> ...`
    /// declaration head has been removed. The aggregate-kind keyword
    /// (`class`, `struct`, `enum`, `interface`) is now the
    /// declaration keyword and precedes the name. The diagnostic message includes
    /// a concrete migration snippet so existing code can be ported by hand or
    /// with a mechanical rewrite.
    /// @param location The source location of the offending `type` keyword.
    /// @param migration A context-specific replacement snippet (e.g. `class Point(x, y int32)`).
    func ReportOldTypeDeclarationFormRemoved(location TextLocation, migration string) -> Report(
        location,
        DiagnosticDescriptors.OldTypeDeclarationFormRemoved,
        migration
    )

    /// ADR-0078 / issue #718: GS0307 — the `record` contextual keyword has
    /// been deleted. Records are spelled `data class` (reference) or
    /// `data struct` (value) with the aggregate keyword as the
    /// declaration head.
    /// @param location The source location of the offending `record` identifier.
    /// @param name The aggregate name (used to build the migration snippet).
    func ReportRecordKeywordRemoved(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.RecordKeywordRemoved,
        name,
        name
    )

    /// ADR-0078 / issue #718: GS0308 — `inline` is only valid on
    /// `struct`. `inline class` is rejected because the inline value
    /// class (newtype) form only makes sense for value types.
    /// @param location The source location of the offending `inline` modifier.
    func ReportInlineOnlyValidOnStruct(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.InlineOnlyValidOnStruct
    )

    /// ADR-0078 / issue #718: GS0309 — `open` is only valid on
    /// `class`. Structs are value types and cannot be subclassed; enums and
    /// interfaces define their own openness model.
    /// @param location The source location of the offending `open` modifier.
    /// @param kindName The kind keyword that follows (e.g. `struct`).
    func ReportOpenOnlyValidOnClass(location TextLocation, kindName string) -> Report(
        location,
        DiagnosticDescriptors.OpenOnlyValidOnClass,
        kindName
    )

    /// ADR-0078 / issue #718: GS0310 — `sealed` is only valid on
    /// `class` and `interface`. Enums already form a closed
    /// hierarchy by construction; structs cannot be subclassed.
    /// @param location The source location of the offending `sealed` modifier.
    /// @param kindName The kind keyword that follows.
    func ReportSealedOnlyValidOnClassOrInterface(location TextLocation, kindName string) -> Report(
        location,
        DiagnosticDescriptors.SealedOnlyValidOnClassOrInterface,
        kindName
    )

    /// ADR-0078 / issue #718: GS0311 — `data` and `inline` cannot be
    /// combined. A `data struct` already carries field-wise equality; an
    /// `inline struct` compares by its single wrapped field. The two
    /// equality models are mutually exclusive.
    /// @param location The source location of the offending modifier.
    func ReportDataAndInlineCannotCombine(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.DataAndInlineCannotCombine
    )

    /// ADR-0078 / issue #718: GS0312 — `open` and `sealed` on the
    /// same declaration are mutually exclusive (a class is either subclassable
    /// or part of a closed hierarchy).
    /// @param location The source location of the second modifier.
    func ReportOpenAndSealedCannotCombine(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.OpenAndSealedCannotCombine
    )

    /// ADR-0161: GS0524 (warning) — a top-level call argument is a bare
    /// `name = value` assignment. Until ADR-0161 that spelling was a named
    /// argument (ADR-0080's deprecated separator, formerly GS0315); it is now an
    /// assignment to `name` whose value is passed positionally. The two
    /// readings differ silently whenever `name` is both an assignable
    /// variable in scope and a parameter of the callee, so the transitional
    /// shape is flagged. Parenthesising (`(name = value)`) states the
    /// assignment intent unambiguously and silences this.
    /// @param location The source location of the assignment argument.
    /// @param targetName The assignment target's name.
    func ReportAssignmentArgumentWasNamedArgumentSpelling(location TextLocation, targetName string) -> Report(
        location,
        DiagnosticDescriptors.AssignmentArgumentWasNamedArgumentSpelling,
        targetName
    )

    /// Reports GS0363 — ADR-0101 / issue #799: the C# `params` keyword is
    /// not part of the G# parameter grammar. The canonical G# spelling for a
    /// variadic parameter is `name ...T` (where `T` is the element
    /// type — inside the body the parameter has type `[]T`).
    /// @param location The location of the rejected `params` keyword.
    func ReportParamsKeywordNotSupported(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.ParamsKeywordNotSupported
    )

    /// Reports GS0366 — ADR-0104 / issue #805: the legacy Go-flavored
    /// `map[K]V` type-clause spelling has been removed in v0.2. Maps
    /// are now spelled `map[K,V]` with both type arguments inside the
    /// brackets.
    /// @param location The source location spanning the offending
    /// `map[K]V` shape (from `map` through the value type).
    /// @param keyTypeText The source text of the key type clause.
    /// @param valueTypeText The source text of the value type clause.
    func ReportLegacyMapTypeClauseSyntax(location TextLocation, keyTypeText string, valueTypeText string) -> Report(
        location,
        DiagnosticDescriptors.LegacyMapTypeClauseSyntax,
        keyTypeText,
        valueTypeText
    )

    /// Reports GS0567 — ADR-0174 D2: the retired juxtaposed channel type-clause
    /// spelling `chan T` was used. The location spans the whole shape
    /// (from the direction token or `chan` through the element type) so an
    /// IDE quick-fix can replace it with `chan[T]` in one edit; the parser
    /// recovers by binding the canonical form, so the file does not cascade.
    /// @param location The span of the legacy shape.
    /// @param elementTypeText The element type's source text, used to spell the replacement.
    func ReportLegacyChanTypeClauseSyntax(location TextLocation, elementTypeText string) -> Report(
        location,
        DiagnosticDescriptors.LegacyChanTypeClauseSyntax,
        elementTypeText
    )

    /// Reports GS0566 — ADR-0174 D12/D13: a retired Go built-in was used
    /// (`make(chan …)`, `close`, `len`, `cap`,
    /// `append`, `delete`). The message names the exact working
    /// replacement for this site, in the shape ADR-0154 demands of a
    /// diagnostic that recommends an action.
    /// @param location The span of the retired form.
    /// @param retiredForm The retired source text (e.g. `make(chan int32, 3)`).
    /// @param guidance A full clause naming the replacement (e.g. `use 'chan[int32](3)' instead.`).
    func ReportRetiredBuiltin(location TextLocation, retiredForm string, guidance string) -> Report(
        location,
        DiagnosticDescriptors.RetiredBuiltin,
        retiredForm,
        guidance
    )

    /// Reports GS0546 at bind time — ADR-0174 D1: a channel operation lowers
    /// onto `Gsharp.Runtime.Channels`, which is not in the reference set.
    /// The emitter raises the same descriptor for BCL members a target
    /// framework lacks; here the missing member is the runtime's channel class.
    /// @param location The location of the channel construct.
    /// @param missingMember The full name of the type the construct lowers onto.
    func ReportTargetFrameworkMemberUnavailable(location TextLocation, missingMember string) -> Report(
        location,
        DiagnosticDescriptors.TargetFrameworkMemberUnavailable,
        missingMember
    )

    /// Issue #1602: GS0417 — the source nests expressions, types, statements,
    /// patterns, or string-interpolation holes more deeply than the compiler's
    /// recursion limit. The recursive-descent parser (and the lexer's
    /// interpolation-hole scanner) enforce a hard depth limit so that
    /// pathological input — e.g. thousands of unbalanced `a[a[a[…` or
    /// `((((…` — produces a clean diagnostic instead of an uncatchable
    /// (cref:System.StackOverflowException) that kills the process.
    /// Mirrors Roslyn's CS8078 ("an expression is too long or complex to
    /// compile").
    /// @param location The source location where the nesting limit was exceeded.
    func ReportNestingTooDeep(location TextLocation) -> Report(location, DiagnosticDescriptors.NestingTooDeep)

    /// Reports GS0368 — issue #881: an interface `func` declaration with
    /// no `{ … }` body is missing its terminating `;`. A bodyless
    /// `func` is the no-body (abstract) form, and G# requires `;` as
    /// the universal no-body marker for every `func` declaration (matching
    /// the P/Invoke shape from ADR-0086). A `func` that carries a
    /// `{ … }` block (default-interface method or default shared slot) must
    /// not take a `;`.
    /// @param location The source location where the `;` is
    /// expected (immediately after the return-type clause).
    /// @param methodName The name of the offending interface method.
    func ReportInterfaceMethodMissingSemicolon(location TextLocation, methodName string) -> Report(
        location,
        DiagnosticDescriptors.InterfaceMethodMissingSemicolon,
        methodName
    )
}
