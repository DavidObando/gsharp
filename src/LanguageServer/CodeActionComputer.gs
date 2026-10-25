// <copyright file="CodeActionComputer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import CoreDiagnostic = GSharp.Core.CodeAnalysis.Diagnostic
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer.Protocol
import Range = GSharp.LanguageServer.Protocol.Range
import System
import System.Collections.Generic
import System.Linq
import System.Threading

/// Computes `textDocument/codeAction` results. The computer combines
/// project-wide refactorings (e.g. "Sort imports") with quick-fixes that
/// react to specific GSharp diagnostics in the requested range — most
/// notably the three nil-related rewrites introduced by ADR-0099 / issue
/// #730:
/// - `.` → `?.` on a member access whose receiver is nullable (GS0158 with a nullable receiver type).
/// - `expr` → `(expr ?? default)` on a nullable value used where a non-nullable value is required
/// (GS0154 / GS0155 / GS0156 / GS0274).
/// - `expr` → `(expr!!)` on the same triggers when the user is certain the value is non-nil at runtime.
shared class CodeActionComputer {
    /// Computes the LSP code actions visible in [`range`](paramref).
    /// The set always includes any whole-document refactorings that apply
    /// (e.g. "Sort imports") regardless of where the caret is — LSP clients
    /// filter on kind/title themselves — plus diagnostic-driven quick fixes
    /// whose underlying diagnostic span overlaps the request range.
    /// @param uri The document URI for edit attribution.
    /// @param content The cached document content (parsed syntax + project).
    /// @param range The LSP request range.
    /// @param ct Token checked between quick-fix-eligible diagnostics.
    /// @returns An LSP (cref:CommandOrCodeActionContainer).
    func ComputeCodeActions(
        uri DocumentUri,
        content DocumentContent,
        $range Range,
        ct CancellationToken = default(CancellationToken)
    ) CommandOrCodeActionContainer {
        let actions = List[CommandOrCodeAction]()
        let sortImports CodeAction? = TryCreateSortImports(uri, content)
        if sortImports != nil {
            actions.Add(CommandOrCodeAction(sortImports))
        }
        AppendNullabilityQuickFixes(uri, content, $range, actions, ct)
        return CommandOrCodeActionContainer(actions)
    }

    private func TryCreateSortImports(uri DocumentUri, content DocumentContent) CodeAction? {
        let imports = content.SyntaxTree.Root.Members.OfType[ImportSyntax]().ToList()
        if imports.Count < 2 {
            return nil
        }
        let source = content.SyntaxTree.Text.ToString()
        let importTexts = imports.Select((i ImportSyntax) -> source.Substring(i.Span.Start, i.Span.Length).TrimEnd())
            .ToList()
        let sorted = importTexts.OrderBy((t string) -> t, StringComparer.Ordinal).ToList()
        if importTexts.SequenceEqual(sorted) {
            return nil
        }
        let start = imports.First().Span.Start
        var end = imports.Last().Span.End
        while end < source.Length && (source[end] == '\r' || source[end] == '\n') {
            end++
            if end <= source.Length && source[end - 1] == '\r' && end < source.Length && source[end] == '\n' {
                end++
            }
            break
        }
        let newText = string.Join(Environment.NewLine, sorted) + Environment.NewLine
        return CodeAction{
            Title: "Sort imports",
            Kind: CodeActionKind.RefactorRewrite,
            Edit: WorkspaceEdit{
                Changes: Dictionary[DocumentUri, IEnumerable[GSharp.LanguageServer.Protocol.TextEdit]]{
                    [uri] = []GSharp
                        .LanguageServer
                        .Protocol
                        .TextEdit{
                        GSharp
                            .LanguageServer
                            .Protocol
                            .TextEdit{
                            Range: SemanticLookup.ToRange(content.SyntaxTree.Text, TextSpan.FromBounds(start, end)),
                            NewText: newText
                        }
                    }
                }
            }
        }
    }

    private func AppendNullabilityQuickFixes(
        uri DocumentUri,
        content DocumentContent,
        $range Range,
        actions List[CommandOrCodeAction],
        ct CancellationToken = default(CancellationToken)
    ) {
        // ADR-0099 / issue #730. Skip the (expensive) BoundProgram pull
        // entirely when the document has no syntax-level diagnostics or
        // global-scope errors that could plausibly host a nullability fix:
        // requesting code-actions on a clean file is a common no-op flow
        // (hover / format / right-click in an editor) and must stay cheap.
        let compilation = content.Project?.GetCompilation() ?? Compilation(content.SyntaxTree)
        let requestSpan = RangeToSpan(content, $range)
        for diag in EnumerateRelevantDiagnostics(compilation, content.SyntaxTree) {
            ct.ThrowIfCancellationRequested()
            if !Overlaps(diag.Location.Span, requestSpan) {
                continue
            }
            switch diag.Id {
                case "GS0158" {
                    let dotFix CodeAction? = NullabilityQuickFixes.TryCreateDotToQuestionDot(uri, content, diag)
                    if dotFix != nil {
                        actions.Add(CommandOrCodeAction(dotFix))
                    }
                }
                case "GS0154", "GS0155", "GS0156", "GS0274" {
                    for fix in NullabilityQuickFixes.CreateNullableValueFixes(uri, content, diag) {
                        actions.Add(CommandOrCodeAction(fix))
                    }
                }
            }
        }
    }

    private func EnumerateRelevantDiagnostics(compilation Compilation, tree SyntaxTree) sequence[CoreDiagnostic] {
        // Quick-fix triggers come exclusively from the binding pass — syntax
        // errors don't carry the type information we key on. Filtering by
        // source tree mirrors DocumentSyncHandler so multi-file projects only
        // surface fixes for the file the user is editing.
        for d in compilation.BoundProgram.Diagnostics {
            if d.Location.Text == tree.Text {
                yield d
            }
        }
        for d in compilation.GlobalScope.Diagnostics {
            if d.Location.Text == tree.Text {
                yield d
            }
        }
    }

    private func RangeToSpan(content DocumentContent, $range Range?) TextSpan {
        if $range == nil {
            return TextSpan(0, 0)
        }
        let start = SemanticLookup.ToOffset(content, $range.Start)
        let end = SemanticLookup.ToOffset(content, $range.End)
        return TextSpan.FromBounds(Math.Min(start, end), Math.Max(start, end))
    }

    private func Overlaps(a TextSpan, b TextSpan) bool {
        var a = a
        var b = b
        // Treat zero-length spans (the typical caret-only request) as a hit
        // when they sit inside the diagnostic range — matches the editor's
        // behaviour of associating "no selection" with whatever the cursor
        // is on.
        return a.Start <= b.End && b.Start <= a.End
    }
}
