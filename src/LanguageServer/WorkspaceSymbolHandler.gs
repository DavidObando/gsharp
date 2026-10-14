// <copyright file="WorkspaceSymbolHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer.Protocol
import LspSymbolKind = GSharp.LanguageServer.Protocol.SymbolKind
import Range = GSharp.LanguageServer.Protocol.Range
import System
import System.Collections.Generic

/// Workspace symbol collection — provides workspace-wide symbol search.
shared class WorkspaceSymbolHandler {
    func CollectSymbols(results List[WorkspaceSymbol], uri string, content DocumentContent, query string) {
        let text = content.SyntaxTree.Text
        for member in content.SyntaxTree.Root.Members {
            switch member {
                case func_ is FunctionDeclarationSyntax {
                    AddIfMatches(
                        results,
                        func_.Identifier.Text,
                        LspSymbolKind.Function,
                        uri,
                        SemanticLookup.ToRange(text, func_.Span),
                        query
                    )
                }
                case GlobalStatementSyntax{Statement: VariableDeclarationSyntax variable} {
                    AddIfMatches(
                        results,
                        variable.Identifier.Text,
                        LspSymbolKind.Variable,
                        uri,
                        SemanticLookup.ToRange(text, variable.Span),
                        query
                    )
                }
                case structDecl is StructDeclarationSyntax {
                    AddIfMatches(
                        results,
                        structDecl.Identifier.Text,
                        LspSymbolKind.Struct,
                        uri,
                        SemanticLookup.ToRange(text, structDecl.Span),
                        query
                    )
                    for field in structDecl.Fields {
                        AddIfMatches(
                            results,
                            field.Identifier.Text,
                            LspSymbolKind.Field,
                            uri,
                            SemanticLookup.ToRange(text, field.Span),
                            query
                        )
                    }
                }
                case enumDecl is EnumDeclarationSyntax {
                    AddIfMatches(
                        results,
                        enumDecl.Identifier.Text,
                        LspSymbolKind.Enum,
                        uri,
                        SemanticLookup.ToRange(text, enumDecl.Span),
                        query
                    )
                    for enumMember in enumDecl.Members {
                        AddIfMatches(
                            results,
                            enumMember.Identifier.Text,
                            LspSymbolKind.EnumMember,
                            uri,
                            SemanticLookup.ToRange(text, enumMember.Span),
                            query
                        )
                    }
                }
                case ifaceDecl is InterfaceDeclarationSyntax {
                    AddIfMatches(
                        results,
                        ifaceDecl.Identifier.Text,
                        LspSymbolKind.Interface,
                        uri,
                        SemanticLookup.ToRange(text, ifaceDecl.Span),
                        query
                    )
                }
            }
        }
    }

    private func AddIfMatches(
        results List[WorkspaceSymbol],
        name string,
        kind LspSymbolKind,
        uri string,
        $range Range,
        query string
    ) {
        if string.IsNullOrEmpty(query) || name.Contains(query, StringComparison.OrdinalIgnoreCase) {
            results.Add(WorkspaceSymbol{Name: name, Kind: kind, Location: Location{Uri: uri, Range: $range}})
        }
    }
}
