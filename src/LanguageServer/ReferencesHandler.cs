// <copyright file="ReferencesHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;
using OmniSharp.Extensions.LanguageServer.Protocol.Client.Capabilities;
using OmniSharp.Extensions.LanguageServer.Protocol.Document;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;
using OmniSharp.Extensions.LanguageServer.Protocol.Window;

namespace GSharp.LanguageServer;

/// <summary>
/// Find-references handler for GSharp symbols.
/// </summary>
public class ReferencesHandler : ReferencesHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="ReferencesHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public ReferencesHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<LocationContainer> Handle(ReferenceParams request, CancellationToken cancellationToken)
    {
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult(new LocationContainer());
        }

        var locations = ReferencesComputer.ComputeReferences(request.TextDocument.Uri, content, request.Position, request.Context.IncludeDeclaration);
        return Task.FromResult(new LocationContainer(locations));
    }

    /// <inheritdoc/>
    protected override ReferenceRegistrationOptions CreateRegistrationOptions(ReferenceCapability capability, ClientCapabilities clientCapabilities)
    {
        return new ReferenceRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
        };
    }
}
