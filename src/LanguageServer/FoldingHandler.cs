// <copyright file="FoldingHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.LanguageServer
{
    using System.Collections.Generic;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;
    using GSharp.Core.CodeAnalysis.Syntax;
    using OmniSharp.Extensions.LanguageServer.Protocol.Client.Capabilities;
    using OmniSharp.Extensions.LanguageServer.Protocol.Models;
    using OmniSharp.Extensions.LanguageServer.Protocol.Server;

    /// <summary>
    /// Folding handler for GSharp.
    /// </summary>
    public class FoldingHandler : IFoldingRangeHandler
    {
        private readonly ILanguageServer router;
        private readonly DocumentContentService documentContentService;
        private FoldingRangeCapability capability;

        /// <summary>
        /// Initializes a new instance of the <see cref="FoldingHandler"/> class.
        /// </summary>
        /// <param name="router"><see cref="ILanguageServer"/> for LSP.</param>
        /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
        public FoldingHandler(ILanguageServer router, DocumentContentService documentContentService)
        {
            this.router = router;
            this.documentContentService = documentContentService;
        }

        /// <inheritdoc/>
        public TextDocumentRegistrationOptions GetRegistrationOptions()
        {
            return new TextDocumentRegistrationOptions()
            {
                DocumentSelector = Constants.DocumentSelector,
            };
        }

        /// <inheritdoc/>
        public Task<Container<FoldingRange>> Handle(FoldingRangeRequestParam request, CancellationToken cancellationToken)
        {
            var key = request.TextDocument.Uri.ToString();
            if (!this.documentContentService.TryGet(key, out DocumentContent content))
            {
                this.router.Window.LogMessage(new LogMessageParams()
                {
                     Type = MessageType.Warning,
                     Message = $"No syntax tree for {key}",
                });
                return Task.FromResult(new Container<FoldingRange>());
            }

            var foldings = new List<FoldingRange>();

            // TODO: Functions are only at the root for the moment
            foreach (FunctionDeclarationSyntax function in content.SyntaxTree.Root.Members.OfType<FunctionDeclarationSyntax>())
            {
                int startLine = content.Lines.Count(charNumber => charNumber < function.Body.Span.Start);
                int endLine = content.Lines.Count(charNumber => charNumber < function.Body.Span.End);
                foldings.Add(new FoldingRange()
                {
                    StartLine = startLine,
                    EndLine = endLine,
                    Kind = FoldingRangeKind.Region,
                    EndCharacter = 0,
                    StartCharacter = 0,
                });
            }

            return Task.FromResult(new Container<FoldingRange>(foldings));
        }

        /// <inheritdoc/>
        public void SetCapability(FoldingRangeCapability capability)
        {
            this.capability = capability;
        }
    }
}
