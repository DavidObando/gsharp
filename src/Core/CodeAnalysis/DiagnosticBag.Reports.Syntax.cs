// <copyright file="DiagnosticBag.Reports.Syntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis;

public sealed partial class DiagnosticBag
{
    /// <summary>
    /// Reports a bad character during lexing.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="character">The unexpected bad character.</param>
    public void ReportBadCharacter(TextLocation location, char character)
    => Report(location, DiagnosticDescriptors.BadCharacter, character);

    /// <summary>
    /// Reports an unterminated comment.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportUnterminatedComment(TextLocation location)
    => Report(location, DiagnosticDescriptors.UnterminatedComment);

    /// <summary>
    /// Reports an unterminated string literal.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportUnterminatedString(TextLocation location)
    => Report(location, DiagnosticDescriptors.UnterminatedString);

    /// <summary>
    /// Reports a number literal as invalid.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="text">Text found in the source document.</param>
    /// <param name="type">Expected type.</param>
    public void ReportInvalidNumber(TextLocation location, string text, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.InvalidNumber, text, type);

    /// <summary>
    /// Reports an unexpected token while parsing.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="actualKind">The kind of syntax encountered.</param>
    /// <param name="expectedKind">The kind of syntax expected.</param>
    public void ReportUnexpectedToken(TextLocation location, SyntaxKind actualKind, SyntaxKind expectedKind)
    => Report(location, DiagnosticDescriptors.UnexpectedToken, actualKind, expectedKind);

    /// <summary>Reports that the <c>inline</c> modifier was combined with <c>data</c> or <c>record</c>.</summary>
    /// <param name="location">The text location of the conflicting modifier.</param>
    public void ReportInlineCannotBeCombinedWithData(TextLocation location)
    => Report(location, DiagnosticDescriptors.InlineCannotBeCombinedWithData);

    /// <summary>Reports that inline and open modifiers were combined.</summary>
    /// <param name="location">The text location of the conflicting modifier.</param>
    public void ReportInlineCannotBeCombinedWithOpen(TextLocation location)
    => Report(location, DiagnosticDescriptors.InlineCannotBeCombinedWithOpen);

    /// <summary>
    /// Reports that the <c>record</c> alias cannot be combined with the <c>data</c> contextual keyword.
    /// </summary>
    /// <param name="location">The text location of the <c>data</c> keyword.</param>
    public void ReportRecordCannotBeCombinedWithDataKeyword(TextLocation location)
    => Report(location, DiagnosticDescriptors.RecordCannotBeCombinedWithDataKeyword);

    /// <summary>
    /// Reports that the <c>async</c> modifier was used in a type-clause position
    /// without being followed by <c>sequence</c> or <c>func</c> (ADR-0042 / ADR-0043).
    /// </summary>
    /// <param name="location">The text location of the <c>async</c> modifier.</param>
    /// <param name="actualKind">The kind of the token actually following <c>async</c>.</param>
    public void ReportAsyncModifierInTypeClauseRequiresSequenceOrFunc(TextLocation location, SyntaxKind actualKind)
    => Report(location, DiagnosticDescriptors.AsyncModifierInTypeClauseRequiresSequenceOrFunc, actualKind);

    /// <summary>
    /// Reports that top-level statements appear in more than one *package* in
    /// the same compilation, which is not allowed (ADR-0066). The earlier
    /// ADR-0028 widened the rule from "one source file" to "one package";
    /// the message text matches the package-scoped rule the binder actually
    /// enforces.
    /// </summary>
    /// <param name="location">A location in one of the offending files.</param>
    public void ReportMultipleTopLevelFiles(TextLocation location)
    => Report(location, DiagnosticDescriptors.MultipleTopLevelFiles);

    /// <summary>
    /// Reports that the compilation contains both top-level statements and an
    /// explicit Main function, which is ambiguous. ADR-0066 D6: this is a
    /// warning rather than an error — when both shapes coexist, the
    /// synthesized top-level entry point wins and the explicit Main is
    /// shadowed. C# behaves the same way (CS7022 is a warning).
    /// </summary>
    /// <param name="location">The location of the explicit Main function declaration.</param>
    public void ReportTopLevelStatementsConflictWithMain(TextLocation location)
    => Report(location, DiagnosticDescriptors.TopLevelStatementsConflictWithMain);

