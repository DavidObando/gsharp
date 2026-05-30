// <copyright file="DocumentSyncHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using MediatR;
using OmniSharp.Extensions.LanguageServer.Protocol;
using OmniSharp.Extensions.LanguageServer.Protocol.Client.Capabilities;
using OmniSharp.Extensions.LanguageServer.Protocol.Document;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;
using OmniSharp.Extensions.LanguageServer.Protocol.Server.Capabilities;
using OmniSharp.Extensions.LanguageServer.Protocol.Window;
using Range = OmniSharp.Extensions.LanguageServer.Protocol.Models.Range;

namespace GSharp.LanguageServer;

/// <summary>
/// GSharp validation handler.
/// </summary>
public class DocumentSyncHandler : TextDocumentSyncHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;
    private readonly WorkspaceState workspaceState;

    /// <summary>
    /// Initializes a new instance of the <see cref="DocumentSyncHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    /// <param name="workspaceState"><see cref="WorkspaceState"/> instance.</param>
    public DocumentSyncHandler(ILanguageServerFacade router, DocumentContentService documentContentService, WorkspaceState workspaceState)
    {
        this.router = router;
        this.documentContentService = documentContentService;
        this.workspaceState = workspaceState;
    }

    /// <inheritdoc/>
    public override TextDocumentAttributes GetTextDocumentAttributes(DocumentUri uri)
    {
        return new TextDocumentAttributes(uri, "gsharp");
    }

    /// <inheritdoc/>
    public override Task<Unit> Handle(DidOpenTextDocumentParams request, CancellationToken cancellationToken)
    {
        try
        {
            string text = request.TextDocument?.Text;
            var uri = request.TextDocument?.Uri;
            if (string.IsNullOrEmpty(text))
            {
                this.router.Window.LogWarning($"DidOpen: empty text for {uri}");
                return Unit.Task;
            }

            this.DiagnoseText(uri!, text);
        }
        catch (Exception ex)
        {
            System.IO.File.AppendAllText(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "gsharp-lsp-debug.log"), $"[DidOpen ERROR] {ex}\n");
        }

        return Unit.Task;
    }

    /// <inheritdoc/>
    public override Task<Unit> Handle(DidChangeTextDocumentParams request, CancellationToken cancellationToken)
    {
        string text = request.ContentChanges?.FirstOrDefault()?.Text;
        if (!string.IsNullOrEmpty(text))
        {
            this.DiagnoseText(request.TextDocument.Uri, text);
        }

        return Unit.Task;
    }

    /// <inheritdoc/>
    public override Task<Unit> Handle(DidSaveTextDocumentParams request, CancellationToken cancellationToken)
    {
        var text = request.Text;
        if (!string.IsNullOrEmpty(text))
        {
            // Open/change keeps binding diagnostics disabled for responsive typing; save runs the full pipeline.
            this.DiagnoseText(request.TextDocument.Uri, text, skipBinding: false);
        }

        return Unit.Task;
    }

    /// <inheritdoc/>
    public override Task<Unit> Handle(DidCloseTextDocumentParams request, CancellationToken cancellationToken)
    {
        this.documentContentService.TryRemove(request.TextDocument.Uri.ToString());
        return Unit.Task;
    }

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

    /// <inheritdoc/>
    protected override TextDocumentSyncRegistrationOptions CreateRegistrationOptions(
        TextSynchronizationCapability capability, ClientCapabilities clientCapabilities)
    {
        return new TextDocumentSyncRegistrationOptions(TextDocumentSyncKind.Full)
        {
            DocumentSelector = Constants.DocumentSelector,
            Save = new BooleanOr<SaveOptions>(new SaveOptions { IncludeText = true }),
        };
    }

    private void DiagnoseText(DocumentUri documentUri, string text, bool skipBinding = true)
    {
        var filePath = documentUri.GetFileSystemPath();
        var project = !string.IsNullOrEmpty(filePath) ? this.workspaceState.GetProjectForFile(filePath) : null;

        // Update the project state with the new text
        if (project != null)
        {
            project.UpdateFile(filePath, text);
        }

        var result = ComputeDiagnostics(text, skipBinding, project);
        this.documentContentService.AddOrUpdate(documentUri.ToString(), result.Content);
        this.router.TextDocument.PublishDiagnostics(new PublishDiagnosticsParams
        {
            Uri = documentUri,
            Diagnostics = new Container<Diagnostic>(result.Diagnostics),
        });
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
        Content = content;
        Diagnostics = diagnostics;
    }

    public DocumentContent Content { get; }

    public IReadOnlyList<Diagnostic> Diagnostics { get; }
}
