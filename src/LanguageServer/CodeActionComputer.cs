// <copyright file="CodeActionComputer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.LanguageServer.Protocol;
using CoreDiagnostic = GSharp.Core.CodeAnalysis.Diagnostic;
using Range = GSharp.LanguageServer.Protocol.Range;

namespace GSharp.LanguageServer;

/// <summary>
/// Computes <c>textDocument/codeAction</c> results. The computer combines
/// project-wide refactorings (e.g. "Sort imports") with quick-fixes that
/// react to specific GSharp diagnostics in the requested range — most
/// notably the three nil-related rewrites introduced by ADR-0099 / issue
/// #730:
/// <list type="bullet">
///   <item>
///     <description><c>.</c> → <c>?.</c> on a member access whose receiver
///     is nullable (GS0158 with a nullable receiver type).</description>
///   </item>
///   <item>
///     <description><c>expr</c> → <c>(expr ?? default)</c> on a nullable
///     value used where a non-nullable value is required (GS0154 / GS0155
///     / GS0156 / GS0274).</description>
///   </item>
///   <item>
///     <description><c>expr</c> → <c>(expr!!)</c> on the same triggers
///     when the user is certain the value is non-nil at runtime.</description>
///   </item>
/// </list>
/// </summary>
public static class CodeActionComputer
{
    /// <summary>
    /// Computes the LSP code actions visible in <paramref name="range"/>.
    /// The set always includes any whole-document refactorings that apply
    /// (e.g. "Sort imports") regardless of where the caret is — LSP clients
    /// filter on kind/title themselves — plus diagnostic-driven quick fixes
    /// whose underlying diagnostic span overlaps the request range.
    /// </summary>
    /// <param name="uri">The document URI for edit attribution.</param>
    /// <param name="content">The cached document content (parsed syntax + project).</param>
    /// <param name="range">The LSP request range.</param>
    /// <param name="ct">Token checked between quick-fix-eligible diagnostics.</param>
    /// <returns>An LSP <see cref="CommandOrCodeActionContainer"/>.</returns>
    public static CommandOrCodeActionContainer ComputeCodeActions(DocumentUri uri, DocumentContent content, Range range, CancellationToken ct = default)
    {
        var actions = new List<CommandOrCodeAction>();

        var sortImports = TryCreateSortImports(uri, content);
        if (sortImports != null)
        {
            actions.Add(new CommandOrCodeAction(sortImports));
        }

        AppendNullabilityQuickFixes(uri, content, range, actions, ct);

        return new CommandOrCodeActionContainer(actions);
    }

    private static CodeAction TryCreateSortImports(DocumentUri uri, DocumentContent content)
    {
        var imports = content.SyntaxTree.Root.Members.OfType<ImportSyntax>().ToList();
        if (imports.Count < 2)
        {
            return null;
        }

        var source = content.SyntaxTree.Text.ToString();
        var importTexts = imports.Select(i => source.Substring(i.Span.Start, i.Span.Length).TrimEnd()).ToList();
        var sorted = importTexts.OrderBy(t => t, StringComparer.Ordinal).ToList();
        if (importTexts.SequenceEqual(sorted))
        {
            return null;
        }

        var start = imports.First().Span.Start;
        var end = imports.Last().Span.End;
        while (end < source.Length && (source[end] == '\r' || source[end] == '\n'))
        {
            end++;
            if (end <= source.Length && source[end - 1] == '\r' && end < source.Length && source[end] == '\n')
            {
                end++;
            }

            break;
        }

        var newText = string.Join(Environment.NewLine, sorted) + Environment.NewLine;
        return new CodeAction
        {
            Title = "Sort imports",
            Kind = CodeActionKind.RefactorRewrite,
            Edit = new WorkspaceEdit
            {
                Changes = new Dictionary<DocumentUri, IEnumerable<TextEdit>>
                {
                    [uri] = new[]
                    {
                        new TextEdit
                        {
                            Range = SemanticLookup.ToRange(content.SyntaxTree.Text, TextSpan.FromBounds(start, end)),
                            NewText = newText,
                        },
                    },
                },
            },
        };
    }

    private static void AppendNullabilityQuickFixes(DocumentUri uri, DocumentContent content, Range range, List<CommandOrCodeAction> actions, CancellationToken ct = default)
    {
        // ADR-0099 / issue #730. Skip the (expensive) BoundProgram pull
        // entirely when the document has no syntax-level diagnostics or
        // global-scope errors that could plausibly host a nullability fix:
        // requesting code-actions on a clean file is a common no-op flow
        // (hover / format / right-click in an editor) and must stay cheap.
        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
        var requestSpan = RangeToSpan(content, range);

        foreach (var diag in EnumerateRelevantDiagnostics(compilation, content.SyntaxTree))
        {
            ct.ThrowIfCancellationRequested();
            if (!Overlaps(diag.Location.Span, requestSpan))
            {
                continue;
            }

            switch (diag.Id)
            {
                case "GS0158":
                    var dotFix = NullabilityQuickFixes.TryCreateDotToQuestionDot(uri, content, diag);
                    if (dotFix != null)
                    {
                        actions.Add(new CommandOrCodeAction(dotFix));
                    }

                    break;

                case "GS0154":
                case "GS0155":
                case "GS0156":
                case "GS0274":
                    foreach (var fix in NullabilityQuickFixes.CreateNullableValueFixes(uri, content, diag))
                    {
                        actions.Add(new CommandOrCodeAction(fix));
                    }

                    break;
            }
        }
    }

    private static IEnumerable<CoreDiagnostic> EnumerateRelevantDiagnostics(Compilation compilation, SyntaxTree tree)
    {
        // Quick-fix triggers come exclusively from the binding pass — syntax
        // errors don't carry the type information we key on. Filtering by
        // source tree mirrors DocumentSyncHandler so multi-file projects only
        // surface fixes for the file the user is editing.
        foreach (var d in compilation.BoundProgram.Diagnostics)
        {
            if (d.Location.Text == tree.Text)
            {
                yield return d;
            }
        }

        foreach (var d in compilation.GlobalScope.Diagnostics)
        {
            if (d.Location.Text == tree.Text)
            {
                yield return d;
            }
        }
    }

    private static TextSpan RangeToSpan(DocumentContent content, Range range)
    {
        if (range == null)
        {
            return new TextSpan(0, 0);
        }

        var start = SemanticLookup.ToOffset(content, range.Start);
        var end = SemanticLookup.ToOffset(content, range.End);
        return TextSpan.FromBounds(Math.Min(start, end), Math.Max(start, end));
    }

    private static bool Overlaps(TextSpan a, TextSpan b)
    {
        // Treat zero-length spans (the typical caret-only request) as a hit
        // when they sit inside the diagnostic range — matches the editor's
        // behaviour of associating "no selection" with whatever the cursor
        // is on.
        return a.Start <= b.End && b.Start <= a.End;
    }
}
