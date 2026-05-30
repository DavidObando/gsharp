// <copyright file="WorkspaceSymbolHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Syntax;
using OmniSharp.Extensions.LanguageServer.Protocol.Client.Capabilities;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using OmniSharp.Extensions.LanguageServer.Protocol.Workspace;
using LspSymbolKind = OmniSharp.Extensions.LanguageServer.Protocol.Models.SymbolKind;

namespace GSharp.LanguageServer;

/// <summary>
/// Workspace symbol handler — provides workspace-wide symbol search.
/// </summary>
public class WorkspaceSymbolHandler : WorkspaceSymbolsHandlerBase
{
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="WorkspaceSymbolHandler"/> class.
    /// </summary>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public WorkspaceSymbolHandler(DocumentContentService documentContentService)
    {
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<Container<WorkspaceSymbol>> Handle(WorkspaceSymbolParams request, CancellationToken cancellationToken)
    {
        var query = request.Query ?? string.Empty;
        var results = new List<WorkspaceSymbol>();

        foreach (var pair in this.documentContentService.AllDocuments)
        {
            var uri = pair.Key;
            var content = pair.Value;
            CollectSymbols(results, uri, content, query);
        }

        return Task.FromResult(new Container<WorkspaceSymbol>(results));
    }

    internal static void CollectSymbols(List<WorkspaceSymbol> results, string uri, DocumentContent content, string query)
    {
        var text = content.SyntaxTree.Text;

        foreach (var member in content.SyntaxTree.Root.Members)
        {
            switch (member)
            {
                case FunctionDeclarationSyntax func:
                    AddIfMatches(results, func.Identifier.Text, LspSymbolKind.Function, uri, SemanticLookup.ToRange(text, func.Span), query);
                    break;
                case GlobalStatementSyntax { Statement: VariableDeclarationSyntax variable }:
                    AddIfMatches(results, variable.Identifier.Text, LspSymbolKind.Variable, uri, SemanticLookup.ToRange(text, variable.Span), query);
                    break;
                case StructDeclarationSyntax structDecl:
                    AddIfMatches(results, structDecl.Identifier.Text, LspSymbolKind.Struct, uri, SemanticLookup.ToRange(text, structDecl.Span), query);
                    foreach (var field in structDecl.Fields)
                    {
                        AddIfMatches(results, field.Identifier.Text, LspSymbolKind.Field, uri, SemanticLookup.ToRange(text, field.Span), query);
                    }

                    break;
                case EnumDeclarationSyntax enumDecl:
                    AddIfMatches(results, enumDecl.Identifier.Text, LspSymbolKind.Enum, uri, SemanticLookup.ToRange(text, enumDecl.Span), query);
                    foreach (var enumMember in enumDecl.Members)
                    {
                        AddIfMatches(results, enumMember.Identifier.Text, LspSymbolKind.EnumMember, uri, SemanticLookup.ToRange(text, enumMember.Span), query);
                    }

                    break;
                case InterfaceDeclarationSyntax ifaceDecl:
                    AddIfMatches(results, ifaceDecl.Identifier.Text, LspSymbolKind.Interface, uri, SemanticLookup.ToRange(text, ifaceDecl.Span), query);
                    break;
            }
        }
    }

    /// <inheritdoc/>
    protected override WorkspaceSymbolRegistrationOptions CreateRegistrationOptions(WorkspaceSymbolCapability capability, ClientCapabilities clientCapabilities)
    {
        return new WorkspaceSymbolRegistrationOptions();
    }

    private static void AddIfMatches(List<WorkspaceSymbol> results, string name, LspSymbolKind kind, string uri, OmniSharp.Extensions.LanguageServer.Protocol.Models.Range range, string query)
    {
        if (string.IsNullOrEmpty(query) || name.Contains(query, StringComparison.OrdinalIgnoreCase))
        {
            results.Add(new WorkspaceSymbol
            {
                Name = name,
                Kind = kind,
                Location = new Location { Uri = uri, Range = range },
            });
        }
    }
}
