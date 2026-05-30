// <copyright file="PrepareRenameHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using OmniSharp.Extensions.LanguageServer.Protocol.Client.Capabilities;
using OmniSharp.Extensions.LanguageServer.Protocol.Document;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;
using OmniSharp.Extensions.LanguageServer.Protocol.Window;

namespace GSharp.LanguageServer;

/// <summary>
/// PrepareRename handler — validates rename position and returns the word range.
/// </summary>
public class PrepareRenameHandler : PrepareRenameHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="PrepareRenameHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public PrepareRenameHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<RangeOrPlaceholderRange> Handle(PrepareRenameParams request, CancellationToken cancellationToken)
    {
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            return Task.FromResult<RangeOrPlaceholderRange>(null);
        }

        var offset = SemanticLookup.ToOffset(content, request.Position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        if (token == null || token.Kind != SyntaxKind.IdentifierToken)
        {
            return Task.FromResult<RangeOrPlaceholderRange>(null);
        }

        GSharp.Core.CodeAnalysis.Compilation.Compilation compilation;
        try
        {
            compilation = content.Project?.GetCompilation()
                ?? new GSharp.Core.CodeAnalysis.Compilation.Compilation(content.SyntaxTree);
        }
        catch
        {
            return Task.FromResult<RangeOrPlaceholderRange>(null);
        }

        var symbol = SemanticLookup.ResolveSymbol(compilation, token);
        if (!SemanticLookup.CanRename(symbol))
        {
            return Task.FromResult<RangeOrPlaceholderRange>(null);
        }

        var range = SemanticLookup.ToRange(token);
        return Task.FromResult<RangeOrPlaceholderRange>(new RangeOrPlaceholderRange(range));
    }

    /// <inheritdoc/>
    protected override RenameRegistrationOptions CreateRegistrationOptions(RenameCapability capability, ClientCapabilities clientCapabilities)
    {
        return new RenameRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
            PrepareProvider = true,
        };
    }
}

/// <summary>
/// Implementation handler — for interfaces, finds implementing types.
/// </summary>
public class ImplementationHandler : ImplementationHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="ImplementationHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public ImplementationHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<LocationOrLocationLinks> Handle(ImplementationParams request, CancellationToken cancellationToken)
    {
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult(new LocationOrLocationLinks());
        }

        var offset = SemanticLookup.ToOffset(content, request.Position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        if (token == null || token.Kind != SyntaxKind.IdentifierToken)
        {
            return Task.FromResult(new LocationOrLocationLinks());
        }

        GSharp.Core.CodeAnalysis.Compilation.Compilation compilation;
        try
        {
            compilation = content.Project?.GetCompilation()
                ?? new GSharp.Core.CodeAnalysis.Compilation.Compilation(content.SyntaxTree);
        }
        catch
        {
            return Task.FromResult(new LocationOrLocationLinks());
        }

        var symbol = SemanticLookup.ResolveSymbol(compilation, token);
        if (symbol is not InterfaceSymbol iface)
        {
            return Task.FromResult(new LocationOrLocationLinks());
        }

        // Find structs that implement this interface
        var locations = new List<Location>();
        foreach (var structSym in compilation.GlobalScope.Structs)
        {
            if (structSym.Interfaces.Contains(iface))
            {
                if (structSym.Declaration != null)
                {
                    locations.Add(new Location
                    {
                        Uri = request.TextDocument.Uri,
                        Range = SemanticLookup.ToRange(structSym.Declaration.Identifier),
                    });
                }
            }
        }

        return Task.FromResult(new LocationOrLocationLinks(locations.Select(l => new LocationOrLocationLink(l))));
    }

    /// <inheritdoc/>
    protected override ImplementationRegistrationOptions CreateRegistrationOptions(ImplementationCapability capability, ClientCapabilities clientCapabilities)
    {
        return new ImplementationRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
        };
    }
}

/// <summary>
/// TypeDefinition handler — navigates from a variable to its type declaration.
/// </summary>
public class TypeDefinitionHandler : TypeDefinitionHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="TypeDefinitionHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public TypeDefinitionHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<LocationOrLocationLinks> Handle(TypeDefinitionParams request, CancellationToken cancellationToken)
    {
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult(new LocationOrLocationLinks());
        }

        var offset = SemanticLookup.ToOffset(content, request.Position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        if (token == null || token.Kind != SyntaxKind.IdentifierToken)
        {
            return Task.FromResult(new LocationOrLocationLinks());
        }

        GSharp.Core.CodeAnalysis.Compilation.Compilation compilation;
        try
        {
            compilation = content.Project?.GetCompilation()
                ?? new GSharp.Core.CodeAnalysis.Compilation.Compilation(content.SyntaxTree);
        }
        catch
        {
            return Task.FromResult(new LocationOrLocationLinks());
        }

        var symbol = SemanticLookup.ResolveSymbol(compilation, token);

        // Get the type of the symbol
        TypeSymbol typeSymbol = symbol switch
        {
            ParameterSymbol ps => ps.Type,
            VariableSymbol vs => vs.Type,
            FunctionSymbol fs => fs.Type,
            _ => null,
        };

        if (typeSymbol == null)
        {
            return Task.FromResult(new LocationOrLocationLinks());
        }

        // Find the type's declaration in the tree
        var typeRefs = SemanticLookup.FindReferences(compilation, typeSymbol);
        var firstRef = typeRefs.FirstOrDefault();
        if (firstRef == null)
        {
            return Task.FromResult(new LocationOrLocationLinks());
        }

        var location = new Location
        {
            Uri = request.TextDocument.Uri,
            Range = SemanticLookup.ToRange(firstRef),
        };

        return Task.FromResult(new LocationOrLocationLinks(new[] { new LocationOrLocationLink(location) }));
    }

    /// <inheritdoc/>
    protected override TypeDefinitionRegistrationOptions CreateRegistrationOptions(TypeDefinitionCapability capability, ClientCapabilities clientCapabilities)
    {
        return new TypeDefinitionRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
        };
    }
}
