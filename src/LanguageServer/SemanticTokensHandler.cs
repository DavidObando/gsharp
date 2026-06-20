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

            // Interpolated string literals are decomposed: literal text is classified as String,
            // while the hole expressions are tokenized as real code (identifiers, numbers).
            if (token.Kind == SyntaxKind.InterpolatedStringToken)
            {
                EmitInterpolatedStringTokens(builder, tree, text, token.Span, compilation, declarationPositions);
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

    private static void EmitInterpolatedStringTokens(
        SemanticTokensBuilder builder,
        SyntaxTree tree,
        GSharp.Core.CodeAnalysis.Text.SourceText text,
        GSharp.Core.CodeAnalysis.Text.TextSpan literalSpan,
        GSharp.Core.CodeAnalysis.Compilation.Compilation compilation,
        HashSet<int> declarationPositions)
    {
        var node = FindInterpolatedNode(tree.Root, literalSpan.Start);

        // Collect classified hole tokens plus the hole-expression spans. String filler is emitted
        // only for the literal/delimiter text OUTSIDE the holes; inside a hole, classified tokens
        // (identifiers, numbers) are overlaid and the remaining code (operators, punctuation,
        // keywords, member names the model can't resolve) is left for the TextMate grammar so it
        // is colored as code rather than as part of the surrounding string.
        var holeTokens = new List<(GSharp.Core.CodeAnalysis.Text.TextSpan Span, SemanticTokenType Type, SemanticTokenModifier[] Modifiers)>();
        var holeSpans = new List<GSharp.Core.CodeAnalysis.Text.TextSpan>();
        if (node != null)
        {
            foreach (var holeExpr in node.HoleExpressions)
            {
                if (holeExpr.Span.Length > 0 &&
                    holeExpr.Span.Start >= literalSpan.Start &&
                    holeExpr.Span.End <= literalSpan.End)
                {
                    holeSpans.Add(holeExpr.Span);
                }

                var leaves = new List<SyntaxToken>();
                CollectHoleTokens(holeExpr, leaves);

                foreach (var leaf in leaves)
                {
                    if (leaf.IsMissing || leaf.Span.Length == 0)
                    {
                        continue;
                    }

                    if (leaf.Span.Start < literalSpan.Start || leaf.Span.End > literalSpan.End)
                    {
                        continue;
                    }

                    var resolveToken = leaf;
                    if (leaf.Kind == SyntaxKind.IdentifierToken && compilation != null)
                    {
                        resolveToken = SemanticLookup.FindTokenAt(tree, leaf.Span.Start) ?? leaf;
                    }

                    var classification = ClassifyToken(resolveToken, compilation, declarationPositions);
                    if (classification == null)
                    {
                        continue;
                    }

                    holeTokens.Add((leaf.Span, classification.Value.Type, classification.Value.Modifiers));
                }
            }
        }

        // Emit String filler for the literal span minus the hole-expression spans.
        holeSpans.Sort((a, b) => a.Start.CompareTo(b.Start));
        var cursor = literalSpan.Start;
        foreach (var hole in holeSpans)
        {
            if (hole.Start > cursor)
            {
                PushStringRange(builder, text, cursor, hole.Start);
            }

            if (hole.End > cursor)
            {
                cursor = hole.End;
            }
        }

        if (cursor < literalSpan.End)
        {
            PushStringRange(builder, text, cursor, literalSpan.End);
        }

        // Overlay the classified hole tokens (sorted, non-overlapping).
        holeTokens.Sort((a, b) => a.Span.Start.CompareTo(b.Span.Start));
        var lastEnd = literalSpan.Start;
        foreach (var hole in holeTokens)
        {
            if (hole.Span.Start < lastEnd)
            {
                continue;
            }

            PushRange(builder, text, hole.Span.Start, hole.Span.End, hole.Type, hole.Modifiers);
            lastEnd = hole.Span.End;
        }
    }

    private static InterpolatedStringExpressionSyntax FindInterpolatedNode(SyntaxNode node, int literalStart)
    {
        if (node is InterpolatedStringExpressionSyntax interpolated &&
            interpolated.StringToken.Span.Start == literalStart)
        {
            return interpolated;
        }

        foreach (var child in node.GetChildren())
        {
            if (child.Span.Start <= literalStart && literalStart < child.Span.End)
            {
                var found = FindInterpolatedNode(child, literalStart);
                if (found != null)
                {
                    return found;
                }
            }
        }

        return null;
    }

    private static void CollectHoleTokens(SyntaxNode node, List<SyntaxToken> tokens)
    {
        if (node is SyntaxToken token)
        {
            tokens.Add(token);
            return;
        }

        // Treat a nested interpolated string as a single String token (avoids overlapping ranges).
        if (node is InterpolatedStringExpressionSyntax nested)
        {
            tokens.Add(nested.StringToken);
            return;
        }

        foreach (var child in node.GetChildren())
        {
            CollectHoleTokens(child, tokens);
        }
    }

    private static void PushStringRange(
        SemanticTokensBuilder builder,
        GSharp.Core.CodeAnalysis.Text.SourceText text,
        int from,
        int to)
    {
        PushRange(builder, text, from, to, SemanticTokenType.String, System.Array.Empty<SemanticTokenModifier>());
    }

    // Pushes a (possibly multi-line) range as a sequence of per-line tokens of a single type.
    private static void PushRange(
        SemanticTokensBuilder builder,
        GSharp.Core.CodeAnalysis.Text.SourceText text,
        int from,
        int to,
        SemanticTokenType type,
        SemanticTokenModifier[] modifiers)
    {
        var pos = from;
        while (pos < to)
        {
            var lineIndex = text.GetLineIndex(pos);
            var line = text.Lines[lineIndex];
            var segmentEnd = System.Math.Min(to, line.End);
            if (segmentEnd > pos)
            {
                builder.Push(lineIndex, pos - line.Start, segmentEnd - pos, type, modifiers);
            }

            // Advance to the start of the next line, skipping the line break.
            if (lineIndex + 1 < text.Lines.Length)
            {
                pos = text.Lines[lineIndex + 1].Start;
            }
            else
            {
                break;
            }
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

        // Keywords are intentionally NOT classified as semantic tokens. The
        // TextMate grammar already colors them via fine-grained scopes
        // (keyword.control, keyword.declaration, keyword.modifier, ...). Emitting
        // a single flat semantic `keyword` type would override those scopes once
        // the language server initializes, causing a visible color shift (e.g.
        // control keywords recoloring from their `keyword.control` color to the
        // generic `keyword` color). Leaving keywords to TextMate keeps their
        // color stable across the LSP handshake under every theme.

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

    private static bool IsOperatorOrPunctuation(SyntaxKind kind)
    {
        return kind >= SyntaxKind.PlusToken && kind <= SyntaxKind.AtToken;
    }
}
