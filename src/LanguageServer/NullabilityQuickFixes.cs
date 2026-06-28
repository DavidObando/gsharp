#nullable disable

// <copyright file="NullabilityQuickFixes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.LanguageServer.Protocol;
using CoreDiagnostic = GSharp.Core.CodeAnalysis.Diagnostic;
using Range = GSharp.LanguageServer.Protocol.Range;

namespace GSharp.LanguageServer;

/// <summary>
/// LSP quick-fix providers for nil-related diagnostics introduced by
/// ADR-0099 / issue #730. Each provider is a thin syntax-and-text-edit
/// rewriter: detection runs against the diagnostic message text and the
/// existing parsed syntax tree, so providers never re-bind the document
/// and never bypass the cached <see cref="GSharp.Core.CodeAnalysis.Compilation.Compilation.BoundProgram"/>.
/// </summary>
/// <remarks>
/// The three rewrites correspond to the three escape hatches G# offers
/// at the nullability boundary (ADR-0001 / ADR-0072):
/// <list type="bullet">
///   <item>
///     <description><c>.</c> → <c>?.</c> for accessing members through
///     a nullable receiver (GS0158 on a member access whose receiver is
///     of type <c>T?</c>).</description>
///   </item>
///   <item>
///     <description><c>expr</c> → <c>(expr ?? default)</c> for supplying
///     a default when a nullable is used in a non-nullable position
///     (GS0154 / GS0155 / GS0156).</description>
///   </item>
///   <item>
///     <description><c>expr</c> → <c>(expr!!)</c> for asserting non-nil
///     when the user is certain of the value.</description>
///   </item>
/// </list>
/// Edits are returned as LSP text edits (rather than syntax-tree
/// rewrites) so the LSP layer can compose the result with other client
/// edits without having to re-parse the whole tree.
/// </remarks>
internal static class NullabilityQuickFixes
{
    /// <summary>
    /// Title shown for the <c>.</c> → <c>?.</c> quick fix. Public so tests
    /// can assert on it without re-declaring the literal string.
    /// </summary>
    public const string NullConditionalAccessTitle = "Use null-conditional access '?.'";

    /// <summary>
    /// Title shown for the null-coalescing default quick fix.
    /// </summary>
    public const string ElvisDefaultTitle = "Provide default with '??'";

    /// <summary>
    /// Title shown for the postfix <c>!!</c> null-assertion quick fix.
    /// </summary>
    public const string NullAssertionTitle = "Assert non-nil with '!!'";

    /// <summary>
    /// Builds the <c>.</c> → <c>?.</c> rewrite for a <see cref="Diagnostic"/>
    /// reported as <c>GS0158</c> (Cannot find member). Returns <see langword="null"/>
    /// when the diagnostic does not sit on the right-hand side of an
    /// <see cref="AccessorExpressionSyntax"/> that uses the regular dot
    /// operator, or when the receiver's type cannot be proven nullable
    /// from the document's syntactic / semantic surface.
    /// </summary>
    /// <param name="uri">The document URI for the workspace edit.</param>
    /// <param name="content">The cached document content.</param>
    /// <param name="diagnostic">The triggering diagnostic.</param>
    /// <returns>A populated <see cref="CodeAction"/> or <see langword="null"/>.</returns>
    public static CodeAction TryCreateDotToQuestionDot(DocumentUri uri, DocumentContent content, CoreDiagnostic diagnostic)
    {
        var accessor = FindAccessorAtRightPart(content.SyntaxTree.Root, diagnostic.Location.Span);
        if (accessor == null || accessor.IsNullConditional)
        {
            return null;
        }

        // The receiver must look nullable. We accept any of:
        //   - the LHS is itself a `?.`/`?[]` chain (its result is nullable),
        //   - a local/parameter whose declared type-clause ends with `?`,
        //   - a field whose declared type-clause ends with `?`,
        //   - a literal `nil` (degenerate but produces the same diagnostic).
        // Concrete CLR-NRT receivers are harder to detect without a full
        // type re-resolution and are handled implicitly when their
        // declaration site already ends with `?`.
        if (!ReceiverLooksNullable(content.SyntaxTree, accessor.LeftPart))
        {
            return null;
        }

        var dotEdit = new TextEdit
        {
            Range = SemanticLookup.ToRange(content.SyntaxTree.Text, accessor.DotToken.Span),
            NewText = "?.",
        };

        return new CodeAction
        {
            Title = NullConditionalAccessTitle,
            Kind = CodeActionKind.QuickFix,
            Edit = new WorkspaceEdit
            {
                Changes = new Dictionary<DocumentUri, IEnumerable<TextEdit>>
                {
                    [uri] = new[] { dotEdit },
                },
            },
        };
    }

