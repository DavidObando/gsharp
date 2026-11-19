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
import System.Collections.Concurrent
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

    /// Gets or sets the stored content of an open document (its tree and client version, captured
    /// together), or `null` when the document is not open. The server sets it; an edit of another
    /// open document carries that version.
    prop DocumentOf Func[DocumentUri, DocumentContent?]?
}

/// Computes `textDocument/codeAction` and `codeAction/resolve` results (ADR-0227 D7). The fixes
/// come from (cref:CodeFixService): the built-in providers of `GSharp.Core` and the providers of
/// the project's analyzer assemblies. "Sort imports" is a refactoring of the server.
shared class CodeActionComputer {
    // A document without a project uses the built-in providers only.
    private let DefaultRegistry CodeFixRegistry = CodeFixRegistry.CreateDefault()

    // ADR-0227 D7: the analyzer diagnostics of a compilation snapshot and an analyzer set. Any edit
    // of the project makes a new snapshot, and a change of the analyzer configuration makes a new
    // analyzer set, so either one invalidates the entry. The document version alone is not enough.
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
    ) CommandOrCodeActionContainer -> ComputeCodeActions(uri, content, $range, context, client, nil, ct)

    // Tests give the registry; the server uses the project's.
    internal func ComputeCodeActions(
        uri DocumentUri,
        content DocumentContent,
        $range Range,
        context CodeActionContext?,
        client CodeActionClientOptions,
        registryOverride CodeFixRegistry?,
        ct CancellationToken
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
            for action in ComputeQuickFixes(uri, content, RangeToSpan(content, $range), client, registryOverride, ct) {
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
        if data == nil || action.Edit != nil {
            return action
        }
        // ADR-0227 D7: resolve returns the edit that the list request computed and gated, never a
        // recomputed one. It returns no edit when a snapshot that the edit depends on changed.
        if !ResolveCache.TryGetValue(data.Key, out var entry) {
            return action
        }
        if entry.Version != content.Version || !object.ReferenceEquals(entry.Tree, content.SyntaxTree) {
            return action
        }
        if entry.ProjectCompilation != nil && !object.ReferenceEquals(
            entry.ProjectCompilation,
            content.Project?.GetCompilation()
        ) {
            return action
        }
        for pair in entry.OtherVersions {
            if CurrentVersion(client, pair.Key) != pair.Value {
                return action
            }
        }
        action.Edit = entry.Edit
        return action
    }

    // The gated edits that a lazy client resolves later, by an opaque ID (ADR-0227 D7). The cache
    // keeps the newest entries only.
    private let ResolveCache ConcurrentDictionary[string, ResolveEntry] = ConcurrentDictionary[string, ResolveEntry](
        StringComparer.Ordinal
    )

    private let ResolveOrder ConcurrentQueue[string] = ConcurrentQueue[string]()

    private const ResolveCacheCapacity int32 = 512

    private func Remember(entry ResolveEntry) string {
        let id = Guid.NewGuid().ToString("N")
        ResolveCache[id] = entry
        ResolveOrder.Enqueue(id)
        while ResolveOrder.Count > ResolveCacheCapacity && ResolveOrder.TryDequeue(out var oldest) {
            ResolveCache.TryRemove(oldest, out _)
        }
        return id
    }

    private func ComputeQuickFixes(
        uri DocumentUri,
        content DocumentContent,
        span TextSpan,
        client CodeActionClientOptions,
        registryOverride CodeFixRegistry?,
        ct CancellationToken
    ) sequence[CodeAction] {
        let tree = content.SyntaxTree
        // The project snapshot is captured once, before the fixes are computed, and the fixes use
        // it when it holds the document's tree. The resolve entry records the same snapshot, so
        // resolve cannot accept a fix that was gated against older files.
        let projectCompilation Compilation? = content.Project?.GetCompilation()
        let compilation = CompilationFor(content, projectCompilation)
        let registry = registryOverride ?? content.Project?.GetCodeFixRegistry() ?? DefaultRegistry
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
        // First the fixes that survive the gate, their computation and the edit; then the actions,
        // so that the preferred fix is chosen among the fixes that the client gets.
        let survivors = List[Candidate]()
        for fix in fixes {
            ct.ThrowIfCancellationRequested()
            // A provider's deferred computation can throw. That fix is dropped; the others stay.
            var changes FixChanges? = nil
            try {
                if !service.ComputeDelta(baseline, fix, ct).AddedSyntax.IsEmpty {
                    continue
                }
                changes = fix.GetChanges(ct)
            } catch (ex OperationCanceledException) when ct.IsCancellationRequested {
                rethrow
            } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
                continue
            }
            let edit WorkspaceEdit? = BuildEdit(uri, content, changes, client, out var otherVersions)
            if edit != nil {
                survivors.Add(Candidate(fix, edit, otherVersions))
            }
        }
        let offered = survivors.Select((c Candidate) -> c.Fix).ToImmutableArray()
        for candidate in survivors {
            let fix = candidate.Fix
            let action = CodeAction{
                Title: fix.Title,
                Kind: CodeActionKind.QuickFix,
                Diagnostics: fix.Diagnostics.Select((d CoreDiagnostic) -> ToProtocolDiagnostic(d, tree.Text)).ToList(),
                IsPreferred: if IsPreferred(fix, offered) {
                    true
                } else {
                    default(bool?)
                }
            }
            if client.SupportsResolveEdit {
                let id = Remember(
                    ResolveEntry(candidate.Edit, content.Version, tree, projectCompilation, candidate.OtherVersions)
                )
                action.Data = CodeActionData{Uri: uri.ToString(), Version: content.Version, Key: id}
            } else {
                action.Edit = candidate.Edit
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

    internal func BuildEdit(
        uri DocumentUri,
        content DocumentContent,
        changes FixChanges,
        client CodeActionClientOptions
    ) WorkspaceEdit? -> BuildEdit(uri, content, changes, client, out _)

    // Builds the edit. An edit of another open document uses the version that was stored with that
    // document's tree. When the open document's tree is not the tree that the fix edited (the
    // document changed after the compilation was built), the ranges would be stale, so there is no edit.
    internal func BuildEdit(
        uri DocumentUri,
        content DocumentContent,
        changes FixChanges,
        client CodeActionClientOptions,
        out otherVersions Dictionary[string, int32?]
    ) WorkspaceEdit? {
        otherVersions = Dictionary[string, int32?](StringComparer.Ordinal)
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
            var version int32? = content.Version
            if !own {
                version = nil
                let openDocument DocumentContent? = client.DocumentOf?(documentUri)
                if openDocument != nil {
                    if !object.ReferenceEquals(openDocument.SyntaxTree, document.Tree) &&
                        openDocument
                        .SyntaxTree
                        .Text
                        .ToString() != document
                        .Tree
                        .Text
                        .ToString() {
                        return nil
                    }
                    version = openDocument.Version
                }
                otherVersions[documentUri.ToString()] = version
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
                    TextDocument: OptionalVersionedTextDocumentIdentifier{Uri: documentUri, Version: version},
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

    // The current client version of an open document, or null.
    private func CurrentVersion(client CodeActionClientOptions, key string) int32? {
        let other DocumentUri? = DocumentUri.From(key)
        if other == nil {
            return nil
        }
        let openDocument DocumentContent? = client.DocumentOf?(other)
        if openDocument == nil {
            return nil
        }
        return openDocument.Version
    }

    // The compilation that holds the document's tree: the project's, else a one-tree compilation.
    private func CompilationFor(content DocumentContent, projectCompilation Compilation? = nil) Compilation {
        let tree = content.SyntaxTree
        let project ProjectState? = content.Project
        if project != nil {
            let compilation = projectCompilation ?? project.GetCompilation()
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
        let fixable = AnyFixable(analyzers, registry, ct)
        if !fixable {
            return ImmutableArray[CoreDiagnostic].Empty
        }
        if AnalyzerResults.TryGetValue(compilation, out var cached) && cached.Analyzers == analyzers {
            return cached.Diagnostics
        }
        let produced = GSharpAnalyzerDriver.Run(
            compilation,
            analyzers,
            AnalyzerOptions{TimeBudgetMilliseconds: AnalyzerTimeBudgetMilliseconds},
            ct
        )
        AnalyzerResults.AddOrUpdate(compilation, AnalyzerResult(analyzers, produced))
        return produced
    }

    // Whether a provider fixes an ID that one of the analyzers reports. A failing metadata getter
    // skips that analyzer only; the driver guards the same read.
    internal func AnyFixable(
        analyzers ImmutableArray[GSharpDiagnosticAnalyzer],
        registry CodeFixRegistry,
        ct CancellationToken
    ) bool {
        for analyzer in analyzers {
            try {
                if analyzer.SupportedDiagnostics.Any(
                    (d GSharp.Core.CodeAnalysis.DiagnosticDescriptor) -> !registry.GetProviders(d.Id).IsEmpty
                ) {
                    return true
                }
            } catch (ex OperationCanceledException) when ct.IsCancellationRequested {
                rethrow
            } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
                continue
            }
        }
        return false
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
            // Only the requested document changes, so the edit always exists.
            Edit: BuildEdit(uri, content, changes, client)!!
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

    private class Candidate {
        init(fix CodeFix, edit WorkspaceEdit, otherVersions Dictionary[string, int32?]) {
            Fix = fix
            Edit = edit
            OtherVersions = otherVersions
        }

        prop Fix CodeFix {
            get;
        }

        prop Edit WorkspaceEdit {
            get;
        }

        prop OtherVersions Dictionary[string, int32?] {
            get;
        }
    }

    private class ResolveEntry {
        init(
            edit WorkspaceEdit,
            version int32?,
            tree SyntaxTree,
            projectCompilation Compilation?,
            otherVersions Dictionary[string, int32?]
        ) {
            Edit = edit
            Version = version
            Tree = tree
            ProjectCompilation = projectCompilation
            OtherVersions = otherVersions
        }

        prop Edit WorkspaceEdit {
            get;
        }

        prop Version int32? {
            get;
        }

        prop Tree SyntaxTree {
            get;
        }

        prop ProjectCompilation Compilation? {
            get;
        }

        prop OtherVersions Dictionary[string, int32?] {
            get;
        }
    }

    private class AnalyzerResult {
        init(analyzers ImmutableArray[GSharpDiagnosticAnalyzer], diagnostics ImmutableArray[CoreDiagnostic]) {
            Analyzers = analyzers
            Diagnostics = diagnostics
        }

        // The analyzer set of the run, compared by reference: ProjectState replaces it on a reload.
        prop Analyzers ImmutableArray[GSharpDiagnosticAnalyzer] {
            get;
        }

        prop Diagnostics ImmutableArray[CoreDiagnostic] {
            get;
        }
    }
}
