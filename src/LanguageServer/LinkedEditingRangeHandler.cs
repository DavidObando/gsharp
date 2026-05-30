// <copyright file="LinkedEditingRangeHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using OmniSharp.Extensions.LanguageServer.Protocol.Client.Capabilities;
using OmniSharp.Extensions.LanguageServer.Protocol.Document;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;
using OmniSharp.Extensions.LanguageServer.Protocol.Window;

namespace GSharp.LanguageServer;

/// <summary>
/// Linked editing range handler — identifies all occurrences of a symbol that should
/// be renamed together when any one of them is edited.
/// </summary>
public class LinkedEditingRangeHandler : LinkedEditingRangeHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="LinkedEditingRangeHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public LinkedEditingRangeHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<LinkedEditingRanges> Handle(LinkedEditingRangeParams request, CancellationToken cancellationToken)
    {
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult<LinkedEditingRanges>(null);
        }

        var tree = content.SyntaxTree;
        var offset = SemanticLookup.ToOffset(content, request.Position);
        var token = SemanticLookup.FindTokenAt(tree, offset);

        if (token == null || token.Kind != SyntaxKind.IdentifierToken)
        {
            return Task.FromResult<LinkedEditingRanges>(null);
        }

        Compilation compilation;
        try
        {
            compilation = content.Project?.GetCompilation()
                ?? new Compilation(content.SyntaxTree);
        }
        catch
        {
            return Task.FromResult<LinkedEditingRanges>(null);
        }

        var symbol = SemanticLookup.ResolveSymbol(compilation, token);
        if (!SemanticLookup.CanRename(symbol))
        {
            return Task.FromResult<LinkedEditingRanges>(null);
        }

        var references = SemanticLookup.FindReferences(compilation, symbol).ToList();
        if (references.Count == 0)
        {
            return Task.FromResult<LinkedEditingRanges>(null);
        }

        var ranges = new List<OmniSharp.Extensions.LanguageServer.Protocol.Models.Range>();
        foreach (var refToken in references)
        {
            ranges.Add(SemanticLookup.ToRange(refToken));
        }

        return Task.FromResult<LinkedEditingRanges>(new LinkedEditingRanges
        {
            Ranges = new Container<OmniSharp.Extensions.LanguageServer.Protocol.Models.Range>(ranges),
            WordPattern = @"[a-zA-Z_]\w*",
        });
    }

    /// <inheritdoc/>
    protected override LinkedEditingRangeRegistrationOptions CreateRegistrationOptions(LinkedEditingRangeClientCapabilities capability, ClientCapabilities clientCapabilities)
    {
        return new LinkedEditingRangeRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
        };
    }
}