    /// <summary>
    /// Builds the null-coalescing-default (<c>??</c>) and null-assertion (<c>!!</c>)
    /// rewrites for a diagnostic that indicates a nullable value flowing
    /// into a non-nullable position. The detector inspects the diagnostic
    /// message for the canonical <c>'T?'</c> → <c>'T'</c> pair surfaced
    /// by <c>ReportCannotConvert</c>, <c>ReportCannotConvertImplicitly</c>,
    /// <c>ReportWrongArgumentType</c>, and the <c>nil</c>-specific
    /// <c>ReportNilNotAssignableToNonNullableParameter</c>.
    /// </summary>
    /// <param name="uri">The document URI for the workspace edit.</param>
    /// <param name="content">The cached document content.</param>
    /// <param name="diagnostic">The triggering diagnostic.</param>
    /// <returns>Zero, one, or two code actions.</returns>
    public static IEnumerable<CodeAction> CreateNullableValueFixes(DocumentUri uri, DocumentContent content, CoreDiagnostic diagnostic)
    {
        if (!TryGetNullableConversionTypes(diagnostic, out var sourceType, out var targetType))
        {
            yield break;
        }

        var span = diagnostic.Location.Span;
        if (span.Length == 0)
        {
            yield break;
        }

        var sourceText = content.SyntaxTree.Text.ToString();
        if (span.Start < 0 || span.End > sourceText.Length || span.Start >= span.End)
        {
            yield break;
        }

        var original = sourceText.Substring(span.Start, span.Length);

        // GS0274 fires on the literal `nil`, where `nil ?? X` and `nil!!`
        // are both degenerate (the user wants to provide a real value or
        // make the parameter nullable). Skip the rewrites — the original
        // diagnostic already carries the canonical suggestion in its
        // message text.
        if (string.Equals(original.Trim(), "nil", System.StringComparison.Ordinal))
        {
            yield break;
        }

        var range = SemanticLookup.ToRange(content.SyntaxTree.Text, span);

        var elvisDefault = SuggestDefaultLiteral(targetType);
        yield return BuildReplacement(
            uri,
            range,
            $"Provide default with '?? {elvisDefault}'",
            $"({original} ?? {elvisDefault})");

        yield return BuildReplacement(
            uri,
            range,
            NullAssertionTitle,
            $"({original}!!)");

        // Reference the unused parameter so analyzers don't flag it.
        _ = sourceType;
    }

    private static CodeAction BuildReplacement(DocumentUri uri, Range range, string title, string replacementText)
    {
        return new CodeAction
        {
            Title = title,
            Kind = CodeActionKind.QuickFix,
            Edit = new WorkspaceEdit
            {
                Changes = new Dictionary<DocumentUri, IEnumerable<TextEdit>>
                {
                    [uri] = new[]
                    {
                        new TextEdit
                        {
                            Range = range,
                            NewText = replacementText,
                        },
                    },
                },
            },
        };
    }

    /// <summary>
    /// Returns the deepest <see cref="AccessorExpressionSyntax"/> whose
    /// <see cref="AccessorExpressionSyntax.RightPart"/> covers
    /// <paramref name="span"/>. The diagnostic for "Cannot find member X"
    /// is reported at the member-name token, so this rebinds that location
    /// to the surrounding accessor.
    /// </summary>
    private static AccessorExpressionSyntax FindAccessorAtRightPart(SyntaxNode root, TextSpan span)
    {
        AccessorExpressionSyntax best = null;
        foreach (var accessor in EnumerateDescendants<AccessorExpressionSyntax>(root))
        {
            if (!ContainsOrEquals(accessor.RightPart.Span, span))
            {
                continue;
            }

            if (best == null || accessor.Span.Length < best.Span.Length)
            {
                best = accessor;
            }
        }

        return best;
    }

    private static bool ContainsOrEquals(TextSpan outer, TextSpan inner)
    {
        return outer.Start <= inner.Start && inner.End <= outer.End;
    }

    private static IEnumerable<T> EnumerateDescendants<T>(SyntaxNode root)
        where T : SyntaxNode
    {
        if (root is T match)
        {
            yield return match;
        }

        foreach (var child in root.GetChildren())
        {
            foreach (var descendant in EnumerateDescendants<T>(child))
            {
                yield return descendant;
            }
        }
    }

