// <copyright file="SemanticTokensHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;
using GSharpSymbolKind = GSharp.Core.CodeAnalysis.Symbols.SymbolKind;

namespace GSharp.LanguageServer;

/// <summary>
/// Semantic tokens metadata for GSharp — the legend (token types + modifiers) shared by the
/// server dispatch target and tests.
/// </summary>
public static class SemanticTokensHandler
{
    public static readonly SemanticTokenType[] TokenTypes =
    [
        SemanticTokenType.Namespace,      // 0
        SemanticTokenType.Type,           // 1
        SemanticTokenType.Struct,         // 2
        SemanticTokenType.Interface,      // 3
        SemanticTokenType.Enum,           // 4
        SemanticTokenType.EnumMember,     // 5
        SemanticTokenType.TypeParameter,  // 6
        SemanticTokenType.Parameter,      // 7
        SemanticTokenType.Variable,       // 8
        SemanticTokenType.Property,       // 9
        SemanticTokenType.Function,       // 10
        SemanticTokenType.Method,         // 11
        SemanticTokenType.Keyword,        // 12
        SemanticTokenType.String,         // 13
        SemanticTokenType.Number,         // 14
        SemanticTokenType.Operator,       // 15
        SemanticTokenType.Comment,        // 16
        SemanticTokenType.Event,          // 17
    ];

    public static readonly SemanticTokenModifier[] TokenModifiers =
    [
        SemanticTokenModifier.Declaration, // 0
        SemanticTokenModifier.Definition,  // 1
        SemanticTokenModifier.Readonly,    // 2
        SemanticTokenModifier.Static,      // 3
        SemanticTokenModifier.Async,       // 4
        SemanticTokenModifier.Deprecated,  // 5
    ];

    /// <summary>
    /// Gets the semantic tokens legend (token types + modifiers).
    /// </summary>
    public static SemanticTokensLegend Legend { get; } = new SemanticTokensLegend
    {
        TokenTypes = TokenTypes,
        TokenModifiers = TokenModifiers,
    };
}

/// <summary>
/// Pure-function semantic token computer usable by both the handler and tests.
/// </summary>
public static class SemanticTokensComputer
{
    public static void Tokenize(SemanticTokensBuilder builder, DocumentContent content)
    {
        var tree = content.SyntaxTree;
        var text = tree.Text;

        // Build semantic model if possible for symbol classification
        GSharp.Core.CodeAnalysis.Compilation.Compilation compilation = null;
        HashSet<int> declarationPositions = null;
        try
        {
            compilation = content.Project?.GetCompilation() ?? new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
            declarationPositions = BuildDeclarationPositions(tree);
        }
        catch
        {
            // Fall back to syntax-only classification
        }

        // Use ParseTokens to get ALL tokens including comments (parser filters them out)
        var allTokens = SyntaxTree.ParseTokens(text);
        foreach (var token in allTokens)
        {
            if (token.IsMissing || token.Span.Length == 0)
            {
                continue;
            }

            // For identifiers, resolve using the token from the parsed tree at the same position
            // (ParseTokens creates tokens in a different tree that won't resolve in the compilation)
            var resolveToken = token;
            if (token.Kind == SyntaxKind.IdentifierToken && compilation != null)
            {
                resolveToken = SemanticLookup.FindTokenAt(tree, token.Span.Start);
                if (resolveToken == null || resolveToken.Kind != SyntaxKind.IdentifierToken)
                {
                    continue;
                }
            }

            var classification = ClassifyToken(resolveToken, compilation, declarationPositions);
            if (classification == null)
            {
                continue;
            }

            var (tokenType, modifiers) = classification.Value;
            var line = text.GetLineIndex(token.Span.Start);
            var character = token.Span.Start - text.Lines[line].Start;

            builder.Push(line, character, token.Span.Length, tokenType, modifiers);
        }
    }

    private static HashSet<int> BuildDeclarationPositions(SyntaxTree tree)
    {
        var positions = new HashSet<int>();
        CollectDeclarationPositions(tree.Root, positions);
        return positions;
    }

    private static void CollectDeclarationPositions(SyntaxNode node, HashSet<int> positions)
    {
        switch (node)
        {
            case FunctionDeclarationSyntax funcDecl:
                positions.Add(funcDecl.Identifier.Span.Start);
                break;
            case VariableDeclarationSyntax varDecl:
                positions.Add(varDecl.Identifier.Span.Start);
                break;
            case ParameterSyntax paramSyntax:
                positions.Add(paramSyntax.Identifier.Span.Start);
                break;
            case StructDeclarationSyntax structDecl:
                positions.Add(structDecl.Identifier.Span.Start);
                break;
            case EnumDeclarationSyntax enumDecl:
                positions.Add(enumDecl.Identifier.Span.Start);
                break;
            case InterfaceDeclarationSyntax ifaceDecl:
                positions.Add(ifaceDecl.Identifier.Span.Start);
                break;
            case FieldDeclarationSyntax fieldDecl:
                positions.Add(fieldDecl.Identifier.Span.Start);
                break;
            case EnumMemberSyntax enumMember:
                positions.Add(enumMember.Identifier.Span.Start);
                break;
        }

        foreach (var child in node.GetChildren())
        {
            CollectDeclarationPositions(child, positions);
        }
    }

