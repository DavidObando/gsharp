// <copyright file="RenameHandler.cs" company="GSharp">
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
/// Rename handler for GSharp symbols.
/// </summary>
public class RenameHandler : RenameHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="RenameHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public RenameHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<WorkspaceEdit> Handle(RenameParams request, CancellationToken cancellationToken)
    {
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult<WorkspaceEdit>(null);
        }

        return Task.FromResult(RenameComputer.ComputeRename(request.TextDocument.Uri, content, request.Position, request.NewName));
    }

    /// <inheritdoc/>
    protected override RenameRegistrationOptions CreateRegistrationOptions(RenameCapability capability, ClientCapabilities clientCapabilities)
    {
        return new RenameRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
            PrepareProvider = false,
        };
    }
}
