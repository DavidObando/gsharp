// <copyright file="CodeLensHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer.Protocol
import Range = GSharp.LanguageServer.Protocol.Range
import System.Collections.Generic
import System.Linq
import System.Threading

/// Pure-function CodeLens computer usable by both the handler and tests.
shared class CodeLensComputer {
    func ComputeLenses(
        content DocumentContent,
        uri string? = nil,
        ct CancellationToken = default(CancellationToken)
    ) IReadOnlyList[CodeLens] -> ComputeReferenceLenses(content, uri, ct).Select(
        (lens ReferenceCodeLens) -> CreateReferenceLens(lens.DeclarationRange, lens.ReferenceCount, uri)
    )
        .ToList()

    func ComputeReferenceLenses(
        content DocumentContent,
        uri string? = nil,
        ct CancellationToken = default(CancellationToken)
    ) IReadOnlyList[ReferenceCodeLens] {
        let lenses = List[ReferenceCodeLens]()
        var compilation Compilation
        try {
            compilation = content.Project?.GetCompilation() ?? ServerCompilation.Create(content.SyntaxTree)
        } catch {
            return lenses
        }
        // SemanticLookup.ResolveSymbol matches identifier tokens by reference equality, so the
        // tree we iterate must be the exact instance the project compilation was built from.
        // ProjectState.UpdateFile only ever runs under the write gate (didOpen/didChange/didSave;
        // see issue #1657), so content.SyntaxTree and the project's cached tree stay in sync in
        // practice. Still prefer the project's current tree defensively so member-identifier
        // lookups (which have no name-based fallback in SemanticModel) keep working even if a
        // future caller races the two.
        let tree = ResolveProjectTree(content, uri) ?? content.SyntaxTree
        for member in tree.Root.Members {
            // Each iteration can trigger a FindReferences walk; check between members so a
            // superseded request (fast typing) aborts instead of running to completion.
            ct.ThrowIfCancellationRequested()
            switch member {
                case func_ is FunctionDeclarationSyntax {
                    AddReferenceLens(compilation, lenses, func_.Identifier, uri, ct)
                }
                case structDecl is StructDeclarationSyntax {
                    AddReferenceLens(compilation, lenses, structDecl.Identifier, uri, ct)
                    AddMemberLenses(
                        compilation,
                        lenses,
                        structDecl.Fields.Select((f FieldDeclarationSyntax) -> f.Identifier),
                        uri,
                        ct
                    )
                    AddMemberLenses(
                        compilation,
                        lenses,
                        structDecl.Properties.Select((p PropertyDeclarationSyntax) -> p.Identifier),
                        uri,
                        ct
                    )
                    AddMemberLenses(
                        compilation,
                        lenses,
                        structDecl.Events.Select((e EventDeclarationSyntax) -> e.Identifier),
                        uri,
                        ct
                    )
                    AddMemberLenses(
                        compilation,
                        lenses,
                        structDecl.Methods.Select((m FunctionDeclarationSyntax) -> m.Identifier),
                        uri,
                        ct
                    )
                    if structDecl.SharedBlock != nil {
                        AddMemberLenses(
                            compilation,
                            lenses,
                            structDecl.SharedBlock!!.Fields.Select((f FieldDeclarationSyntax) -> f.Identifier),
                            uri,
                            ct
                        )
                        AddMemberLenses(
                            compilation,
                            lenses,
                            structDecl.SharedBlock!!.Properties.Select((p PropertyDeclarationSyntax) -> p.Identifier),
                            uri,
                            ct
                        )
                        AddMemberLenses(
                            compilation,
                            lenses,
                            structDecl.SharedBlock!!.Events.Select((e EventDeclarationSyntax) -> e.Identifier),
                            uri,
                            ct
                        )
                        AddMemberLenses(
                            compilation,
                            lenses,
                            structDecl.SharedBlock!!.Methods.Select((m FunctionDeclarationSyntax) -> m.Identifier),
                            uri,
                            ct
                        )
                    }
                }
                case enumDecl is EnumDeclarationSyntax {
                    AddReferenceLens(compilation, lenses, enumDecl.Identifier, uri, ct)
                    AddMemberLenses(
                        compilation,
                        lenses,
                        enumDecl.Members.Select((m EnumMemberSyntax) -> m.Identifier),
                        uri,
                        ct
                    )
                }
                case ifaceDecl is InterfaceDeclarationSyntax {
                    AddReferenceLens(compilation, lenses, ifaceDecl.Identifier, uri, ct)
                    AddMemberLenses(
                        compilation,
                        lenses,
                        ifaceDecl.Methods.Select((m FunctionDeclarationSyntax) -> m.Identifier),
                        uri,
                        ct
                    )
                    AddMemberLenses(
                        compilation,
                        lenses,
                        ifaceDecl.Properties.Select((p PropertyDeclarationSyntax) -> p.Identifier),
                        uri,
                        ct
                    )
                    AddMemberLenses(
                        compilation,
                        lenses,
                        ifaceDecl.Events.Select((e EventDeclarationSyntax) -> e.Identifier),
                        uri,
                        ct
                    )
                }
                case typeAlias is TypeAliasDeclarationSyntax {
                    AddReferenceLens(compilation, lenses, typeAlias.Identifier, uri, ct)
                }
                case globalStatement is GlobalStatementSyntax {
                    if globalStatement.Statement is VariableDeclarationSyntax varDecl {
                        AddReferenceLens(compilation, lenses, varDecl.Identifier, uri, ct)
                    }
                }
            }
        }
        return lenses
    }

    private func AddMemberLenses(
        compilation Compilation,
        lenses List[ReferenceCodeLens],
        identifiers IEnumerable[SyntaxToken],
        uri string?,
        ct CancellationToken
    ) {
        for identifier in identifiers {
            ct.ThrowIfCancellationRequested()
            if identifier == nil || identifier.IsMissing {
                continue
            }
            AddReferenceLens(compilation, lenses, identifier, uri, ct)
        }
    }

    private func AddReferenceLens(
        compilation Compilation,
        lenses List[ReferenceCodeLens],
        identifier SyntaxToken?,
        uri string?,
        ct CancellationToken
    ) {
        ct.ThrowIfCancellationRequested()
        if identifier == nil || identifier.IsMissing {
            return
        }
        let symbol Symbol? = SemanticLookup.ResolveSymbol(compilation, identifier, ct)
        if symbol == nil {
            return
        }
        let locations = SemanticLookup
            .FindReferences(compilation, symbol, ct)
            .Where((token SyntaxToken) -> !object.ReferenceEquals(token, identifier))
            .Select(
            (token SyntaxToken) -> Location{Uri: GetDocumentUri(token, uri), Range: SemanticLookup.ToRange(token)}
        )
            .ToArray()
        lenses.Add(
            ReferenceCodeLens{
                DeclarationRange: SemanticLookup.ToRange(identifier),
                ReferenceCount: locations.Length,
                References: locations
            }
        )
    }

    private func GetDocumentUri(token SyntaxToken, fallback string?) DocumentUri? {
        if !string.IsNullOrEmpty(token.SyntaxTree?.Text?.FileName) {
            return DocumentUri.FromFileSystemPath(token.SyntaxTree.Text.FileName)
        }
        return DocumentUri.From(fallback)
    }

    private func CreateReferenceLens($range Range, refCount int32, uri string?) CodeLens {
        let title = if refCount == 1 {
            "1 reference"
        } else {
            "$refCount references"
        }
        return CodeLens{
            Range: $range,
            Command: Command{Title: title, Name: "gsharp.showReferences", Arguments: []object? {uri, $range.Start}}
        }
    }

    private func ResolveProjectTree(content DocumentContent, uri string?) SyntaxTree? {
        if content.Project == nil || string.IsNullOrEmpty(uri) {
            return nil
        }
        let filePath = DocumentUri.From(uri)?.GetFileSystemPath()
        if string.IsNullOrEmpty(filePath) {
            return nil
        }
        return if content.Project!!.TryGetSyntaxTree(filePath, out var projectTree) {
            projectTree
        } else {
            default(SyntaxTree?)
        }
    }
}
