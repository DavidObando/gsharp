// <copyright file="DocumentValidationHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.LSP
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;
    using GSharp.Core.CodeAnalysis.Syntax;
    using OmniSharp.Extensions.Embedded.MediatR;
    using OmniSharp.Extensions.LanguageServer.Protocol;
    using OmniSharp.Extensions.LanguageServer.Protocol.Client.Capabilities;
    using OmniSharp.Extensions.LanguageServer.Protocol.Models;
    using OmniSharp.Extensions.LanguageServer.Protocol.Server;
    using OmniSharp.Extensions.LanguageServer.Protocol.Server.Capabilities;

    /// <summary>
    /// GSharp validation handler.
    /// </summary>
    internal class DocumentValidationHandler : ITextDocumentSyncHandler
    {
        private readonly ILanguageServer router;

        private readonly DocumentSelector documentSelector = new DocumentSelector(
            new DocumentFilter()
            {
                Pattern = "**/*.gs",
            });

        private SynchronizationCapability capability;

        /// <summary>
        /// Initializes a new instance of the <see cref="DocumentValidationHandler"/> class.
        /// </summary>
        /// <param name="router"><see cref="ILanguageServer"/> for LSP.</param>
        public DocumentValidationHandler(ILanguageServer router)
        {
            this.router = router;
        }

        /// <summary>
        /// Gets the Type of Change subscribed for.
        /// </summary>
        public TextDocumentSyncKind Change { get; } = TextDocumentSyncKind.Full;

        /// <inheritdoc/>
        public TextDocumentChangeRegistrationOptions GetRegistrationOptions()
        {
            return new TextDocumentChangeRegistrationOptions()
            {
                DocumentSelector = documentSelector,
                SyncKind = Change,
            };
        }

        /// <inheritdoc/>
        public TextDocumentAttributes GetTextDocumentAttributes(Uri uri)
        {
            return new TextDocumentAttributes(uri, "plaintext");
        }

        /// <summary>
        /// Evaluates.
        /// </summary>
        /// <param name="request">The client request.</param>
        /// <param name="cancellationToken">A cancellation token.</param>
        /// <returns>A list of diagnostics to the client.</returns>
        public Task<Unit> Handle(DidChangeTextDocumentParams request, CancellationToken cancellationToken)
        {
            string text = request.ContentChanges?.FirstOrDefault()?.Text;

            if (string.IsNullOrEmpty(text))
            {
                return Unit.Task;
            }

            this.DiagnoseText(request.TextDocument.Uri, text);
            return Unit.Task;
        }

        /// <inheritdoc/>
        public Task<Unit> Handle(DidOpenTextDocumentParams request, CancellationToken cancellationToken)
        {
            string text = request.TextDocument?.Text;

            if (string.IsNullOrEmpty(text))
            {
                return Unit.Task;
            }

            this.DiagnoseText(request.TextDocument.Uri, text);
            return Unit.Task;
        }

        /// <inheritdoc/>
        public Task<Unit> Handle(DidCloseTextDocumentParams request, CancellationToken cancellationToken)
        {
            return Unit.Task;
        }

        /// <inheritdoc/>
        public Task<Unit> Handle(DidSaveTextDocumentParams request, CancellationToken cancellationToken)
        {
            return Unit.Task;
        }

        /// <inheritdoc/>
        public void SetCapability(SynchronizationCapability capability)
        {
            this.capability = capability;
        }

        /// <inheritdoc/>
        TextDocumentRegistrationOptions IRegistration<TextDocumentRegistrationOptions>.GetRegistrationOptions()
        {
            return new TextDocumentRegistrationOptions()
            {
                DocumentSelector = documentSelector,
            };
        }

        /// <inheritdoc/>
        TextDocumentSaveRegistrationOptions IRegistration<TextDocumentSaveRegistrationOptions>.GetRegistrationOptions()
        {
            return new TextDocumentSaveRegistrationOptions()
            {
                DocumentSelector = documentSelector,
                IncludeText = true,
            };
        }

        private void DiagnoseText(Uri documentUri, string text)
        {
            var newLines = new List<int>();
            int nextNewLine = text.IndexOf(Environment.NewLine);
            while (nextNewLine >= 0)
            {
                newLines.Add(nextNewLine);
                nextNewLine = text.IndexOf(Environment.NewLine, nextNewLine + 1);
            }

            var diagnostics = new List<Diagnostic>();

            var syntaxTree = SyntaxTree.Parse(text);
            foreach (var syntaxTreeDiagnostics in syntaxTree.Diagnostics)
            {
                int line = newLines.Count(charNumber => charNumber < syntaxTreeDiagnostics.Span.Start);
                int lineStart = line > 0 ? newLines[line - 1] + 2 : 0;
                diagnostics.Add(new Diagnostic()
                {
                    Code = new DiagnosticCode("syntax"),
                    Message = syntaxTreeDiagnostics.Message,
                    Range = new Range(new Position(line, syntaxTreeDiagnostics.Span.Start - lineStart), new Position(line, syntaxTreeDiagnostics.Span.End - lineStart)),
                    Severity = DiagnosticSeverity.Error,
                    Source = "gsharp",
                });
            }

            var compilation = new Core.CodeAnalysis.Compilation(syntaxTree);
            foreach (var syntaxTreeDiagnostics in compilation.GlobalScope.Diagnostics)
            {
                int line = newLines.Count(charNumber => charNumber < syntaxTreeDiagnostics.Span.Start);
                int lineStart = line > 0 ? newLines[line - 1] + 2 : 0;
                diagnostics.Add(new Diagnostic()
                {
                    Code = new DiagnosticCode("compilation"),
                    Message = syntaxTreeDiagnostics.Message,
                    Range = new Range(new Position(line, syntaxTreeDiagnostics.Span.Start - lineStart), new Position(line, syntaxTreeDiagnostics.Span.End - lineStart)),
                    Severity = DiagnosticSeverity.Error,
                    Source = "gsharp",
                });
            }

            if (diagnostics.Count > 0)
            {
                this.router.Client.SendNotification(DocumentNames.PublishDiagnostics, new PublishDiagnosticsParams
                {
                    Uri = documentUri,
                    Diagnostics = diagnostics,
                });
            }
        }
    }
}
