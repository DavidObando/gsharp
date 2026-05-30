// <copyright file="WorkspaceSymbolHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;
using LspSymbolKind = GSharp.LanguageServer.Protocol.SymbolKind;
using Range = GSharp.LanguageServer.Protocol.Range;

namespace GSharp.LanguageServer;

/// <summary>
/// Workspace symbol collection — provides workspace-wide symbol search.
/// </summary>
public static class WorkspaceSymbolHandler
{
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

    private static void AddIfMatches(List<WorkspaceSymbol> results, string name, LspSymbolKind kind, string uri, Range range, string query)
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