    /// <summary>
    /// ADR-0066 D2: reports that top-level statements mix bare <c>return;</c> and
    /// <c>return &lt;expr&gt;;</c> shapes. The synthesized entry point has a
    /// single return type (either <c>void</c> or <c>int</c>), so the user must
    /// pick one return shape across all TLS.
    /// </summary>
    /// <param name="location">The location of the first offending return statement.</param>
    public void ReportTopLevelReturnShapeMismatch(TextLocation location)
    => Report(location, DiagnosticDescriptors.TopLevelReturnShapeMismatch);

    /// <summary>
    /// ADR-0067: reports that a field declaration inside a <c>struct</c>,
    /// <c>class</c>, or <c>shared</c> block was written without a leading
    /// <c>var</c> or <c>let</c> keyword. Field declarations now require
    /// one of these binding keywords to distinguish mutable (<c>var</c>)
    /// from read-only (<c>let</c>) storage and to keep type bodies
    /// visually consistent with property, event, and method members.
    /// </summary>
    /// <param name="location">The location of the offending token.</param>
    public void ReportFieldDeclarationRequiresVarOrLet(TextLocation location)
    => Report(location, DiagnosticDescriptors.FieldDeclarationRequiresVarOrLet);

    /// <summary>
    /// Reports that top-level statements within a single source file are not
    /// contiguous — they are split into two or more blocks separated by a
    /// type or function declaration (ADR-0066 deferred decision D5). Emitted
    /// as a <b>warning</b> so the established G# Go-style trailing-TLS
    /// idiom (decls first, then a single TLS block) keeps working
    /// unchanged, while genuinely interleaved layouts still surface a hint.
    /// </summary>
    /// <param name="location">The location of the misplaced top-level statement.</param>
    public void ReportTopLevelStatementsMustBeContiguous(TextLocation location)
    => Report(location, DiagnosticDescriptors.TopLevelStatementsMustBeContiguous);

    /// <summary>
    /// ADR-0066 deferred decision D4: reports that top-level statements appear
    /// in a compilation that produces a library, not an executable. Mirrors
    /// C#'s CS8805. Without this guard the binder would silently synthesize
    /// a <c>&lt;Main&gt;$</c> inside the emitted <c>.dll</c> that the runtime
    /// will never invoke.
    /// </summary>
    /// <param name="location">The location of the first offending top-level statement.</param>
    public void ReportTopLevelStatementsInLibrary(TextLocation location)
    => Report(location, DiagnosticDescriptors.TopLevelStatementsInLibrary);

    /// <summary>
    /// Reports an accessibility modifier (<c>public</c>/<c>internal</c>/<c>private</c>) appearing on a construct that does not accept one.
    /// </summary>
    /// <param name="location">The text location of the modifier token.</param>
    /// <param name="modifier">The modifier text.</param>
    public void ReportAccessibilityModifierNotAllowedHere(TextLocation location, string modifier)
    => Report(location, DiagnosticDescriptors.AccessibilityModifierNotAllowedHere, modifier);

    /// <summary>
    /// Reports a character literal that is missing a closing quote or
    /// whose body crosses a line terminator (ADR-0046).
    /// </summary>
    /// <param name="location">The literal's location.</param>
    public void ReportUnterminatedCharLiteral(TextLocation location)
    => Report(location, DiagnosticDescriptors.UnterminatedCharLiteral);

    /// <summary>
    /// Reports an empty character literal <c>''</c> (ADR-0046).
    /// </summary>
    /// <param name="location">The literal's location.</param>
    public void ReportEmptyCharLiteral(TextLocation location)
    => Report(location, DiagnosticDescriptors.EmptyCharLiteral);

    /// <summary>
    /// Reports a character literal containing more than one code unit
    /// (e.g. <c>'ab'</c>) per ADR-0046.
    /// </summary>
    /// <param name="location">The literal's location.</param>
    public void ReportMultiCharCharLiteral(TextLocation location)
    => Report(location, DiagnosticDescriptors.MultiCharCharLiteral);

    /// <summary>
    /// Reports an unknown escape sequence inside a character literal
    /// (ADR-0046).
    /// </summary>
    /// <param name="location">The literal's location.</param>
    /// <param name="escapeChar">The unrecognised escape character.</param>
    public void ReportInvalidCharEscape(TextLocation location, char escapeChar)
    => Report(location, DiagnosticDescriptors.InvalidCharEscape, escapeChar);

