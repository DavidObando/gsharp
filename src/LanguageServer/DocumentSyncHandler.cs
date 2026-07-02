// <copyright file="DocumentSyncHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;
using Range = GSharp.LanguageServer.Protocol.Range;

namespace GSharp.LanguageServer;

/// <summary>
/// GSharp diagnostics computation used by document synchronization.
/// </summary>
public static class DocumentSyncHandler
{
    public static DiagnosticComputationResult ComputeDiagnostics(string text, bool skipBinding)
    {
        return ComputeDiagnostics(text, skipBinding, project: null, filePath: null, workspace: null);
    }

    public static DiagnosticComputationResult ComputeDiagnostics(string text, bool skipBinding, ProjectState project)
    {
        return ComputeDiagnostics(text, skipBinding, project, filePath: null, workspace: null);
    }

    public static DiagnosticComputationResult ComputeDiagnostics(string text, bool skipBinding, ProjectState project, string filePath)
    {
        return ComputeDiagnostics(text, skipBinding, project, filePath, workspace: null);
    }

    public static DiagnosticComputationResult ComputeDiagnostics(string text, bool skipBinding, ProjectState project, string filePath, WorkspaceState workspace)
    {
        // Mutating path: only safe to call while holding the write gate (didOpen/didChange/
        // didSave). UpdateFile overwrites the project's shared per-file SyntaxTree with no lock
        // of its own; calling it off-gate lets a stale snapshot clobber a newer concurrently
        // written tree (issue #1657). Non-mutating requests must use
        // <see cref="ComputeDiagnosticsForSnapshot"/> instead.
        Compilation compilation;
        SyntaxTree syntaxTree;
        bool useProject = project != null && !string.IsNullOrEmpty(filePath) && project.ContainsFile(filePath);
        if (useProject)
        {
            syntaxTree = project.UpdateFile(filePath, text);
            compilation = project.GetCompilation();
        }
        else
        {
            syntaxTree = SyntaxTree.Parse(text);
            compilation = new Compilation(syntaxTree);
        }

        return BuildResult(syntaxTree, compilation, useProject, skipBinding, project, workspace);
    }

    /// <summary>
    /// Read-only counterpart to <see cref="ComputeDiagnostics(string, bool, ProjectState, string, WorkspaceState)"/>
    /// for non-mutating requests (e.g. the textDocument/diagnostic pull handler) that run off the
    /// write gate. Binds against the caller-supplied <paramref name="syntaxTree"/> snapshot
    /// exactly as-is: it never calls <see cref="ProjectState.UpdateFile"/> and never mutates
    /// <paramref name="project"/>'s cached trees or compilation, so a diagnostics pull for a
    /// stale snapshot can never overwrite a newer tree written by a concurrent didChange
    /// (issue #1657). The returned diagnostics always reflect exactly the requested snapshot text.
    /// </summary>
    /// <param name="syntaxTree">The already-parsed snapshot tree to bind and report diagnostics for.</param>
    /// <param name="skipBinding">When <see langword="true"/>, skips the (potentially expensive) binding pass and reports only syntax diagnostics.</param>
    /// <param name="project">The project owning <paramref name="filePath"/>, or <see langword="null"/> if the file is not part of a project.</param>
    /// <param name="filePath">Absolute path to the <c>.gs</c> file the snapshot belongs to.</param>
    /// <param name="workspace">The current workspace state, used to resolve cross-file symbols during binding.</param>
    /// <returns>The computed diagnostics and binding metadata for <paramref name="syntaxTree"/>.</returns>
    public static DiagnosticComputationResult ComputeDiagnosticsForSnapshot(SyntaxTree syntaxTree, bool skipBinding, ProjectState project, string filePath, WorkspaceState workspace)
    {
        bool useProject = project != null && !string.IsNullOrEmpty(filePath) && project.ContainsFile(filePath);
        Compilation compilation = useProject
            ? project.GetCompilationForSnapshot(filePath, syntaxTree)
            : new Compilation(syntaxTree);

        return BuildResult(syntaxTree, compilation, useProject, skipBinding, project, workspace);
    }

