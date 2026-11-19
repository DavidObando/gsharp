// <copyright file="CodeActionComputer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import CoreDiagnostic = GSharp.Core.CodeAnalysis.Diagnostic
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer.Protocol
import Range = GSharp.LanguageServer.Protocol.Range
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Runtime.CompilerServices
import System.Threading

/// What the client supports for code actions (ADR-0227 D7).
class CodeActionClientOptions {
    /// Gets or sets a value that tells whether the client applies versioned `documentChanges`.
    prop SupportsDocumentChanges bool

    /// Gets or sets a value that tells whether the client resolves the `edit` of an action lazily.
    prop SupportsResolveEdit bool
}

/// Computes `textDocument/codeAction` and `codeAction/resolve` results (ADR-0227 D7). The fixes
/// come from (cref:CodeFixService): the built-in providers of `GSharp.Core` and the providers of
/// the project's analyzer assemblies. "Sort imports" is a refactoring of the server.
shared class CodeActionComputer {
    // A document without a project uses the built-in providers only.
    private let DefaultRegistry CodeFixRegistry = CodeFixRegistry.CreateDefault()

    // ADR-0227 D7: the analyzer diagnostics of a compilation snapshot. A new snapshot is a new key,
    // so an edit invalidates the entry.
    private let AnalyzerResults ConditionalWeakTable[Compilation, AnalyzerResult] = ConditionalWeakTable[
        Compilation,
        AnalyzerResult
    ]()

    /// The time budget of each analyzer when the computer runs the analyzers itself.
    private const AnalyzerTimeBudgetMilliseconds int32 = 2000

    /// Computes the code actions for [`range`](paramref) with no request context.
    /// @param uri The document URI for edit attribution.
    /// @param content The cached document content (parsed syntax + project).
    /// @param range The LSP request range.
    /// @param ct Cancels the computation.
    /// @returns An LSP (cref:CommandOrCodeActionContainer).
    func ComputeCodeActions(
        uri DocumentUri,
        content DocumentContent,
        $range Range,
        ct CancellationToken = default(CancellationToken)
    ) CommandOrCodeActionContainer -> ComputeCodeActions(uri, content, $range, nil, CodeActionClientOptions(), ct)

    /// Computes the code actions for [`range`](paramref): the whole-document refactorings that
    /// apply, and the fixes of the diagnostics whose span overlaps the range. Each fix passes the
    /// syntax stage of the delta gate: it adds no syntax diagnostic (ADR-0227 decision Q4).
    /// @param uri The document URI for edit attribution.
    /// @param content The cached document content (parsed syntax + project).
    /// @param range The LSP request range.
    /// @param context The request context; its `only` filters the kinds.
    /// @param client What the client supports.
    /// @param ct Cancels the computation.
    /// @returns An LSP (cref:CommandOrCodeActionContainer).
    func ComputeCodeActions(
        uri DocumentUri,
        content DocumentContent,
        $range Range,
        context CodeActionContext?,
        client CodeActionClientOptions,
        ct CancellationToken = default(CancellationToken)
    ) CommandOrCodeActionContainer {
        let only IReadOnlyList[CodeActionKind]? = context?.Only
        let actions = List[CommandOrCodeAction]()
        if KindRequested(CodeActionKind.RefactorRewrite, only) {
            let sortImports CodeAction? = TryCreateSortImports(uri, content, client)
            if sortImports != nil {
                actions.Add(CommandOrCodeAction(sortImports))
            }
        }
        if KindRequested(CodeActionKind.QuickFix, only) {
            for action in ComputeQuickFixes(uri, content, RangeToSpan(content, $range), client, nil, ct) {
                actions.Add(CommandOrCodeAction(action))
            }
        }
        return CommandOrCodeActionContainer(actions)
    }

    /// Resolves the edit of an action that the list request returned without one. The action
    /// gets no edit when the document has another version, or when the fix no longer exists.
    /// @param action The action from the client.
    /// @param content The current document content.
    /// @param client What the client supports.
    /// @param ct Cancels the computation.
    /// @returns The action, with its edit when the fix still applies to the same version.
    func ResolveCodeAction(
        action CodeAction,
        content DocumentContent,
        client CodeActionClientOptions,
        ct CancellationToken = default(CancellationToken)
    ) CodeAction {
        let data CodeActionData? = action.Data
        if data == nil || action.Edit != nil || data.Version != content.Version {
            return action
        }
        let uri DocumentUri? = DocumentUri.From(data.Uri)
        if uri == nil {
            return action
        }
        let separator = data.Key.LastIndexOf('@')
        if separator < 0 || !int32.TryParse(data.Key.Substring(separator + 1), out var start) {
            return action
        }
        let eager = CodeActionClientOptions{
            SupportsDocumentChanges: client.SupportsDocumentChanges,
            SupportsResolveEdit: false
        }
        for candidate in ComputeQuickFixes(uri, content, TextSpan(start, 0), eager, data.Key, ct) {
            action.Edit = candidate.Edit
            return action
        }
        return action
    }

    private func ComputeQuickFixes(
        uri DocumentUri,
        content DocumentContent,
        span TextSpan,
        client CodeActionClientOptions,
        onlyKey string?,
        ct CancellationToken
    ) sequence[CodeAction] {
        let tree = content.SyntaxTree
        let compilation = CompilationFor(content)
        let registry = content.Project?.GetCodeFixRegistry() ?? DefaultRegistry
        let service = CodeFixService(registry)
        let fixes = service.GetFixes(
            compilation,
            tree,
            span,
            AnalyzerDiagnostics(content, compilation, registry, ct),
            out _,
            ct
        )
        if fixes.IsEmpty {
            yield break
        }
        // ADR-0227 Q4: in phase 1 the server runs the syntax stage of the gate on every fix.
        let gateOptions = DeltaOptions()
        gateOptions.SyntaxOnly = true
        let baseline = DeltaBaseline.Create(compilation, gateOptions, ct)
        let ordinals = Dictionary[string, int32](StringComparer.Ordinal)
        for fix in fixes {
            ct.ThrowIfCancellationRequested()
            let start = if fix.Diagnostics.IsEmpty {
                0
            } else {
                fix.Diagnostics[0].Location.Span.Start
            }
            let baseKey = "${fix.ProviderId}|${fix.EquivalenceKey}|${start}"
            var ordinal = 0
            if ordinals.TryGetValue(baseKey, out var seen) {
                ordinal = seen + 1
            }
            ordinals[baseKey] = ordinal
            let key = "${baseKey}#${ordinal}@${start}"
            if onlyKey != nil && key != onlyKey {
                continue
            }
            if !service.ComputeDelta(baseline, fix, ct).AddedSyntax.IsEmpty {
                continue
            }
            let action = CodeAction{
                Title: fix.Title,
                Kind: CodeActionKind.QuickFix,
                Diagnostics: fix.Diagnostics.Select((d CoreDiagnostic) -> ToProtocolDiagnostic(d, tree.Text)).ToList(),
                IsPreferred: if IsPreferred(fix, fixes) {
                    true
                } else {
                    default(bool?)
                }
            }
            if client.SupportsResolveEdit {
                action.Data = CodeActionData{Uri: uri.ToString(), Version: content.Version, Key: key}
            } else {
                action.Edit = BuildEdit(uri, content, fix.GetChanges(ct), client)
            }
            yield action
        }
    }

    // ADR-0227 D5: the one machine-applicable fix of a diagnostic is the preferred action.
    private func IsPreferred(fix CodeFix, all ImmutableArray[CodeFix]) bool {
        if fix.Applicability != Applicability.MachineApplicable || fix.Diagnostics.IsEmpty {
            return false
        }
        let target = fix.Diagnostics[0]
        return all.Count(
            (other CodeFix) -> other.Applicability == Applicability.MachineApplicable && other.Diagnostics.Contains(
                target
            )
        ) == 1
    }

    private func BuildEdit(
        uri DocumentUri,
        content DocumentContent,
        changes FixChanges,
        client CodeActionClientOptions
    ) WorkspaceEdit {
        let documentEdits = List[TextDocumentEdit]()
        for document in changes.Documents {
            let own = object.ReferenceEquals(document.Tree, content.SyntaxTree)
            let documentUri DocumentUri? = if own {
                uri
            } else {
                DocumentUri.FromFileSystemPath(document.Tree.Text.FileName)
            }
            if documentUri == nil {
                continue
            }
            let edits = document
                .Changes
                .Select(
                (c TextChange) -> GSharp
                    .LanguageServer
                    .Protocol
                    .TextEdit{Range: SemanticLookup.ToRange(document.Tree.Text, c.Span), NewText: c.NewText}
            )
                .ToList()
            documentEdits.Add(
                TextDocumentEdit{
                    TextDocument: OptionalVersionedTextDocumentIdentifier{
                        Uri: documentUri,
                        Version: if own {
                            content.Version
                        } else {
                            default(int32?)
                        }
                    },
                    Edits: edits
                }
            )
        }
        if client.SupportsDocumentChanges {
            return WorkspaceEdit{DocumentChanges: documentEdits}
        }
        let byUri = Dictionary[DocumentUri, IEnumerable[GSharp.LanguageServer.Protocol.TextEdit]]()
        for d in documentEdits {
            byUri[d.TextDocument.Uri] = d.Edits
        }
        return WorkspaceEdit{Changes: byUri}
    }

    // The compilation that holds the document's tree: the project's, else a one-tree compilation.
    private func CompilationFor(content DocumentContent) Compilation {
        let tree = content.SyntaxTree
        let project ProjectState? = content.Project
        if project != nil {
            let compilation = project.GetCompilation()
            if compilation.SyntaxTrees.Contains(tree) {
                return compilation
            }
            let path = tree.Text.FileName
            if !string.IsNullOrEmpty(path) && project.ContainsFile(path) {
                let snapshot = project.GetCompilationForSnapshot(path, tree)
                if snapshot.SyntaxTrees.Contains(tree) {
                    return snapshot
                }
            }
        }
        return ServerCompilation.Create(tree)
    }

    // ADR-0227 D7: analyzer diagnostics, only when a provider fixes one of the analyzers' IDs.
    private func AnalyzerDiagnostics(
        content DocumentContent,
        compilation Compilation,
        registry CodeFixRegistry,
        ct CancellationToken
    ) ImmutableArray[CoreDiagnostic] {
        let project ProjectState? = content.Project
        if project == nil {
            return ImmutableArray[CoreDiagnostic].Empty
        }
        let analyzers = project.GetGsAnalyzers(out _)
        if analyzers.IsEmpty {
            return ImmutableArray[CoreDiagnostic].Empty
        }
        let fixable = analyzers.Any(
            (a GSharpDiagnosticAnalyzer) -> a.SupportedDiagnostics.Any(
                (d GSharp.Core.CodeAnalysis.DiagnosticDescriptor) -> !registry.GetProviders(d.Id).IsEmpty
            )
        )
        if !fixable {
            return ImmutableArray[CoreDiagnostic].Empty
        }
        if AnalyzerResults.TryGetValue(compilation, out var cached) {
            return cached.Diagnostics
        }
        let produced = GSharpAnalyzerDriver.Run(
            compilation,
            analyzers,
            AnalyzerOptions{TimeBudgetMilliseconds: AnalyzerTimeBudgetMilliseconds},
            ct
        )
        AnalyzerResults.AddOrUpdate(compilation, AnalyzerResult(produced))
        return produced
    }

    private func KindRequested(kind CodeActionKind, only IReadOnlyList[CodeActionKind]?) bool {
        if only == nil || only.Count == 0 {
            return true
        }
        let value = kind.Value ?? string.Empty
        for o in only {
            let requested = o.Value ?? string.Empty
            if value == requested || value.StartsWith(requested + ".", StringComparison.Ordinal) {
                return true
            }
        }
        return false
    }

    private func ToProtocolDiagnostic(d CoreDiagnostic, text SourceText) GSharp.LanguageServer.Protocol.Diagnostic {
        let source SourceText = d.Location.Text ?? text
        return GSharp
            .LanguageServer
            .Protocol
            .Diagnostic{
            Code: DiagnosticCode(d.Id),
            Message: d.Message,
            Range: SemanticLookup.ToRange(source, d.Location.Span),
            Severity: DocumentSyncHandler.ToLspSeverity(d.Severity),
            Source: Constants.LanguageIdentifier
        }
    }

    private func TryCreateSortImports(
        uri DocumentUri,
        content DocumentContent,
        client CodeActionClientOptions
    ) CodeAction? {
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
        let changes = FixChanges(
            ImmutableArray.Create(
                DocumentChanges(
                    content.SyntaxTree,
                    ImmutableArray.Create(TextChange(TextSpan.FromBounds(start, end), newText)),
                    ImmutableArray[TextSpan].Empty
                )
            )
        )
        return CodeAction{
            Title: "Sort imports",
            Kind: CodeActionKind.RefactorRewrite,
            Edit: BuildEdit(uri, content, changes, client)
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

    private class AnalyzerResult {
        init(diagnostics ImmutableArray[CoreDiagnostic]) {
            Diagnostics = diagnostics
        }

        prop Diagnostics ImmutableArray[CoreDiagnostic] {
            get;
        }
    }
}
