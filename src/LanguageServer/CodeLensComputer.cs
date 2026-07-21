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
        => ComputeReferenceLenses(content, uri, ct)
            .Select(lens => CreateReferenceLens(lens.DeclarationRange, lens.ReferenceCount, uri))
            .ToList();

    public static IReadOnlyList<ReferenceCodeLens> ComputeReferenceLenses(DocumentContent content, string uri = null, CancellationToken ct = default)
    {
        var lenses = new List<ReferenceCodeLens>();

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
                    AddReferenceLens(compilation, lenses, func.Identifier, uri, ct);
                    break;
                case StructDeclarationSyntax structDecl:
                    AddReferenceLens(compilation, lenses, structDecl.Identifier, uri, ct);
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
                    AddReferenceLens(compilation, lenses, enumDecl.Identifier, uri, ct);
                    AddMemberLenses(compilation, lenses, enumDecl.Members.Select(m => m.Identifier), uri, ct);
                    break;
                case InterfaceDeclarationSyntax ifaceDecl:
                    AddReferenceLens(compilation, lenses, ifaceDecl.Identifier, uri, ct);
                    AddMemberLenses(compilation, lenses, ifaceDecl.Methods.Select(m => m.Identifier), uri, ct);
                    AddMemberLenses(compilation, lenses, ifaceDecl.Properties.Select(p => p.Identifier), uri, ct);
                    AddMemberLenses(compilation, lenses, ifaceDecl.Events.Select(e => e.Identifier), uri, ct);
                    break;
                case TypeAliasDeclarationSyntax typeAlias:
                    AddReferenceLens(compilation, lenses, typeAlias.Identifier, uri, ct);
                    break;
                case GlobalStatementSyntax globalStatement:
                    if (globalStatement.Statement is VariableDeclarationSyntax varDecl)
                    {
                        AddReferenceLens(compilation, lenses, varDecl.Identifier, uri, ct);
                    }

                    break;
            }
        }

        return lenses;
    }

    private static void AddMemberLenses(
        GSharp.Core.CodeAnalysis.Compilation.Compilation compilation,
        List<ReferenceCodeLens> lenses,
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

            AddReferenceLens(compilation, lenses, identifier, uri, ct);
        }
    }

    private static void AddReferenceLens(
        GSharp.Core.CodeAnalysis.Compilation.Compilation compilation,
        List<ReferenceCodeLens> lenses,
        SyntaxToken identifier,
        string uri,
        CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (identifier == null || identifier.IsMissing)
        {
            return;
        }

        var symbol = SemanticLookup.ResolveSymbol(compilation, identifier, ct);
        if (symbol == null)
        {
            return;
        }

        var locations = SemanticLookup.FindReferences(compilation, symbol, ct)
            .Where(token => !ReferenceEquals(token, identifier))
            .Select(token => new Location
            {
                Uri = GetDocumentUri(token, uri),
                Range = SemanticLookup.ToRange(token),
            })
            .ToArray();
        lenses.Add(new ReferenceCodeLens
        {
            DeclarationRange = SemanticLookup.ToRange(identifier),
            ReferenceCount = locations.Length,
            References = locations,
        });
    }

    private static DocumentUri GetDocumentUri(SyntaxToken token, string fallback)
    {
        if (!string.IsNullOrEmpty(token.SyntaxTree?.Text?.FileName))
        {
            return DocumentUri.FromFileSystemPath(token.SyntaxTree.Text.FileName);
        }

        return DocumentUri.From(fallback);
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
