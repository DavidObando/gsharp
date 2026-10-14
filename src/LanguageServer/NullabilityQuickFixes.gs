// <copyright file="NullabilityQuickFixes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import CoreDiagnostic = GSharp.Core.CodeAnalysis.Diagnostic
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer.Protocol
import Range = GSharp.LanguageServer.Protocol.Range
import System
import System.Collections.Generic
import System.Linq

/// LSP quick-fix providers for nil-related diagnostics introduced by
/// ADR-0099 / issue #730. Each provider is a thin syntax-and-text-edit
/// rewriter: detection runs against the diagnostic message text and the
/// existing parsed syntax tree, so providers never re-bind the document
/// and never bypass the cached (cref:GSharp.Core.CodeAnalysis.Compilation.Compilation.BoundProgram).
/// @remarks The three rewrites correspond to the three escape hatches G# offers
/// at the nullability boundary (ADR-0001 / ADR-0072):
/// - `.` → `?.` for accessing members through a nullable receiver (GS0158 on a member access whose
/// receiver is of type `T?`).
/// - `expr` → `(expr ?? default)` for supplying a default when a nullable is used in a non-nullable
/// position (GS0154 / GS0155 / GS0156).
/// - `expr` → `(expr!!)` for asserting non-nil when the user is certain of the value.
/// Edits are returned as LSP text edits (rather than syntax-tree
/// rewrites) so the LSP layer can compose the result with other client
/// edits without having to re-parse the whole tree.
internal shared class NullabilityQuickFixes {
    /// Title shown for the `.` → `?.` quick fix. Public so tests
    /// can assert on it without re-declaring the literal string.
    const NullConditionalAccessTitle string = "Use null-conditional access '?.'"

    /// Title shown for the null-coalescing default quick fix.
    const ElvisDefaultTitle string = "Provide default with '??'"

    /// Title shown for the postfix `!!` null-assertion quick fix.
    const NullAssertionTitle string = "Assert non-nil with '!!'"

    /// Builds the `.` → `?.` rewrite for a (cref:Diagnostic)
    /// reported as `GS0158` (Cannot find member). Returns `null`
    /// when the diagnostic does not sit on the right-hand side of an
    /// (cref:AccessorExpressionSyntax) that uses the regular dot
    /// operator, or when the receiver's type cannot be proven nullable
    /// from the document's syntactic / semantic surface.
    /// @param uri The document URI for the workspace edit.
    /// @param content The cached document content.
    /// @param diagnostic The triggering diagnostic.
    /// @returns A populated (cref:CodeAction) or `null`.
    func TryCreateDotToQuestionDot(uri DocumentUri, content DocumentContent, diagnostic CoreDiagnostic) CodeAction? {
        let accessor AccessorExpressionSyntax? = FindAccessorAtRightPart(
            content.SyntaxTree.Root,
            diagnostic.Location.Span
        )
        if accessor == nil || accessor.IsNullConditional {
            return nil
        }
        // The receiver must look nullable. We accept any of:
        //   - the LHS is itself a `?.`/`?[]` chain (its result is nullable),
        //   - a local/parameter whose declared type-clause ends with `?`,
        //   - a field whose declared type-clause ends with `?`,
        //   - a literal `nil` (degenerate but produces the same diagnostic).
        // Concrete CLR-NRT receivers are harder to detect without a full
        // type re-resolution and are handled implicitly when their
        // declaration site already ends with `?`.
        if !ReceiverLooksNullable(content.SyntaxTree, accessor.LeftPart) {
            return nil
        }
        let dotEdit = GSharp
            .LanguageServer
            .Protocol
            .TextEdit{Range: SemanticLookup.ToRange(content.SyntaxTree.Text, accessor.DotToken.Span), NewText: "?."}
        return CodeAction{
            Title: NullConditionalAccessTitle,
            Kind: CodeActionKind.QuickFix,
            Edit: WorkspaceEdit{
                Changes: Dictionary[DocumentUri, IEnumerable[GSharp.LanguageServer.Protocol.TextEdit]]{
                    [uri] = []GSharp.LanguageServer.Protocol.TextEdit{dotEdit}
                }
            }
        }
    }

    /// Builds the null-coalescing-default (`??`) and null-assertion (`!!`)
    /// rewrites for a diagnostic that indicates a nullable value flowing
    /// into a non-nullable position. The detector inspects the diagnostic
    /// message for the canonical `'T?'` → `'T'` pair surfaced
    /// by `ReportCannotConvert`, `ReportCannotConvertImplicitly`,
    /// `ReportWrongArgumentType`, and the `nil`-specific
    /// `ReportNilNotAssignableToNonNullableParameter`.
    /// @param uri The document URI for the workspace edit.
    /// @param content The cached document content.
    /// @param diagnostic The triggering diagnostic.
    /// @returns Zero, one, or two code actions.
    func CreateNullableValueFixes(uri DocumentUri, content DocumentContent, diagnostic CoreDiagnostic) sequence[
        CodeAction
    ] {
        if !TryGetNullableConversionTypes(diagnostic, out var sourceType, out var targetType) ||
            sourceType == nil ||
            targetType == nil {
            yield break
        }
        var span = diagnostic.Location.Span
        if span.Length == 0 {
            yield break
        }
        let sourceText = content.SyntaxTree.Text.ToString()
        if span.Start < 0 || span.End > sourceText.Length || span.Start >= span.End {
            yield break
        }
        let original = sourceText.Substring(span.Start, span.Length)
        // GS0274 fires on the literal `nil`, where `nil ?? X` and `nil!!`
        // are both degenerate (the user wants to provide a real value or
        // make the parameter nullable). Skip the rewrites — the original
        // diagnostic already carries the canonical suggestion in its
        // message text.
        if string.Equals(original.Trim(), "nil", StringComparison.Ordinal) {
            yield break
        }
        let range_ = SemanticLookup.ToRange(content.SyntaxTree.Text, span)
        let elvisDefault = SuggestDefaultLiteral(targetType)
        yield BuildReplacement(uri, range_, "Provide default with '?? $elvisDefault'", "($original ?? $elvisDefault)")
        yield BuildReplacement(uri, range_, NullAssertionTitle, "($original!!)")
    }

    private func BuildReplacement(uri DocumentUri, $range Range, title string, replacementText string) CodeAction {
        return CodeAction{
            Title: title,
            Kind: CodeActionKind.QuickFix,
            Edit: WorkspaceEdit{
                Changes: Dictionary[DocumentUri, IEnumerable[GSharp.LanguageServer.Protocol.TextEdit]]{
                    [uri] = []GSharp
                        .LanguageServer
                        .Protocol
                        .TextEdit{GSharp.LanguageServer.Protocol.TextEdit{Range: $range, NewText: replacementText}}
                }
            }
        }
    }

    /// Returns the deepest (cref:AccessorExpressionSyntax) whose
    /// (cref:AccessorExpressionSyntax.RightPart) covers
    /// [`span`](paramref). The diagnostic for "Cannot find member X"
    /// is reported at the member-name token, so this rebinds that location
    /// to the surrounding accessor.
    private func FindAccessorAtRightPart(root SyntaxNode, span TextSpan) AccessorExpressionSyntax? {
        var best AccessorExpressionSyntax? = nil
        for accessor in EnumerateDescendants[AccessorExpressionSyntax](root) {
            if !ContainsOrEquals(accessor.RightPart.Span, span) {
                continue
            }
            if best == nil || accessor.Span.Length < best.Span.Length {
                best = accessor
            }
        }
        return best
    }

    private func ContainsOrEquals(outer TextSpan, inner TextSpan) bool {
        var outer = outer
        var inner = inner
        return outer.Start <= inner.Start && inner.End <= outer.End
    }

    private func EnumerateDescendants[T SyntaxNode](root SyntaxNode) sequence[T] {
        if root is T match {
            yield match
        }
        for child in root.GetChildren() {
            for descendant in EnumerateDescendants[T](child) {
                yield descendant
            }
        }
    }

    /// Conservative receiver-is-nullable check that walks the parse tree
    /// only — it never re-binds the program. The check returns true when
    /// the receiver carries a clearly-nullable surface (e.g. a chained
    /// `?.`, an explicit `nil`, or a name that resolves to a
    /// local / parameter / field whose declared type-clause text ends
    /// with `?`).
    private func ReceiverLooksNullable(tree SyntaxTree, receiver ExpressionSyntax) bool {
        switch receiver {
            case nested is AccessorExpressionSyntax when nested.IsNullConditional {
                return true
            }
            case literal is LiteralExpressionSyntax when literal.LiteralToken.Kind == SyntaxKind.NilKeyword {
                return true
            }
            case name is NameExpressionSyntax {
                return NameDeclaresNullableType(tree, name.IdentifierToken.Text)
            }
            default {
                return false
            }
        }
    }

    private func NameDeclaresNullableType(tree SyntaxTree, name string) bool {
        if string.IsNullOrEmpty(name) {
            return false
        }
        for node in EnumerateDescendants[SyntaxNode](tree.Root) {
            switch node {
                case v is VariableDeclarationSyntax when v
                    .Identifier
                    ?.Text == name &&
                    TypeClauseEndsWithQuestion(v.TypeClause) {
                    return true
                }
                case p is ParameterSyntax when p.Identifier?.Text == name && TypeClauseEndsWithQuestion(p.Type) {
                    return true
                }
                case f is FieldDeclarationSyntax when f.Identifier?.Text == name && TypeClauseEndsWithQuestion(f.Type) {
                    return true
                }
            }
        }
        return false
    }

    private func TypeClauseEndsWithQuestion(type TypeClauseSyntax?) bool {
        if type == nil {
            return false
        }
        let text SourceText? = type.SyntaxTree?.Text
        if text == nil {
            return false
        }
        var span = type.Span
        if span.End <= span.Start || span.End > text.Length {
            return false
        }
        return text[span.End - 1] == '?'
    }

    /// Parses a diagnostic's message text for the canonical pair of
    /// quoted types it carries when reporting a nullable→non-nullable
    /// mismatch. Returns `true` when the source type ends
    /// with `?` and the target type is the corresponding non-nullable
    /// (or any non-`?` name); otherwise `false`.
    private func TryGetNullableConversionTypes(
        diagnostic CoreDiagnostic,
        out sourceType string?,
        out targetType string?
    ) bool {
        sourceType = nil
        targetType = nil
        let message = diagnostic.Message ?? string.Empty
        let quoted = List[string]()
        var i = 0
        while i < message.Length {
            if message[i] == '\'' {
                let end = message.IndexOf('\'', i + 1)
                if end < 0 {
                    break
                }
                quoted.Add(message.Substring(i + 1, end - i - 1))
                i = end + 1
            } else {
                i++
            }
        }
        if quoted.Count < 2 {
            return false
        }
        switch diagnostic.Id {
            case "GS0155", "GS0156" {
                // "Cannot convert type 'X' to 'Y'."
                sourceType = quoted[0]
                targetType = quoted[1]
            }
            case "GS0154" {
                // "Parameter 'name' requires a value of type 'Y' but was given a value of type 'X'."
                if quoted.Count < 3 {
                    return false
                }
                targetType = quoted[1]
                sourceType = quoted[2]
            }
            case "GS0274" {
                // "'nil' cannot be assigned to parameter 'name' of non-nullable type 'Y'; ..."
                sourceType = quoted[0]
                targetType = quoted[
                    if quoted.Count > 2 {
                        2
                    } else {
                        1
                    }
                ]
            }
            default {
                return false
            }
        }
        if string.IsNullOrEmpty(sourceType) || string.IsNullOrEmpty(targetType) {
            return false
        }
        if !sourceType!!.EndsWith("?", StringComparison.Ordinal) {
            return false
        }
        let underlying = sourceType!!.Substring(0, sourceType!!.Length - 1)
        return string.Equals(underlying, targetType, StringComparison.Ordinal)
    }

    /// Picks a sensible literal for the right-hand side of the synthesised
    /// `??` rewrite. The user is expected to replace it with a real
    /// default; the goal here is to produce a snippet that parses and
    /// type-checks for the common built-ins.
    private func SuggestDefaultLiteral(targetType string) string {
        return switch targetType {
            case "string": "\"\""
            case "bool": "false"
            case "int" or "int8" or "int16" or "int32" or "int64" or "uint8" or "uint16" or "uint32" or "uint64": "0"
            case "float" or "float32" or "float64" or "double" or "decimal": "0"
            default: "default"
        }
    }
}