    /// <summary>
    /// Reports a malformed Unicode escape (<c>\\u</c>, <c>\\U</c>, or
    /// <c>\\x</c>) inside a character literal: too few hex digits, or in
    /// the case of <c>\\U</c>, a value outside the basic multilingual
    /// plane (ADR-0046).
    /// </summary>
    /// <param name="location">The literal's location.</param>
    public void ReportInvalidUnicodeEscape(TextLocation location)
    => Report(location, DiagnosticDescriptors.InvalidUnicodeEscape);

    /// <summary>
    /// Reports an unrecognized backslash escape sequence inside a double-quoted
    /// string literal. Issue #531: interpreted strings now process C#/Go style
    /// escape sequences; any <c>\X</c> that is not in the recognized set is an
    /// error.
    /// </summary>
    /// <param name="location">The source location of the escape sequence.</param>
    /// <param name="escapeChar">The character following the backslash.</param>
    public void ReportInvalidStringEscape(TextLocation location, char escapeChar)
    => Report(location, DiagnosticDescriptors.InvalidStringEscape, escapeChar);

    /// <summary>
    /// Reports an annotation lead-in (<c>@</c>) that is not followed by an
    /// identifier or a use-site target qualifier (ADR-0047 §1).
    /// </summary>
    /// <param name="location">The source location of the offending token.</param>
    public void ReportAnnotationExpected(TextLocation location)
    => Report(location, DiagnosticDescriptors.AnnotationExpected);

    /// <summary>
    /// Reports an annotation use-site target qualifier whose kind is not one
    /// of the canonical kinds defined in ADR-0047 §2 (<c>field</c>,
    /// <c>param</c>, <c>return</c>, <c>type</c>, <c>method</c>,
    /// <c>property</c>, <c>event</c>, <c>module</c>, <c>assembly</c>,
    /// <c>genericparam</c>).
    /// </summary>
    /// <param name="location">The source location of the offending kind identifier.</param>
    /// <param name="kind">The unrecognized kind text.</param>
    public void ReportAnnotationTargetInvalid(TextLocation location, string kind)
    => Report(location, DiagnosticDescriptors.AnnotationTargetInvalid, kind);

    /// <summary>
    /// Reports GS0206 when an annotation lead-in (<c>@Name</c>) precedes a
    /// statement that does not accept annotations (only local
    /// <c>var</c>/<c>let</c>/<c>const</c> declarations do — see ADR-0047 §2
    /// and issue #187).
    /// </summary>
    /// <param name="location">The source location of the leading <c>@</c>.</param>
    public void ReportAnnotationsNotAllowedOnStatement(TextLocation location)
    => Report(location, DiagnosticDescriptors.AnnotationsNotAllowedOnStatement);

    /// <summary>
    /// ADR-0055: reports an interpolation hole whose alignment clause
    /// (<c>${expr,alignment}</c>) is not a constant integer.
    /// </summary>
    /// <param name="location">The text location of the offending hole.</param>
    /// <param name="text">The offending alignment text.</param>
    public void ReportInvalidInterpolationAlignment(TextLocation location, string text)
    => Report(location, DiagnosticDescriptors.InvalidInterpolationAlignment, text);

    /// <summary>
    /// Issue #368: reports an interpolated string passed to an
    /// <c>[InterpolatedStringHandler]</c> parameter whose
    /// <c>[InterpolatedStringHandlerArgument]</c> forwarding could not be
    /// satisfied (an unknown referenced argument, a missing receiver, or no
    /// matching handler constructor).
    /// </summary>
    /// <param name="location">The text location of the interpolated argument.</param>
    /// <param name="reason">A human-readable description of the failure.</param>
    public void ReportInterpolatedStringHandlerArgument(TextLocation location, string reason)
    => Report(location, DiagnosticDescriptors.InterpolatedStringHandlerArgument, reason);

    /// <summary>
    /// ADR-0055: reports an interpolation hole (<c>${ … }</c>) that is never
    /// closed by a matching <c>}</c> before the end of the source.
    /// </summary>
    /// <param name="location">The text location of the unterminated hole.</param>
    public void ReportUnterminatedInterpolationHole(TextLocation location)
    => Report(location, DiagnosticDescriptors.UnterminatedInterpolationHole);

    /// <summary>
    /// ADR-0055: reports an empty interpolation hole (<c>${}</c>), which has no
    /// expression to evaluate.
    /// </summary>
    /// <param name="location">The text location of the empty hole.</param>
    public void ReportEmptyInterpolationHole(TextLocation location)
    => Report(location, DiagnosticDescriptors.EmptyInterpolationHole);

