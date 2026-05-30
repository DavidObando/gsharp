// <copyright file="CodeLensHandler.cs" company="GSharp">
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
/// CodeLens handler — shows reference counts above declarations.
/// </summary>
public class CodeLensHandler : CodeLensHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="CodeLensHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public CodeLensHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<CodeLensContainer> Handle(CodeLensParams request, CancellationToken cancellationToken)
    {
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult(new CodeLensContainer());
        }

        var lenses = CodeLensComputer.ComputeLenses(content);
        return Task.FromResult(new CodeLensContainer(lenses));
    }

    /// <inheritdoc/>
    public override Task<CodeLens> Handle(CodeLens request, CancellationToken cancellationToken)
    {
        // Resolve — no additional resolution needed
        return Task.FromResult(request);
    }

    /// <inheritdoc/>
    protected override CodeLensRegistrationOptions CreateRegistrationOptions(CodeLensCapability capability, ClientCapabilities clientCapabilities)
    {
        return new CodeLensRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
            ResolveProvider = false,
        };
    }
}

/// <summary>
/// Pure-function CodeLens computer usable by both the handler and tests.
/// </summary>
internal static class CodeLensComputer
{
    public static IReadOnlyList<CodeLens> ComputeLenses(DocumentContent content)
    {
        var tree = content.SyntaxTree;
        var text = tree.Text;
        var lenses = new List<CodeLens>();

        GSharp.Core.CodeAnalysis.Compilation.Compilation compilation;
        try
        {
            compilation = content.Project?.GetCompilation()
                ?? new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        }
        catch
        {
            return lenses;
        }

        foreach (var member in tree.Root.Members)
        {
            switch (member)
            {
                case FunctionDeclarationSyntax func:
                    var funcSymbol = SemanticLookup.ResolveSymbol(compilation, func.Identifier);
                    if (funcSymbol != null)
                    {
                        var refCount = SemanticLookup.FindReferences(compilation, funcSymbol).Count() - 1; // exclude declaration
                        var range = SemanticLookup.ToRange(func.Identifier);
                        lenses.Add(CreateReferenceLens(range, refCount));
                    }

                    break;
                case StructDeclarationSyntax structDecl:
                    var structSymbol = SemanticLookup.ResolveSymbol(compilation, structDecl.Identifier);
                    if (structSymbol != null)
                    {
                        var refCount = SemanticLookup.FindReferences(compilation, structSymbol).Count() - 1;
                        var range = SemanticLookup.ToRange(structDecl.Identifier);
                        lenses.Add(CreateReferenceLens(range, refCount));
                    }

                    break;
                case EnumDeclarationSyntax enumDecl:
                    var enumSymbol = SemanticLookup.ResolveSymbol(compilation, enumDecl.Identifier);
                    if (enumSymbol != null)
                    {
                        var refCount = SemanticLookup.FindReferences(compilation, enumSymbol).Count() - 1;
                        var range = SemanticLookup.ToRange(enumDecl.Identifier);
                        lenses.Add(CreateReferenceLens(range, refCount));
                    }

                    break;
                case InterfaceDeclarationSyntax ifaceDecl:
                    var ifaceSymbol = SemanticLookup.ResolveSymbol(compilation, ifaceDecl.Identifier);
                    if (ifaceSymbol != null)
                    {
                        var refCount = SemanticLookup.FindReferences(compilation, ifaceSymbol).Count() - 1;
                        var range = SemanticLookup.ToRange(ifaceDecl.Identifier);
                        lenses.Add(CreateReferenceLens(range, refCount));
                    }

                    break;
            }
        }

        return lenses;
    }

    private static CodeLens CreateReferenceLens(OmniSharp.Extensions.LanguageServer.Protocol.Models.Range range, int refCount)
    {
        var title = refCount == 1 ? "1 reference" : $"{refCount} references";
        return new CodeLens
        {
            Range = range,
            Command = new Command { Title = title, Name = "gsharp.showReferences" },
        };
    }
}
