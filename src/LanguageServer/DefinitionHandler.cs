// <copyright file="DefinitionHandler.cs" company="GSharp">
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
/// Go-to-definition handler for GSharp symbols.
/// </summary>
public class DefinitionHandler : DeclarationHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="DefinitionHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public DefinitionHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<LocationOrLocationLinks> Handle(DeclarationParams request, CancellationToken cancellationToken)
    {
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult(new LocationOrLocationLinks());
        }

        var location = DefinitionComputer.ComputeDefinition(request.TextDocument.Uri, content, request.Position);
        if (location == null)
        {
            return Task.FromResult(new LocationOrLocationLinks());
        }

        return Task.FromResult(new LocationOrLocationLinks(location));
    }

    /// <inheritdoc/>
    protected override DeclarationRegistrationOptions CreateRegistrationOptions(DeclarationCapability capability, ClientCapabilities clientCapabilities)
    {
        return new DeclarationRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
        };
    }
}
