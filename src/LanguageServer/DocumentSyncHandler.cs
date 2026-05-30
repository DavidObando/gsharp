// <copyright file="DocumentSyncHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;
using Range = GSharp.LanguageServer.Protocol.Range;

namespace GSharp.LanguageServer;

/// <summary>
/// GSharp diagnostics computation used by document synchronization.
/// </summary>
public static class DocumentSyncHandler
{
    internal static DiagnosticComputationResult ComputeDiagnostics(string text, bool skipBinding)
    {
        return ComputeDiagnostics(text, skipBinding, project: null);
    }

    internal static DiagnosticComputationResult ComputeDiagnostics(string text, bool skipBinding, ProjectState project)
    {
        var newLines = new List<int>();
        int nextNewLine = text.IndexOf(Environment.NewLine, StringComparison.Ordinal);
        while (nextNewLine >= 0)
        {
            newLines.Add(nextNewLine);
            nextNewLine = text.IndexOf(Environment.NewLine, nextNewLine + 1, StringComparison.Ordinal);
        }

        var diagnostics = new List<Diagnostic>();

        var syntaxTree = SyntaxTree.Parse(text);
        foreach (var d in syntaxTree.Diagnostics)
        {
            diagnostics.Add(BuildDiagnostic("Syntax", d.Message, d.Location.Span.Start, d.Location.Span.End, newLines));
        }

        // Use project-level compilation if available for cross-file awareness
        var compilation = project != null ? project.GetCompilation() : new Compilation(syntaxTree);
        foreach (var d in compilation.GlobalScope.Diagnostics)
        {
            // Only report diagnostics that originate from this file's syntax tree
            if (project != null && d.Location.Text != syntaxTree.Text)
            {
                continue;
            }

            diagnostics.Add(BuildDiagnostic("Semantic", d.Message, d.Location.Span.Start, d.Location.Span.End, newLines));
        }

        if (!skipBinding)
        {
            var program = Binder.BindProgram(compilation.GlobalScope);
            foreach (var d in program.Diagnostics)
            {
                if (project != null && d.Location.Text != syntaxTree.Text)
                {
                    continue;
                }

                diagnostics.Add(BuildDiagnostic("Binding", d.Message, d.Location.Span.Start, d.Location.Span.End, newLines));
            }
        }

        return new DiagnosticComputationResult(new DocumentContent(syntaxTree, newLines, project), diagnostics);
    }

    private static Diagnostic BuildDiagnostic(string code, string message, int start, int end, List<int> newLines)
    {
        int line = newLines.Count(charNumber => charNumber < start);
        int lineStart = line > 0 ? newLines[line - 1] + 2 : 0;
        return new Diagnostic
        {
            Code = new DiagnosticCode(code),
            Message = message,
            Range = new Range(new Position(line, start - lineStart), new Position(line, end - lineStart)),
            Severity = DiagnosticSeverity.Error,
            Source = Constants.LanguageIdentifier,
        };
    }
}

internal sealed class DiagnosticComputationResult
{
    public DiagnosticComputationResult(DocumentContent content, IReadOnlyList<Diagnostic> diagnostics)
    {
        this.Content = content;
        this.Diagnostics = diagnostics;
    }

    public DocumentContent Content { get; }

    public IReadOnlyList<Diagnostic> Diagnostics { get; }
}
