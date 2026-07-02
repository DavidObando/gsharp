// <copyright file="CodeLensHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using System.Threading;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;
using Range = GSharp.LanguageServer.Protocol.Range;

namespace GSharp.LanguageServer;

/// <summary>
/// Pure-function CodeLens computer usable by both the handler and tests.
/// </summary>
public static class CodeLensComputer
{
    public static IReadOnlyList<CodeLens> ComputeLenses(DocumentContent content, string uri = null, CancellationToken ct = default)
    {
        var lenses = new List<CodeLens>();

        GSharp.Core.CodeAnalysis.Compilation.Compilation compilation;
        try
        {
            compilation = content.Project?.GetCompilation()
                ?? new GSharp.Core.CodeAnalysis.Compilation.Compilation(content.SyntaxTree);
        }
        catch
        {
            return lenses;
        }

        // SemanticLookup.ResolveSymbol matches identifier tokens by reference equality, so the
        // tree we iterate must be the exact instance the project compilation was built from.
        // ProjectState.UpdateFile only ever runs under the write gate (didOpen/didChange/didSave;
        // see issue #1657), so content.SyntaxTree and the project's cached tree stay in sync in
        // practice. Still prefer the project's current tree defensively so member-identifier
        // lookups (which have no name-based fallback in SemanticModel) keep working even if a
        // future caller races the two.
        var tree = ResolveProjectTree(content, uri) ?? content.SyntaxTree;

        foreach (var member in tree.Root.Members)
        {
            // Each iteration can trigger a FindReferences walk; check between members so a
            // superseded request (fast typing) aborts instead of running to completion.
            ct.ThrowIfCancellationRequested();
            switch (member)
            {
                case FunctionDeclarationSyntax func:
                    var funcSymbol = SemanticLookup.ResolveSymbol(compilation, func.Identifier);
                    if (funcSymbol != null)
                    {
                        var refCount = SemanticLookup.FindReferences(compilation, funcSymbol).Count() - 1; // exclude declaration
                        var range = SemanticLookup.ToRange(func.Identifier);
                        lenses.Add(CreateReferenceLens(range, refCount, uri));
                    }

                    break;
                case StructDeclarationSyntax structDecl:
                    var structSymbol = SemanticLookup.ResolveSymbol(compilation, structDecl.Identifier);
                    if (structSymbol != null)
                    {
                        var refCount = SemanticLookup.FindReferences(compilation, structSymbol).Count() - 1;
                        var range = SemanticLookup.ToRange(structDecl.Identifier);
                        lenses.Add(CreateReferenceLens(range, refCount, uri));
                    }

                    AddMemberLenses(compilation, lenses, structDecl.Fields.Select(f => f.Identifier), uri, ct);
                    AddMemberLenses(compilation, lenses, structDecl.Properties.Select(p => p.Identifier), uri, ct);
                    AddMemberLenses(compilation, lenses, structDecl.Events.Select(e => e.Identifier), uri, ct);
                    AddMemberLenses(compilation, lenses, structDecl.Methods.Select(m => m.Identifier), uri, ct);

                    if (structDecl.SharedBlock != null)
                    {
                        AddMemberLenses(compilation, lenses, structDecl.SharedBlock.Fields.Select(f => f.Identifier), uri, ct);
                        AddMemberLenses(compilation, lenses, structDecl.SharedBlock.Properties.Select(p => p.Identifier), uri, ct);
                        AddMemberLenses(compilation, lenses, structDecl.SharedBlock.Events.Select(e => e.Identifier), uri, ct);
                        AddMemberLenses(compilation, lenses, structDecl.SharedBlock.Methods.Select(m => m.Identifier), uri, ct);
                    }

                    break;
                case EnumDeclarationSyntax enumDecl:
                    var enumSymbol = SemanticLookup.ResolveSymbol(compilation, enumDecl.Identifier);
                    if (enumSymbol != null)
                    {
                        var refCount = SemanticLookup.FindReferences(compilation, enumSymbol).Count() - 1;
                        var range = SemanticLookup.ToRange(enumDecl.Identifier);
                        lenses.Add(CreateReferenceLens(range, refCount, uri));
                    }

                    AddMemberLenses(compilation, lenses, enumDecl.Members.Select(m => m.Identifier), uri, ct);
                    break;
                case InterfaceDeclarationSyntax ifaceDecl:
                    var ifaceSymbol = SemanticLookup.ResolveSymbol(compilation, ifaceDecl.Identifier);
                    if (ifaceSymbol != null)
                    {
                        var refCount = SemanticLookup.FindReferences(compilation, ifaceSymbol).Count() - 1;
                        var range = SemanticLookup.ToRange(ifaceDecl.Identifier);
                        lenses.Add(CreateReferenceLens(range, refCount, uri));
                    }

                    AddMemberLenses(compilation, lenses, ifaceDecl.Methods.Select(m => m.Identifier), uri, ct);
                    AddMemberLenses(compilation, lenses, ifaceDecl.Properties.Select(p => p.Identifier), uri, ct);
                    AddMemberLenses(compilation, lenses, ifaceDecl.Events.Select(e => e.Identifier), uri, ct);
                    break;
                case TypeAliasDeclarationSyntax typeAlias:
                    var aliasSymbol = SemanticLookup.ResolveSymbol(compilation, typeAlias.Identifier);
                    if (aliasSymbol != null)
                    {
                        var refCount = SemanticLookup.FindReferences(compilation, aliasSymbol).Count() - 1;
                        var range = SemanticLookup.ToRange(typeAlias.Identifier);
                        lenses.Add(CreateReferenceLens(range, refCount, uri));
                    }

                    break;
                case GlobalStatementSyntax globalStatement:
                    if (globalStatement.Statement is VariableDeclarationSyntax varDecl)
                    {
                        var varSymbol = SemanticLookup.ResolveSymbol(compilation, varDecl.Identifier);
                        if (varSymbol != null)
                        {
                            var refCount = SemanticLookup.FindReferences(compilation, varSymbol).Count() - 1;
                            var range = SemanticLookup.ToRange(varDecl.Identifier);
                            lenses.Add(CreateReferenceLens(range, refCount, uri));
                        }
                    }

                    break;
            }
        }

        return lenses;
    }

