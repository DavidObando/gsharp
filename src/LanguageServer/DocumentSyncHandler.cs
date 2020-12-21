// <copyright file="DocumentSyncHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.LanguageServer
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;
    using GSharp.Core.CodeAnalysis.Binding;
    using GSharp.Core.CodeAnalysis.Compilation;
    using GSharp.Core.CodeAnalysis.Syntax;
    using OmniSharp.Extensions.Embedded.MediatR;
    using OmniSharp.Extensions.LanguageServer.Protocol;
    using OmniSharp.Extensions.LanguageServer.Protocol.Client.Capabilities;
    using OmniSharp.Extensions.LanguageServer.Protocol.Models;
    using OmniSharp.Extensions.LanguageServer.Protocol.Server;
    using OmniSharp.Extensions.LanguageServer.Protocol.Server.Capabilities;
    using Range = OmniSharp.Extensions.LanguageServer.Protocol.Models.Range;

    /// <summary>
    /// GSharp validation handler.
    /// </summary>
    public class DocumentSyncHandler : ITextDocumentSyncHandler
    {
        private readonly ILanguageServer router;
        private readonly DocumentContentService documentContentService;
        private SynchronizationCapability capability;

        /// <summary>
        /// Initializes a new instance of the <see cref="DocumentSyncHandler"/> class.
        /// </summary>
        /// <param name="router"><see cref="ILanguageServer"/> for LSP.</param>
        /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
        public DocumentSyncHandler(ILanguageServer router, DocumentContentService documentContentService)
        {
            this.router = router;
            this.documentContentService = documentContentService;
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
                DocumentSelector = Constants.DocumentSelector,
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
            this.documentContentService.TryRemove(request.TextDocument.Uri.ToString());
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
                DocumentSelector = Constants.DocumentSelector,
            };
        }

        /// <inheritdoc/>
        TextDocumentSaveRegistrationOptions IRegistration<TextDocumentSaveRegistrationOptions>.GetRegistrationOptions()
        {
            return new TextDocumentSaveRegistrationOptions()
            {
                DocumentSelector = Constants.DocumentSelector,
                IncludeText = true,
            };
        }

        private void DiagnoseText(Uri documentUri, string text, bool skipBinding = true)
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
            this.documentContentService.AddOrUpdate(documentUri.ToString(), new DocumentContent(syntaxTree, newLines));
            foreach (var syntaxTreeDiagnostics in syntaxTree.Diagnostics)
            {
                int line = newLines.Count(charNumber => charNumber < syntaxTreeDiagnostics.Location.Span.Start);
                int lineStart = line > 0 ? newLines[line - 1] + 2 : 0;
                diagnostics.Add(new Diagnostic()
                {
                    Code = new DiagnosticCode("Syntax"),
                    Message = syntaxTreeDiagnostics.Message,
                    Range = new Range(new Position(line, syntaxTreeDiagnostics.Location.Span.Start - lineStart), new Position(line, syntaxTreeDiagnostics.Location.Span.End - lineStart)),
                    Severity = DiagnosticSeverity.Error,
                    Source = Constants.LanguageIdentifier,
                });
            }

            var compilation = new Compilation(syntaxTree);
            foreach (var syntaxTreeDiagnostics in compilation.GlobalScope.Diagnostics)
            {
                int line = newLines.Count(charNumber => charNumber < syntaxTreeDiagnostics.Location.Span.Start);
                int lineStart = line > 0 ? newLines[line - 1] + 2 : 0;
                diagnostics.Add(new Diagnostic()
                {
                    Code = new DiagnosticCode("Semantic"),
                    Message = syntaxTreeDiagnostics.Message,
                    Range = new Range(new Position(line, syntaxTreeDiagnostics.Location.Span.Start - lineStart), new Position(line, syntaxTreeDiagnostics.Location.Span.End - lineStart)),
                    Severity = DiagnosticSeverity.Error,
                    Source = Constants.LanguageIdentifier,
                });
            }

            if (!skipBinding)
            {
                var program = Binder.BindProgram(compilation.GlobalScope);
                foreach (var bindingDiagnostics in program.Diagnostics)
                {
                    int line = newLines.Count(charNumber => charNumber < bindingDiagnostics.Location.Span.Start);
                    int lineStart = line > 0 ? newLines[line - 1] + 2 : 0;
                    diagnostics.Add(new Diagnostic()
                    {
                        Code = new DiagnosticCode("Binding"),
                        Message = bindingDiagnostics.Message,
                        Range = new Range(new Position(line, bindingDiagnostics.Location.Span.Start - lineStart), new Position(line, bindingDiagnostics.Location.Span.End - lineStart)),
                        Severity = DiagnosticSeverity.Error,
                        Source = Constants.LanguageIdentifier,
                    });
                }
            }

            this.router.Client.SendNotification(DocumentNames.PublishDiagnostics, new PublishDiagnosticsParams
            {
                Uri = documentUri,
                Diagnostics = diagnostics,
            });
        }
    }
}
