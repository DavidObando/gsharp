// <copyright file="CodeActionHandler.cs" company="GSharp">
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
/// Code-action handler for GSharp refactorings.
/// </summary>
public class CodeActionHandler : CodeActionHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="CodeActionHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public CodeActionHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<CommandOrCodeActionContainer> Handle(CodeActionParams request, CancellationToken cancellationToken)
    {
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult(new CommandOrCodeActionContainer());
        }

        return Task.FromResult(CodeActionComputer.ComputeCodeActions(request.TextDocument.Uri, content, request.Range));
    }

    /// <inheritdoc/>
    public override Task<CodeAction> Handle(CodeAction request, CancellationToken cancellationToken)
    {
        return Task.FromResult(request);
    }

    /// <inheritdoc/>
    protected override CodeActionRegistrationOptions CreateRegistrationOptions(CodeActionCapability capability, ClientCapabilities clientCapabilities)
    {
        return new CodeActionRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
            CodeActionKinds = new Container<CodeActionKind>(CodeActionKind.RefactorRewrite),
        };
    }
}
