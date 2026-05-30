// <copyright file="SelectionRangeHandler.cs" company="GSharp">
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
/// Selection range handler — provides smart expand/shrink selection.
/// </summary>
public class SelectionRangeHandler : SelectionRangeHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="SelectionRangeHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public SelectionRangeHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<Container<SelectionRange>> Handle(SelectionRangeParams request, CancellationToken cancellationToken)
    {
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult(new Container<SelectionRange>());
        }

        var results = new List<SelectionRange>();
        foreach (var position in request.Positions)
        {
            results.Add(SelectionRangeComputer.ComputeSelectionRange(content, position));
        }

        return Task.FromResult(new Container<SelectionRange>(results));
    }

    /// <inheritdoc/>
    protected override SelectionRangeRegistrationOptions CreateRegistrationOptions(SelectionRangeCapability capability, ClientCapabilities clientCapabilities)
    {
        return new SelectionRangeRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
        };
    }
}

/// <summary>
/// Pure-function selection range computer.
/// </summary>
internal static class SelectionRangeComputer
{
    public static SelectionRange ComputeSelectionRange(DocumentContent content, Position position)
    {
        var tree = content.SyntaxTree;
        var text = tree.Text;
        var offset = SemanticLookup.ToOffset(content, position);

        // Find all enclosing nodes from innermost to outermost
        var chain = new List<SyntaxNode>();
        CollectAncestors(tree.Root, offset, chain);

        // Build nested SelectionRange from inside out
        SelectionRange current = null;
        for (var i = chain.Count - 1; i >= 0; i--)
        {
            var node = chain[i];
            var range = SemanticLookup.ToRange(text, node.Span);
            current = new SelectionRange { Range = range, Parent = current };
        }

        // If no chain found, return a range for the whole file
        if (current == null)
        {
            var lastLine = text.Lines.Length - 1;
            var lastChar = text.Lines[lastLine].Length;
            current = new SelectionRange
            {
                Range = new OmniSharp.Extensions.LanguageServer.Protocol.Models.Range(
                    new Position(0, 0),
                    new Position(lastLine, lastChar)),
            };
        }

        return current;
    }

    private static void CollectAncestors(SyntaxNode node, int offset, List<SyntaxNode> chain)
    {
        if (node.Span.Start > offset || node.Span.End < offset)
        {
            return;
        }

        // Add this node to the chain (outermost first, will reverse order in consumer)
        chain.Add(node);

        foreach (var child in node.GetChildren())
        {
            if (child.Span.Start <= offset && offset <= child.Span.End)
            {
                CollectAncestors(child, offset, chain);
                return;
            }
        }
    }
}
