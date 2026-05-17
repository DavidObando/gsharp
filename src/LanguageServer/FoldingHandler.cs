// <copyright file="FoldingHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Syntax;
using OmniSharp.Extensions.LanguageServer.Protocol.Client.Capabilities;
using OmniSharp.Extensions.LanguageServer.Protocol.Document;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;
using OmniSharp.Extensions.LanguageServer.Protocol.Window;

namespace GSharp.LanguageServer;

/// <summary>
/// Folding handler for GSharp.
/// </summary>
public class FoldingHandler : FoldingRangeHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="FoldingHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public FoldingHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<Container<FoldingRange>> Handle(FoldingRangeRequestParam request, CancellationToken cancellationToken)
    {
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult(new Container<FoldingRange>());
        }

        var foldings = FoldingComputer.ComputeFoldings(content).ToList();
        return Task.FromResult(new Container<FoldingRange>(foldings));
    }

    /// <inheritdoc/>
    protected override FoldingRangeRegistrationOptions CreateRegistrationOptions(
        FoldingRangeCapability capability, ClientCapabilities clientCapabilities)
    {
        return new FoldingRangeRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
        };
    }
}

/// <summary>
/// Pure-function folding range computer that the language server and tests can both use
/// without needing an LSP transport.
/// </summary>
internal static class FoldingComputer
{
    public static IEnumerable<FoldingRange> ComputeFoldings(DocumentContent content)
    {
        // TODO: Functions are only at the root for the moment
        foreach (FunctionDeclarationSyntax function in content.SyntaxTree.Root.Members.OfType<FunctionDeclarationSyntax>())
        {
            int startLine = content.Lines.Count(charNumber => charNumber < function.Body.Span.Start);
            int endLine = content.Lines.Count(charNumber => charNumber < function.Body.Span.End);
            yield return new FoldingRange
            {
                StartLine = startLine,
                EndLine = endLine,
                Kind = FoldingRangeKind.Region,
                EndCharacter = 0,
                StartCharacter = 0,
            };
        }
    }
}