    /// <summary>
    /// ADR-0055: reports an interpolation hole whose format clause is present
    /// but empty (<c>${expr:}</c>).
    /// </summary>
    /// <param name="location">The text location of the offending hole.</param>
    public void ReportEmptyInterpolationFormat(TextLocation location)
    => Report(location, DiagnosticDescriptors.EmptyInterpolationFormat);

    /// <summary>
    /// ADR-0055: reports a raw newline in the literal portion of an
    /// interpolated string. Newlines are only permitted inside <c>${ … }</c>
    /// holes, not in the literal text segments.
    /// </summary>
    /// <param name="location">The text location of the newline.</param>
    public void ReportNewlineInInterpolatedStringLiteral(TextLocation location)
    => Report(location, DiagnosticDescriptors.NewlineInInterpolatedStringLiteral);

    /// <summary>
    /// ADR-0057 §P4: reports a documentation comment block that does not precede
    /// any documentable declaration (a "floating" doc comment).
    /// </summary>
    /// <param name="location">The text location of the floating documentation comment.</param>
    public void ReportFloatingDocumentationComment(TextLocation location)
    => Report(location, DiagnosticDescriptors.FloatingDocumentationComment);

    /// <summary>
    /// ADR-0057 §P4: reports a public API member that lacks documentation (opt-in via /warnondoc or similar mechanism).
    /// </summary>
    /// <param name="location">The text location of the undocumented declaration.</param>
    /// <param name="symbolName">The undocumented public symbol name.</param>
    public void ReportMissingDocumentation(TextLocation location, string symbolName)
    => Report(location, DiagnosticDescriptors.MissingDocumentation, symbolName);

    /// <summary>
    /// ADR-0057 §P4: reports a @param or @typeparam tag whose name does not match
    /// any parameter in the documented member's signature.
    /// </summary>
    /// <param name="location">The text location of the documented declaration.</param>
    /// <param name="paramName">The unmatched parameter or type-parameter name.</param>
    /// <param name="symbolName">The documented symbol name.</param>
    public void ReportDocParamMismatch(TextLocation location, string paramName, string symbolName)
    => Report(location, DiagnosticDescriptors.DocParamMismatch, paramName, symbolName);

    /// <summary>
    /// ADR-0057 §P4: reserved for unsupported Markdown constructs that cannot be
    /// represented in the documentation model.
    /// </summary>
    /// <param name="location">The text location of the unsupported Markdown construct.</param>
    /// <param name="detail">Details about the unsupported Markdown construct.</param>
    public void ReportUnsupportedDocumentationMarkdown(TextLocation location, string detail)
    => Report(location, DiagnosticDescriptors.UnsupportedDocumentationMarkdown, detail);

    /// <summary>
    /// Reports GS0231 when a documentation comment contains an unknown block tag
    /// (e.g. <c>@return</c> instead of <c>@returns</c>).
    /// </summary>
    /// <param name="location">The location of the documentation comment.</param>
    /// <param name="tagName">The unrecognised tag text.</param>
    public void ReportUnknownDocumentationTag(TextLocation location, string tagName)
    => Report(location, DiagnosticDescriptors.UnknownDocumentationTag, tagName);

    /// <summary>
    /// ADR-0059 / issue #255: reports that a delegate declaration
    /// (<c>type Name = delegate …</c>) was not followed by a <c>func(...)</c>
    /// signature. Named delegates must take the shape
    /// <c>type Name = delegate func(params) ret</c>.
    /// </summary>
    /// <param name="location">The text location of the offending token.</param>
    public void ReportDelegateDeclarationRequiresFunc(TextLocation location)
    => Report(location, DiagnosticDescriptors.DelegateDeclarationRequiresFunc);

    /// <summary>
    /// Reports that the identifier <c>null</c> was used where the G# null
    /// literal <c>nil</c> is required. G# does not recognise <c>null</c> as
    /// a keyword — the correct spelling is <c>nil</c> (ADR-0081).
    /// </summary>
    /// <param name="location">The source location of the <c>null</c> identifier.</param>
    public void ReportUseNilInsteadOfNull(TextLocation location)
    => Report(location, DiagnosticDescriptors.UseNilInsteadOfNull);