    private static void AddMemberLenses(
        GSharp.Core.CodeAnalysis.Compilation.Compilation compilation,
        List<CodeLens> lenses,
        IEnumerable<SyntaxToken> identifiers,
        string uri,
        CancellationToken ct)
    {
        foreach (var identifier in identifiers)
        {
            ct.ThrowIfCancellationRequested();
            if (identifier == null || identifier.IsMissing)
            {
                continue;
            }

            var symbol = SemanticLookup.ResolveSymbol(compilation, identifier);
            if (symbol != null)
            {
                var refCount = SemanticLookup.FindReferences(compilation, symbol).Count() - 1;
                var range = SemanticLookup.ToRange(identifier);
                lenses.Add(CreateReferenceLens(range, refCount, uri));
            }
        }
    }

    private static CodeLens CreateReferenceLens(Range range, int refCount, string uri)
    {
        var title = refCount == 1 ? "1 reference" : $"{refCount} references";
        return new CodeLens
        {
            Range = range,
            Command = new Command
            {
                Title = title,
                Name = "gsharp.showReferences",
                Arguments = [uri, range.Start],
            },
        };
    }

    private static GSharp.Core.CodeAnalysis.Syntax.SyntaxTree ResolveProjectTree(DocumentContent content, string uri)
    {
        if (content.Project == null || string.IsNullOrEmpty(uri))
        {
            return null;
        }

        var filePath = DocumentUri.From(uri)?.GetFileSystemPath();
        if (string.IsNullOrEmpty(filePath))
        {
            return null;
        }

        return content.Project.TryGetSyntaxTree(filePath, out var projectTree) ? projectTree : null;
    }
}
