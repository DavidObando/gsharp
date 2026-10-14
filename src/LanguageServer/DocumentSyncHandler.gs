// <copyright file="DocumentSyncHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer.Protocol
import Range = GSharp.LanguageServer.Protocol.Range
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// GSharp diagnostics computation used by document synchronization.
shared class DocumentSyncHandler {
    /// Per-analyzer wall-clock budget for a language-server analysis run
    /// (ADR-0169). An analyzer exceeding it is disabled for the run and
    /// reports GS9302; batch compilation (gsc) runs unbudgeted.
    internal const AnalyzerTimeBudgetMilliseconds int32 = 1000

    func ComputeDiagnostics(text string, skipBinding bool) DiagnosticComputationResult {
        return ComputeDiagnostics(text, skipBinding, project: nil, filePath: nil, workspace: nil)
    }

    func ComputeDiagnostics(text string, skipBinding bool, project ProjectState) DiagnosticComputationResult {
        return ComputeDiagnostics(text, skipBinding, project, filePath: nil, workspace: nil)
    }

    func ComputeDiagnostics(
        text string,
        skipBinding bool,
        project ProjectState,
        filePath string?
    ) DiagnosticComputationResult {
        return ComputeDiagnostics(text, skipBinding, project, filePath, workspace: nil)
    }

    func ComputeDiagnostics(
        text string,
        skipBinding bool,
        project ProjectState?,
        filePath string?,
        workspace WorkspaceState?
    ) DiagnosticComputationResult {
        // Mutating path: only safe to call while holding the write gate (didOpen/didChange/
        // didSave). UpdateFile overwrites the project's shared per-file SyntaxTree with no lock
        // of its own; calling it off-gate lets a stale snapshot clobber a newer concurrently
        // written tree (issue #1657). Non-mutating requests must use
        // <see cref="ComputeDiagnosticsForSnapshot"/> instead.
        var compilation Compilation
        var syntaxTree SyntaxTree
        let useProject = project != nil && filePath != nil && project.ContainsFile(filePath)
        if useProject && project != nil && filePath != nil {
            syntaxTree = project.UpdateFile(filePath, text)
            compilation = project.GetCompilation()
        } else {
            syntaxTree = SyntaxTree.Parse(text)
            compilation = Compilation(syntaxTree)
        }
        return BuildResult(syntaxTree, compilation, useProject, skipBinding, project, workspace)
    }

    /// Read-only counterpart to (cref:ComputeDiagnostics(string, bool, ProjectState, string,
    /// WorkspaceState))
    /// for non-mutating requests (e.g. the textDocument/diagnostic pull handler) that run off the
    /// write gate. Binds against the caller-supplied [`syntaxTree`](paramref) snapshot
    /// exactly as-is: it never calls (cref:ProjectState.UpdateFile) and never mutates
    /// [`project`](paramref)'s cached trees or compilation, so a diagnostics pull for a
    /// stale snapshot can never overwrite a newer tree written by a concurrent didChange
    /// (issue #1657). The returned diagnostics always reflect exactly the requested snapshot text.
    /// @param syntaxTree The already-parsed snapshot tree to bind and report diagnostics for.
    /// @param skipBinding When `true`, skips the (potentially expensive) binding pass and reports only
    /// syntax diagnostics.
    /// @param project The project owning [`filePath`](paramref), or `null` if the file is not part of a
    /// project.
    /// @param filePath Absolute path to the `.gs` file the snapshot belongs to.
    /// @param workspace The current workspace state, used to resolve cross-file symbols during binding.
    /// @returns The computed diagnostics and binding metadata for [`syntaxTree`](paramref).
    func ComputeDiagnosticsForSnapshot(
        syntaxTree SyntaxTree,
        skipBinding bool,
        project ProjectState?,
        filePath string,
        workspace WorkspaceState?
    ) DiagnosticComputationResult {
        let useProject = project != nil && !string.IsNullOrEmpty(filePath) && project.ContainsFile(filePath)
        var compilation Compilation
        if useProject && project != nil {
            compilation = project.GetCompilationForSnapshot(filePath, syntaxTree)
        } else {
            compilation = Compilation(syntaxTree)
        }
        return BuildResult(syntaxTree, compilation, useProject, skipBinding, project, workspace)
    }

    private func BuildResult(
        syntaxTree SyntaxTree,
        compilation Compilation,
        useProject bool,
        skipBinding bool,
        project ProjectState?,
        workspace WorkspaceState?
    ) DiagnosticComputationResult {
        let text = syntaxTree.Text.ToString()
        let newLines = List[int32]()
        var nextNewLine = text.IndexOf('\n')
        while nextNewLine >= 0 {
            newLines.Add(nextNewLine)
            nextNewLine = text.IndexOf('\n', nextNewLine + 1)
        }
        let diagnostics = List[GSharp.LanguageServer.Protocol.Diagnostic]()
        // ADR-0175 amendment (#4422): parser warnings honour @SuppressDiagnostic
        // exactly as gsc's EmitResult does.
        for d in compilation.ApplySourceSuppressions(syntaxTree.Diagnostics) {
            diagnostics.Add(
                BuildDiagnostic("Syntax", d.Message, d.Location.Span.Start, d.Location.Span.End, syntaxTree.Text)
            )
        }
        if !skipBinding {
            // ADR-0175 amendment (#4422): drop what a source
            // @SuppressDiagnostic scope covers, exactly as gsc's EmitResult does.
            for d in compilation.ApplySourceSuppressions(compilation.GlobalScope.Diagnostics) {
                // Only report diagnostics that originate from this file's syntax tree.
                if useProject && d.Location.Text != syntaxTree.Text {
                    continue
                }
                diagnostics.Add(
                    BuildDiagnostic("Semantic", d.Message, d.Location.Span.Start, d.Location.Span.End, syntaxTree.Text)
                )
            }
            let program = compilation.BoundProgram
            for d in compilation.ApplySourceSuppressions(program.Diagnostics) {
                if useProject && d.Location.Text != syntaxTree.Text {
                    continue
                }
                diagnostics.Add(
                    BuildDiagnostic("Binding", d.Message, d.Location.Span.Start, d.Location.Span.End, syntaxTree.Text)
                )
            }
            // Documentation validation (warnings only — these don't block compilation).
            let docDiagnostics = DiagnosticBag()
            DocumentationValidator.Validate(
                if useProject {
                    compilation.SyntaxTrees
                } else {
                    ImmutableArray.Create(syntaxTree)
                },
                program.Functions.Keys.ToImmutableArray(),
                program.Structs,
                docDiagnostics,
                warnOnMissingDocs: false
            )
            for d in compilation.ApplySourceSuppressions(docDiagnostics.ToImmutableArray()) {
                if useProject && d.Location.Text != syntaxTree.Text {
                    continue
                }
                diagnostics.Add(
                    BuildDiagnostic(
                        d.Id,
                        d.Message,
                        d.Location.Span.Start,
                        d.Location.Span.End,
                        syntaxTree.Text,
                        ToLspSeverity(d.Severity)
                    )
                )
            }
            // ADR-0169: run the project's G# analyzers in this (debounced,
            // bind-inclusive) phase, budgeted per analyzer so a slow analyzer
            // is disabled (GS9302) instead of holding up interactive
            // diagnostics. Location-less host diagnostics (e.g. GS9301 load
            // failures) surface on every open document of the project.
            if useProject && project != nil {
                let analyzers = project.GetGsAnalyzers(out var analyzerLoadDiagnostics)
                if analyzers.Length > 0 || analyzerLoadDiagnostics.Length > 0 {
                    let produced = GSharpAnalyzerDriver.Run(
                        compilation,
                        analyzers,
                        AnalyzerOptions{TimeBudgetMilliseconds: AnalyzerTimeBudgetMilliseconds}
                    )
                    for d in analyzerLoadDiagnostics.Concat(produced) {
                        if d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Hidden {
                            continue
                        }
                        if d.Location.Text != nil && d.Location.Text != syntaxTree.Text {
                            continue
                        }
                        diagnostics.Add(
                            BuildDiagnostic(
                                d.Id,
                                d.Message,
                                d.Location.Span.Start,
                                d.Location.Span.End,
                                syntaxTree.Text,
                                ToLspSeverity(d.Severity)
                            )
                        )
                    }
                }
            }
        }
        return DiagnosticComputationResult(DocumentContent(syntaxTree, newLines, project, workspace), diagnostics)
    }

    private func BuildDiagnostic(code string, message string, start int32, end int32, sourceText SourceText) GSharp
        .LanguageServer
        .Protocol
        .Diagnostic {
        return BuildDiagnostic(
            code,
            message,
            start,
            end,
            sourceText,
            GSharp.LanguageServer.Protocol.DiagnosticSeverity.Error
        )
    }

    private func BuildDiagnostic(
        code string,
        message string,
        start int32,
        end int32,
        sourceText SourceText,
        severity GSharp.LanguageServer.Protocol.DiagnosticSeverity
    ) GSharp
        .LanguageServer
        .Protocol
        .Diagnostic {
        return GSharp
            .LanguageServer
            .Protocol
            .Diagnostic{
            Code: DiagnosticCode(code),
            Message: message,
            Range: Range(ToPosition(start, sourceText), ToPosition(end, sourceText)),
            Severity: severity,
            Source: Constants.LanguageIdentifier
        }
    }

    private func ToLspSeverity(severity GSharp.Core.CodeAnalysis.DiagnosticSeverity) GSharp
        .LanguageServer
        .Protocol
        .DiagnosticSeverity {
        return switch severity {
            case GSharp
                .Core
                .CodeAnalysis
                .DiagnosticSeverity
                .Error: GSharp
                .LanguageServer
                .Protocol
                .DiagnosticSeverity
                .Error
            case GSharp
                .Core
                .CodeAnalysis
                .DiagnosticSeverity
                .Warning: GSharp
                .LanguageServer
                .Protocol
                .DiagnosticSeverity
                .Warning
            default: GSharp.LanguageServer.Protocol.DiagnosticSeverity.Information
        }
    }

    private func ToPosition(offset int32, sourceText SourceText) Position {
        let line = sourceText.GetLineIndex(offset)
        let lineStart = sourceText.Lines[line].Start
        return Position(line, offset - lineStart)
    }
}

class DiagnosticComputationResult {
    init(content DocumentContent, diagnostics IReadOnlyList[GSharp.LanguageServer.Protocol.Diagnostic]) {
        this.Content = content
        this.Diagnostics = diagnostics
    }

    prop Content DocumentContent {
        get;
    }

    prop Diagnostics IReadOnlyList[GSharp.LanguageServer.Protocol.Diagnostic] {
        get;
    }
}