    /// <summary>
    /// ADR-0074 / issue #714: GS0302 (warning) — a switch-expression arm
    /// used the deprecated <c>-&gt;</c> separator. The token is being
    /// repurposed as the lambda-expression arrow; arms should use <c>:</c>.
    /// One release of overlap is provided; the <c>-&gt;</c> form is removed
    /// in a later release.
    /// </summary>
    /// <param name="location">The source location of the offending <c>-&gt;</c> token.</param>
    public void ReportSwitchExpressionArmArrowDeprecated(TextLocation location)
    => Report(location, DiagnosticDescriptors.SwitchExpressionArmArrowDeprecated);

    /// <summary>
    /// ADR-0075 / issue #715: GS0303 (warning) — a type-clause slot used the
    /// legacy <c>func(T1, T2, ...) R</c> spelling. The canonical form is the
    /// arrow function type <c>(T1, T2, ...) -&gt; R</c> (Kotlin/Swift style).
    /// Both forms are accepted for one release; the legacy form is removed in
    /// a later release.
    /// </summary>
    /// <param name="location">The source location of the offending <c>func</c> keyword.</param>
    public void ReportFunctionTypeClauseFuncKeywordDeprecated(TextLocation location)
    => Report(location, DiagnosticDescriptors.FunctionTypeClauseFuncKeywordDeprecated);

    /// <summary>
    /// ADR-0077 / issue #717: GS0305 — the legacy short variable-declaration
    /// operator <c>:=</c> has been removed. Every binding site must spell
    /// <c>let name = expr</c> (immutable) or <c>var name = expr</c> (mutable).
    /// The lexer continues to tokenise <c>:=</c> so the parser can emit a
    /// single high-quality diagnostic at the offending token rather than
    /// cascading parse errors.
    /// </summary>
    /// <param name="location">The source location of the offending <c>:=</c> token.</param>
    /// <param name="migration">A context-specific replacement snippet
    /// (e.g. <c>let x = 1</c> or <c>var x = 1</c>) shown in the message.</param>
    public void ReportColonEqualsRemoved(TextLocation location, string migration)
    => Report(location, DiagnosticDescriptors.ColonEqualsRemoved, migration);

    /// <summary>
    /// ADR-0078 / issue #718: GS0306 — the legacy <c>type Name &lt;agg-kw&gt; ...</c>
    /// declaration head has been removed. The aggregate-kind keyword
    /// (<c>class</c>, <c>struct</c>, <c>enum</c>, <c>interface</c>) is now the
    /// declaration keyword and precedes the name. The diagnostic message includes
    /// a concrete migration snippet so existing code can be ported by hand or
    /// with a mechanical rewrite.
    /// </summary>
    /// <param name="location">The source location of the offending <c>type</c> keyword.</param>
    /// <param name="migration">A context-specific replacement snippet (e.g. <c>class Point(x, y int32)</c>).</param>
    public void ReportOldTypeDeclarationFormRemoved(TextLocation location, string migration)
    => Report(location, DiagnosticDescriptors.OldTypeDeclarationFormRemoved, migration);

    /// <summary>
    /// ADR-0078 / issue #718: GS0307 — the <c>record</c> contextual keyword has
    /// been deleted. Records are spelled <c>data class</c> (reference) or
    /// <c>data struct</c> (value) with the aggregate keyword as the
    /// declaration head.
    /// </summary>
    /// <param name="location">The source location of the offending <c>record</c> identifier.</param>
    /// <param name="name">The aggregate name (used to build the migration snippet).</param>
    public void ReportRecordKeywordRemoved(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.RecordKeywordRemoved, name, name);

    /// <summary>
    /// ADR-0078 / issue #718: GS0308 — <c>inline</c> is only valid on
    /// <c>struct</c>. <c>inline class</c> is rejected because the inline value
    /// class (newtype) form only makes sense for value types.
    /// </summary>
    /// <param name="location">The source location of the offending <c>inline</c> modifier.</param>
    public void ReportInlineOnlyValidOnStruct(TextLocation location)
    => Report(location, DiagnosticDescriptors.InlineOnlyValidOnStruct);

    /// <summary>
    /// ADR-0078 / issue #718: GS0309 — <c>open</c> is only valid on
    /// <c>class</c>. Structs are value types and cannot be subclassed; enums and
    /// interfaces define their own openness model.
    /// </summary>
    /// <param name="location">The source location of the offending <c>open</c> modifier.</param>
    /// <param name="kindName">The kind keyword that follows (e.g. <c>struct</c>).</param>
    public void ReportOpenOnlyValidOnClass(TextLocation location, string kindName)
    => Report(location, DiagnosticDescriptors.OpenOnlyValidOnClass, kindName);