    private static (SemanticTokenType Type, SemanticTokenModifier[] Modifiers)? ClassifyToken(
        SyntaxToken token,
        GSharp.Core.CodeAnalysis.Compilation.Compilation compilation,
        HashSet<int> declarationPositions)
    {
        // Comments
        if (token.Kind == SyntaxKind.CommentToken)
        {
            return (SemanticTokenType.Comment, System.Array.Empty<SemanticTokenModifier>());
        }

        // String literals
        if (token.Kind == SyntaxKind.StringToken || token.Kind == SyntaxKind.InterpolatedStringToken)
        {
            return (SemanticTokenType.String, System.Array.Empty<SemanticTokenModifier>());
        }

        // Number literals
        if (token.Kind == SyntaxKind.NumberToken)
        {
            return (SemanticTokenType.Number, System.Array.Empty<SemanticTokenModifier>());
        }

        // Keywords
        if (IsKeyword(token.Kind))
        {
            return (SemanticTokenType.Keyword, System.Array.Empty<SemanticTokenModifier>());
        }

        // Operators and punctuation — not classified as semantic tokens
        if (IsOperatorOrPunctuation(token.Kind))
        {
            return null;
        }

        // Identifiers — resolve via semantic model
        if (token.Kind == SyntaxKind.IdentifierToken && compilation != null)
        {
            return ClassifyIdentifier(token, compilation, declarationPositions);
        }

        return null;
    }

    private static (SemanticTokenType Type, SemanticTokenModifier[] Modifiers)? ClassifyIdentifier(
        SyntaxToken token,
        GSharp.Core.CodeAnalysis.Compilation.Compilation compilation,
        HashSet<int> declarationPositions)
    {
        var symbol = SemanticLookup.ResolveSymbol(compilation, token);
        if (symbol == null)
        {
            return null;
        }

        var isDeclaration = declarationPositions != null && declarationPositions.Contains(token.Span.Start);
        var modifiers = isDeclaration
            ? new[] { SemanticTokenModifier.Declaration }
            : System.Array.Empty<SemanticTokenModifier>();

        return symbol.Kind switch
        {
            GSharpSymbolKind.Function or GSharpSymbolKind.ImportedFunction => (SemanticTokenType.Function, BuildFunctionModifiers(symbol, isDeclaration)),
            GSharpSymbolKind.Parameter => (SemanticTokenType.Parameter, modifiers),
            GSharpSymbolKind.LocalVariable => (SemanticTokenType.Variable, modifiers),
            GSharpSymbolKind.GlobalVariable => (SemanticTokenType.Variable, modifiers),
            GSharpSymbolKind.Type or GSharpSymbolKind.ImportedClass => ClassifyTypeSymbol(symbol, isDeclaration),
            GSharpSymbolKind.Package => (SemanticTokenType.Namespace, modifiers),
            GSharpSymbolKind.Field => (SemanticTokenType.Property, modifiers),
            GSharpSymbolKind.Property => (SemanticTokenType.Property, modifiers),
            GSharpSymbolKind.EnumMember => (SemanticTokenType.EnumMember, modifiers),
            GSharpSymbolKind.Event => (SemanticTokenType.Event, modifiers),
            GSharpSymbolKind.Import => (SemanticTokenType.Namespace, modifiers),
            _ => null,
        };
    }

    private static (SemanticTokenType Type, SemanticTokenModifier[] Modifiers) ClassifyTypeSymbol(Symbol symbol, bool isDeclaration)
    {
        var modifiers = isDeclaration
            ? new[] { SemanticTokenModifier.Declaration }
            : System.Array.Empty<SemanticTokenModifier>();

        if (symbol is StructSymbol)
        {
            return (SemanticTokenType.Struct, modifiers);
        }

        if (symbol is InterfaceSymbol)
        {
            return (SemanticTokenType.Interface, modifiers);
        }

        if (symbol is EnumSymbol)
        {
            return (SemanticTokenType.Enum, modifiers);
        }

        if (symbol is TypeParameterSymbol)
        {
            return (SemanticTokenType.TypeParameter, modifiers);
        }

        return (SemanticTokenType.Type, modifiers);
    }

    private static SemanticTokenModifier[] BuildFunctionModifiers(Symbol symbol, bool isDeclaration)
    {
        var modifiers = new List<SemanticTokenModifier>();
        if (isDeclaration)
        {
            modifiers.Add(SemanticTokenModifier.Declaration);
        }

        if (symbol is FunctionSymbol fs && fs.IsAsync)
        {
            modifiers.Add(SemanticTokenModifier.Async);
        }

        return modifiers.ToArray();
    }

    private static bool IsKeyword(SyntaxKind kind)
    {
        return kind >= SyntaxKind.AsyncKeyword && kind <= SyntaxKind.FinallyKeyword;
    }

    private static bool IsOperatorOrPunctuation(SyntaxKind kind)
    {
        return kind >= SyntaxKind.PlusToken && kind <= SyntaxKind.AtToken;
    }
}
