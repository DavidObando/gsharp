#nullable disable

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
        var newLines = new List<int>();
        int nextNewLine = text.IndexOf('\n');
        while (nextNewLine >= 0)
        {
            newLines.Add(nextNewLine);
            nextNewLine = text.IndexOf('\n', nextNewLine + 1);
        }

        var diagnostics = new List<Diagnostic>();

        // When the file belongs to a project, bind it as part of the project-level compilation
        // for cross-file awareness, but make sure that compilation reflects the in-memory editor
        // text. The project keeps its own SyntaxTree per file; we sync this file's tree with the
        // current text and then filter diagnostics by that exact tree so squiggles for the edited
        // file are reported (and diagnostics for other files in the project are excluded).
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