    /// <summary>
    /// ADR-0078 / issue #718: GS0310 — <c>sealed</c> is only valid on
    /// <c>class</c> and <c>interface</c>. Enums already form a closed
    /// hierarchy by construction; structs cannot be subclassed.
    /// </summary>
    /// <param name="location">The source location of the offending <c>sealed</c> modifier.</param>
    /// <param name="kindName">The kind keyword that follows.</param>
    public void ReportSealedOnlyValidOnClassOrInterface(TextLocation location, string kindName)
    => Report(location, DiagnosticDescriptors.SealedOnlyValidOnClassOrInterface, kindName);

    /// <summary>
    /// ADR-0078 / issue #718: GS0311 — <c>data</c> and <c>inline</c> cannot be
    /// combined. A <c>data struct</c> already carries field-wise equality; an
    /// <c>inline struct</c> compares by its single wrapped field. The two
    /// equality models are mutually exclusive.
    /// </summary>
    /// <param name="location">The source location of the offending modifier.</param>
    public void ReportDataAndInlineCannotCombine(TextLocation location)
    => Report(location, DiagnosticDescriptors.DataAndInlineCannotCombine);

    /// <summary>
    /// ADR-0078 / issue #718: GS0312 — <c>open</c> and <c>sealed</c> on the
    /// same declaration are mutually exclusive (a class is either subclassable
    /// or part of a closed hierarchy).
    /// </summary>
    /// <param name="location">The source location of the second modifier.</param>
    public void ReportOpenAndSealedCannotCombine(TextLocation location)
    => Report(location, DiagnosticDescriptors.OpenAndSealedCannotCombine);

    /// <summary>
    /// ADR-0080 / issue #720: GS0315 (warning) — a call-site or attribute named
    /// argument used the legacy <c>name = value</c> spelling. The canonical
    /// spelling is <c>name: value</c> (issue #343). Both forms parse during a
    /// one-release grace period; the <c>=</c> form is removed in a later
    /// release.
    /// </summary>
    /// <param name="location">The source location of the offending <c>=</c> token.</param>
    /// <param name="argumentName">The argument name on the left of the separator.</param>
    public void ReportNamedArgumentEqualsSeparatorDeprecated(TextLocation location, string argumentName)
    => Report(location, DiagnosticDescriptors.NamedArgumentEqualsSeparatorDeprecated, argumentName, argumentName);

    /// <summary>
    /// ADR-0082 / issue #722: GS0316 — a Go-flavored concurrency syntactic
    /// form (<c>go</c>, <c>chan T</c>, <c>&lt;-ch</c>, <c>ch &lt;- v</c>,
    /// <c>select</c>, <c>close(ch)</c>, <c>make(chan T)</c>) was used in a
    /// compilation unit that does not <c>import Gsharp.Extensions.Go</c>.
    /// The Go-flavored surface is opt-in; the production concurrency surface
    /// is <c>scope</c> + <c>async</c> / <c>await</c>. The diagnostic names
    /// the triggering form so users see exactly what to fix.
    /// </summary>
    /// <param name="location">The source location of the offending keyword or operator.</param>
    /// <param name="form">The triggering syntactic form (e.g. <c>go</c>, <c>chan</c>, <c>&lt;-</c>, <c>select</c>, <c>close</c>, <c>make(chan)</c>).</param>
    public void ReportGoExtensionsImportRequired(TextLocation location, string form)
    => Report(location, DiagnosticDescriptors.GoExtensionsImportRequired, form);

