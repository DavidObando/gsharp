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
using Range = OmniSharp.Extensions.LanguageServer.Protocol.Models.Range;

namespace GSharp.LanguageServer;

/// <summary>
/// GSharp validation handler.
/// </summary>
public class DocumentSyncHandler : TextDocumentSyncHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="DocumentSyncHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public DocumentSyncHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override TextDocumentAttributes GetTextDocumentAttributes(DocumentUri uri)
    {
        return new TextDocumentAttributes(uri, "plaintext");
    }

    /// <inheritdoc/>
    public override Task<Unit> Handle(DidOpenTextDocumentParams request, CancellationToken cancellationToken)
    {
        string text = request.TextDocument?.Text;
        if (!string.IsNullOrEmpty(text))
        {
            this.DiagnoseText(request.TextDocument!.Uri, text);
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
        return Unit.Task;
    }

    /// <inheritdoc/>
    public override Task<Unit> Handle(DidCloseTextDocumentParams request, CancellationToken cancellationToken)
    {
        this.documentContentService.TryRemove(request.TextDocument.Uri.ToString());
        return Unit.Task;
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
        var newLines = new List<int>();
        int nextNewLine = text.IndexOf(Environment.NewLine, StringComparison.Ordinal);
        while (nextNewLine >= 0)
        {
            newLines.Add(nextNewLine);
            nextNewLine = text.IndexOf(Environment.NewLine, nextNewLine + 1, StringComparison.Ordinal);
        }

        var diagnostics = new List<Diagnostic>();

        var syntaxTree = SyntaxTree.Parse(text);
        this.documentContentService.AddOrUpdate(documentUri.ToString(), new DocumentContent(syntaxTree, newLines));
        foreach (var d in syntaxTree.Diagnostics)
        {
            diagnostics.Add(BuildDiagnostic("Syntax", d.Message, d.Location.Span.Start, d.Location.Span.End, newLines));
        }

        var compilation = new Compilation(syntaxTree);
        foreach (var d in compilation.GlobalScope.Diagnostics)
        {
            diagnostics.Add(BuildDiagnostic("Semantic", d.Message, d.Location.Span.Start, d.Location.Span.End, newLines));
        }

        if (!skipBinding)
        {
            var program = Binder.BindProgram(compilation.GlobalScope);
            foreach (var d in program.Diagnostics)
            {
                diagnostics.Add(BuildDiagnostic("Binding", d.Message, d.Location.Span.Start, d.Location.Span.End, newLines));
            }
        }

        this.router.TextDocument.PublishDiagnostics(new PublishDiagnosticsParams
        {
            Uri = documentUri,
            Diagnostics = diagnostics,
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
