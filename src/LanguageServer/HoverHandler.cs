// <copyright file="HoverHandler.cs" company="GSharp">
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
/// Hover handler for GSharp symbols.
/// </summary>
public class HoverHandler : HoverHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="HoverHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public HoverHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<Hover> Handle(HoverParams request, CancellationToken cancellationToken)
    {
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult<Hover>(null);
        }

        return Task.FromResult(HoverComputer.ComputeHover(content, request.Position));
    }

    /// <inheritdoc/>
    protected override HoverRegistrationOptions CreateRegistrationOptions(HoverCapability capability, ClientCapabilities clientCapabilities)
    {
        return new HoverRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
        };
    }
}