    /// <summary>
    /// Conservative receiver-is-nullable check that walks the parse tree
    /// only — it never re-binds the program. The check returns true when
    /// the receiver carries a clearly-nullable surface (e.g. a chained
    /// <c>?.</c>, an explicit <c>nil</c>, or a name that resolves to a
    /// local / parameter / field whose declared type-clause text ends
    /// with <c>?</c>).
    /// </summary>
    private static bool ReceiverLooksNullable(SyntaxTree tree, ExpressionSyntax receiver)
    {
        switch (receiver)
        {
            case AccessorExpressionSyntax nested when nested.IsNullConditional:
                return true;

            case LiteralExpressionSyntax literal when literal.LiteralToken.Kind == SyntaxKind.NilKeyword:
                return true;

            case NameExpressionSyntax name:
                return NameDeclaresNullableType(tree, name.IdentifierToken.Text);

            default:
                return false;
        }
    }

    private static bool NameDeclaresNullableType(SyntaxTree tree, string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return false;
        }

        foreach (var node in EnumerateDescendants<SyntaxNode>(tree.Root))
        {
            switch (node)
            {
                case VariableDeclarationSyntax v
                    when v.Identifier?.Text == name && TypeClauseEndsWithQuestion(v.TypeClause):
                    return true;

                case ParameterSyntax p
                    when p.Identifier?.Text == name && TypeClauseEndsWithQuestion(p.Type):
                    return true;

                case FieldDeclarationSyntax f
                    when f.Identifier?.Text == name && TypeClauseEndsWithQuestion(f.Type):
                    return true;
            }
        }

        return false;
    }

    private static bool TypeClauseEndsWithQuestion(TypeClauseSyntax type)
    {
        if (type == null)
        {
            return false;
        }

        var text = type.SyntaxTree?.Text;
        if (text == null)
        {
            return false;
        }

        var span = type.Span;
        if (span.End <= span.Start || span.End > text.Length)
        {
            return false;
        }

        return text[span.End - 1] == '?';
    }

    /// <summary>
    /// Parses a diagnostic's message text for the canonical pair of
    /// quoted types it carries when reporting a nullable→non-nullable
    /// mismatch. Returns <see langword="true"/> when the source type ends
    /// with <c>?</c> and the target type is the corresponding non-nullable
    /// (or any non-<c>?</c> name); otherwise <see langword="false"/>.
    /// </summary>
    private static bool TryGetNullableConversionTypes(CoreDiagnostic diagnostic, out string sourceType, out string targetType)
    {
        sourceType = null;
        targetType = null;
        var message = diagnostic.Message ?? string.Empty;

        var quoted = new List<string>();
        var i = 0;
        while (i < message.Length)
        {
            if (message[i] == '\'')
            {
                var end = message.IndexOf('\'', i + 1);
                if (end < 0)
                {
                    break;
                }

                quoted.Add(message.Substring(i + 1, end - i - 1));
                i = end + 1;
            }
            else
            {
                i++;
            }
        }

        if (quoted.Count < 2)
        {
            return false;
        }

        switch (diagnostic.Id)
        {
            case "GS0155":
            case "GS0156":
                // "Cannot convert type 'X' to 'Y'."
                sourceType = quoted[0];
                targetType = quoted[1];
                break;

            case "GS0154":
                // "Parameter 'name' requires a value of type 'Y' but was given a value of type 'X'."
                if (quoted.Count < 3)
                {
                    return false;
                }

                targetType = quoted[1];
                sourceType = quoted[2];
                break;

            case "GS0274":
                // "'nil' cannot be assigned to parameter 'name' of non-nullable type 'Y'; ..."
                sourceType = quoted[0];
                targetType = quoted[quoted.Count > 2 ? 2 : 1];
                break;

            default:
                return false;
        }

        if (string.IsNullOrEmpty(sourceType) || string.IsNullOrEmpty(targetType))
        {
            return false;
        }

        if (!sourceType.EndsWith("?", System.StringComparison.Ordinal))
        {
            return false;
        }

        var underlying = sourceType.Substring(0, sourceType.Length - 1);
        return string.Equals(underlying, targetType, System.StringComparison.Ordinal);
    }

    /// <summary>
    /// Picks a sensible literal for the right-hand side of the synthesised
    /// <c>??</c> rewrite. The user is expected to replace it with a real
    /// default; the goal here is to produce a snippet that parses and
    /// type-checks for the common built-ins.
    /// </summary>
    private static string SuggestDefaultLiteral(string targetType)
    {
        return targetType switch
        {
            "string" => "\"\"",
            "bool" => "false",
            "int" or "int8" or "int16" or "int32" or "int64" or "uint8" or "uint16" or "uint32" or "uint64" => "0",
            "float" or "float32" or "float64" or "double" or "decimal" => "0",
            _ => "default",
        };
    }
}