    /// <summary>
    /// ADR-0083 / issue #723: GS0317 — a Go-style built-in function
    /// (<c>len</c>, <c>cap</c>, <c>append</c>, <c>delete</c>) was called in
    /// a compilation unit that does not <c>import Gsharp.Extensions.Go</c>.
    /// The message names the built-in and, when there is a clean
    /// .NET-idiomatic replacement (<c>.Length</c>, <c>.Count</c>,
    /// <c>.Remove(k)</c>, <c>List[T].Add</c>), points the user at it as an
    /// alternative to the import. The <c>close(ch)</c> built-in keeps using
    /// <see cref="ReportGoExtensionsImportRequired"/> (GS0316) because it
    /// shares the channel surface with <c>chan</c> / <c>&lt;-</c> /
    /// <c>select</c>; the <c>make(chan T)</c> shape is gated through the
    /// inner <c>chan</c> type-clause check (also GS0316), so this
    /// diagnostic only fires for the strict built-in identifiers above.
    /// </summary>
    /// <param name="location">The source location of the offending built-in identifier.</param>
    /// <param name="builtin">The triggering built-in name (e.g. <c>len</c>, <c>cap</c>, <c>append</c>, <c>delete</c>).</param>
    /// <param name="suggestion">A short alternative form to recommend (e.g. <c>.Length</c>, <c>.Count</c>, <c>.Remove(k)</c>), or <c>null</c> when there is no clean .NET-idiomatic replacement.</param>
    public void ReportGoBuiltinRequiresImport(TextLocation location, string builtin, string suggestion)
    {
        var suggestionText = suggestion is null
            ? string.Empty
            : string.Format(DiagnosticDescriptors.GoBuiltinSuggestionMessageFormat, suggestion);
        Report(location, DiagnosticDescriptors.GoBuiltinRequiresImport, builtin, suggestionText);
    }

    /// <summary>
    /// Reports GS0363 — ADR-0101 / issue #799: the C# <c>params</c> keyword is
    /// not part of the G# parameter grammar. The canonical G# spelling for a
    /// variadic parameter is <c>name ...T</c> (where <c>T</c> is the element
    /// type — inside the body the parameter has type <c>[]T</c>).
    /// </summary>
    /// <param name="location">The location of the rejected <c>params</c> keyword.</param>
    public void ReportParamsKeywordNotSupported(TextLocation location)
    => Report(location, DiagnosticDescriptors.ParamsKeywordNotSupported);

    /// <summary>
    /// Reports GS0366 — ADR-0104 / issue #805: the legacy Go-flavored
    /// <c>map[K]V</c> type-clause spelling has been removed in v0.2. Maps
    /// are now spelled <c>map[K,V]</c> with both type arguments inside the
    /// brackets.
    /// </summary>
    /// <param name="location">The source location spanning the offending
    /// <c>map[K]V</c> shape (from <c>map</c> through the value type).</param>
    /// <param name="keyTypeText">The source text of the key type clause.</param>
    /// <param name="valueTypeText">The source text of the value type clause.</param>
    public void ReportLegacyMapTypeClauseSyntax(TextLocation location, string keyTypeText, string valueTypeText)
    => Report(location, DiagnosticDescriptors.LegacyMapTypeClauseSyntax, keyTypeText, valueTypeText);

    /// <summary>
    /// Issue #1602: GS0417 — the source nests expressions, types, statements,
    /// patterns, or string-interpolation holes more deeply than the compiler's
    /// recursion limit. The recursive-descent parser (and the lexer's
    /// interpolation-hole scanner) enforce a hard depth limit so that
    /// pathological input — e.g. thousands of unbalanced <c>a[a[a[…</c> or
    /// <c>((((…</c> — produces a clean diagnostic instead of an uncatchable
    /// <see cref="System.StackOverflowException"/> that kills the process.
    /// Mirrors Roslyn's CS8078 ("an expression is too long or complex to
    /// compile").
    /// </summary>
    /// <param name="location">The source location where the nesting limit was exceeded.</param>
    public void ReportNestingTooDeep(TextLocation location)
    => Report(location, DiagnosticDescriptors.NestingTooDeep);

    /// <summary>
    /// Reports GS0368 — issue #881: an interface <c>func</c> declaration with
    /// no <c>{ … }</c> body is missing its terminating <c>;</c>. A bodyless
    /// <c>func</c> is the no-body (abstract) form, and G# requires <c>;</c> as
    /// the universal no-body marker for every <c>func</c> declaration (matching
    /// the P/Invoke shape from ADR-0086). A <c>func</c> that carries a
    /// <c>{ … }</c> block (default-interface method or default shared slot) must
    /// not take a <c>;</c>.
    /// </summary>
    /// <param name="location">The source location where the <c>;</c> is
    /// expected (immediately after the return-type clause).</param>
    /// <param name="methodName">The name of the offending interface method.</param>
    public void ReportInterfaceMethodMissingSemicolon(TextLocation location, string methodName)
    => Report(location, DiagnosticDescriptors.InterfaceMethodMissingSemicolon, methodName);
}
