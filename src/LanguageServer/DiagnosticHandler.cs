// <copyright file="DiagnosticHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using OmniSharp.Extensions.LanguageServer.Protocol.Client.Capabilities;
using OmniSharp.Extensions.LanguageServer.Protocol.Document;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;
using OmniSharp.Extensions.LanguageServer.Protocol.Window;

namespace GSharp.LanguageServer;

/// <summary>
/// Pull-model diagnostic handler — clients request diagnostics rather than server pushing.
/// </summary>
public class DiagnosticHandler : DocumentDiagnosticHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="DiagnosticHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public DiagnosticHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<RelatedDocumentDiagnosticReport> Handle(DocumentDiagnosticParams request, CancellationToken cancellationToken)
    {
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult<RelatedDocumentDiagnosticReport>(new RelatedFullDocumentDiagnosticReport
            {
                Items = new Container<Diagnostic>(),
            });
        }

        var sourceText = content.SyntaxTree.Text.ToString();
        var project = content.Project;
        var result = DocumentSyncHandler.ComputeDiagnostics(sourceText, skipBinding: false, project);

        return Task.FromResult<RelatedDocumentDiagnosticReport>(new RelatedFullDocumentDiagnosticReport
        {
            Items = new Container<Diagnostic>(result.Diagnostics),
        });
    }

    /// <inheritdoc/>
    protected override DiagnosticsRegistrationOptions CreateRegistrationOptions(DiagnosticClientCapabilities capability, ClientCapabilities clientCapabilities)
    {
        return new DiagnosticsRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
            Identifier = "gsharp",
            InterFileDependencies = false,
            WorkspaceDiagnostics = false,
        };
    }
}