    private static DiagnosticComputationResult BuildResult(SyntaxTree syntaxTree, Compilation compilation, bool useProject, bool skipBinding, ProjectState project, WorkspaceState workspace)
    {
        var text = syntaxTree.Text.ToString();
        var newLines = new List<int>();
        int nextNewLine = text.IndexOf('\n');
        while (nextNewLine >= 0)
        {
            newLines.Add(nextNewLine);
            nextNewLine = text.IndexOf('\n', nextNewLine + 1);
        }

        var diagnostics = new List<Diagnostic>();

        foreach (var d in syntaxTree.Diagnostics)
        {
            diagnostics.Add(BuildDiagnostic("Syntax", d.Message, d.Location.Span.Start, d.Location.Span.End, syntaxTree.Text));
        }

        foreach (var d in compilation.GlobalScope.Diagnostics)
        {
            // Only report diagnostics that originate from this file's syntax tree.
            if (useProject && d.Location.Text != syntaxTree.Text)
            {
                continue;
            }

            diagnostics.Add(BuildDiagnostic("Semantic", d.Message, d.Location.Span.Start, d.Location.Span.End, syntaxTree.Text));
        }

        if (!skipBinding)
        {
            var program = compilation.BoundProgram;
            foreach (var d in program.Diagnostics)
            {
                if (useProject && d.Location.Text != syntaxTree.Text)
                {
                    continue;
                }

                diagnostics.Add(BuildDiagnostic("Binding", d.Message, d.Location.Span.Start, d.Location.Span.End, syntaxTree.Text));
            }

            // Documentation validation (warnings only — these don't block compilation).
            var docDiagnostics = new Core.CodeAnalysis.DiagnosticBag();
            DocumentationValidator.Validate(
                useProject ? compilation.SyntaxTrees : ImmutableArray.Create(syntaxTree),
                program.Functions.Keys.ToImmutableArray(),
                program.Structs,
                docDiagnostics,
                warnOnMissingDocs: false);

            foreach (var d in docDiagnostics)
            {
                if (useProject && d.Location.Text != syntaxTree.Text)
                {
                    continue;
                }

                diagnostics.Add(BuildDiagnostic(d.Id, d.Message, d.Location.Span.Start, d.Location.Span.End, syntaxTree.Text, ToLspSeverity(d.Severity)));
            }
        }

        return new DiagnosticComputationResult(new DocumentContent(syntaxTree, newLines, project, workspace), diagnostics);
    }

    private static Diagnostic BuildDiagnostic(string code, string message, int start, int end, GSharp.Core.CodeAnalysis.Text.SourceText sourceText)
    {
        return BuildDiagnostic(code, message, start, end, sourceText, DiagnosticSeverity.Error);
    }

    private static Diagnostic BuildDiagnostic(string code, string message, int start, int end, GSharp.Core.CodeAnalysis.Text.SourceText sourceText, DiagnosticSeverity severity)
    {
        return new Diagnostic
        {
            Code = new DiagnosticCode(code),
            Message = message,
            Range = new Range(ToPosition(start, sourceText), ToPosition(end, sourceText)),
            Severity = severity,
            Source = Constants.LanguageIdentifier,
        };
    }

    private static DiagnosticSeverity ToLspSeverity(Core.CodeAnalysis.DiagnosticSeverity severity)
    {
        return severity switch
        {
            Core.CodeAnalysis.DiagnosticSeverity.Error => DiagnosticSeverity.Error,
            Core.CodeAnalysis.DiagnosticSeverity.Warning => DiagnosticSeverity.Warning,
            _ => DiagnosticSeverity.Information,
        };
    }

    private static Position ToPosition(int offset, GSharp.Core.CodeAnalysis.Text.SourceText sourceText)
    {
        int line = sourceText.GetLineIndex(offset);
        int lineStart = sourceText.Lines[line].Start;
        return new Position(line, offset - lineStart);
    }
}

public sealed class DiagnosticComputationResult
{
    public DiagnosticComputationResult(DocumentContent content, IReadOnlyList<Diagnostic> diagnostics)
    {
        this.Content = content;
        this.Diagnostics = diagnostics;
    }

    public DocumentContent Content { get; }

    public IReadOnlyList<Diagnostic> Diagnostics { get; }
}
