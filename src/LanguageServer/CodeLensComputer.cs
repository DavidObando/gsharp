// <copyright file="CodeLensHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;
using Range = GSharp.LanguageServer.Protocol.Range;

namespace GSharp.LanguageServer;

/// <summary>
/// Pure-function CodeLens computer usable by both the handler and tests.
/// </summary>
public static class CodeLensComputer
{
    public static IReadOnlyList<CodeLens> ComputeLenses(DocumentContent content, string uri = null)
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

                    break;
                case EnumDeclarationSyntax enumDecl:
                    var enumSymbol = SemanticLookup.ResolveSymbol(compilation, enumDecl.Identifier);
                    if (enumSymbol != null)
                    {
                        var refCount = SemanticLookup.FindReferences(compilation, enumSymbol).Count() - 1;
                        var range = SemanticLookup.ToRange(enumDecl.Identifier);
                        lenses.Add(CreateReferenceLens(range, refCount, uri));
                    }

                    break;
                case InterfaceDeclarationSyntax ifaceDecl:
                    var ifaceSymbol = SemanticLookup.ResolveSymbol(compilation, ifaceDecl.Identifier);
                    if (ifaceSymbol != null)
                    {
                        var refCount = SemanticLookup.FindReferences(compilation, ifaceSymbol).Count() - 1;
                        var range = SemanticLookup.ToRange(ifaceDecl.Identifier);
                        lenses.Add(CreateReferenceLens(range, refCount, uri));
                    }

                    break;
            }
        }

        return lenses;
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
                Arguments = new object[] { uri, range.Start },
            },
        };
    }
}
