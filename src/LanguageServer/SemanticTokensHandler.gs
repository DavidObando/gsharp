// <copyright file="SemanticTokensHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer.Protocol
import GSharpSymbolKind = GSharp.Core.CodeAnalysis.Symbols.SymbolKind
import System
import System.Collections.Generic
import System.Threading

/// Semantic tokens metadata for GSharp — the legend (token types + modifiers) shared by the
/// server dispatch target and tests.
shared class SemanticTokensHandler {
    let TokenTypes[]SemanticTokenType = []SemanticTokenType{
        SemanticTokenType.Namespace,
        SemanticTokenType.Type,
        SemanticTokenType.Struct,
        SemanticTokenType.Interface,
        SemanticTokenType.Enum,
        SemanticTokenType.EnumMember,
        SemanticTokenType.TypeParameter,
        SemanticTokenType.Parameter,
        SemanticTokenType.Variable,
        SemanticTokenType.Property,
        SemanticTokenType.Function,
        SemanticTokenType.Method,
        SemanticTokenType.Keyword,
        SemanticTokenType.String,
        SemanticTokenType.Number,
        SemanticTokenType.Operator,
        SemanticTokenType.Comment,
        SemanticTokenType.Event
    }
    let TokenModifiers[]SemanticTokenModifier = []SemanticTokenModifier{
        SemanticTokenModifier.Declaration,
        SemanticTokenModifier.Definition,
        SemanticTokenModifier.Readonly,
        SemanticTokenModifier.Static,
        SemanticTokenModifier.Async,
        SemanticTokenModifier.Deprecated
    }

    /// Gets the semantic tokens legend (token types + modifiers).
    private let _legend SemanticTokensLegend = SemanticTokensLegend{
        TokenTypes: TokenTypes,
        TokenModifiers: TokenModifiers
    }

    prop Legend SemanticTokensLegend {
        get {
            return _legend
        }
    }
}

/// Pure-function semantic token computer usable by both the handler and tests.
shared class SemanticTokensComputer {
    func Tokenize(
        builder SemanticTokensBuilder,
        content DocumentContent,
        ct CancellationToken = default(CancellationToken)
    ) {
        let tree = content.SyntaxTree
        let text = tree.Text
        // Build semantic model if possible for symbol classification
        var compilation Compilation? = nil
        var declarationPositions HashSet[int32]? = nil
        try {
            compilation = content.Project?.GetCompilation() ?? Compilation(tree)
            declarationPositions = BuildDeclarationPositions(tree)
        } catch {
            // Fall back to syntax-only classification

        }
        // Use ParseTokens to get ALL tokens including comments (parser filters them out)
        let allTokens = SyntaxTree.ParseTokens(text)
        for token in allTokens {
            // Whole-document token stream can be large; check between tokens so a
            // superseded request (fast typing) aborts instead of running to completion.
            ct.ThrowIfCancellationRequested()
            if token.IsMissing || token.Span.Length == 0 {
                continue
            }
            // Interpolated string literals are decomposed: literal text is classified as String,
            // while the hole expressions are tokenized as real code (identifiers, numbers).
            if token.Kind == SyntaxKind.InterpolatedStringToken {
                EmitInterpolatedStringTokens(builder, tree, text, token.Span, compilation, declarationPositions, ct)
                continue
            }
            // For identifiers, resolve using the token from the parsed tree at the same position
            // (ParseTokens creates tokens in a different tree that won't resolve in the compilation)
            var resolveToken SyntaxToken? = token
            if token.Kind == SyntaxKind.IdentifierToken && compilation != nil {
                resolveToken = SemanticLookup.FindTokenAt(tree, token.Span.Start)
                if resolveToken == nil || resolveToken.Kind != SyntaxKind.IdentifierToken {
                    continue
                }
            }
            let classification = ClassifyToken(resolveToken!!, compilation, declarationPositions, ct)
            if classification == nil {
                continue
            }
            let (tokenType, modifiers) = classification
            let line = text.GetLineIndex(token.Span.Start)
            let character = token.Span.Start - text.Lines[line].Start
            builder.Push(line, character, token.Span.Length, tokenType, modifiers)
        }
    }

    private func EmitInterpolatedStringTokens(
        builder SemanticTokensBuilder,
        tree SyntaxTree,
        text SourceText,
        literalSpan TextSpan,
        compilation Compilation?,
        declarationPositions HashSet[int32]?,
        ct CancellationToken = default(CancellationToken)
    ) {
        var literalSpan = literalSpan
        let node InterpolatedStringExpressionSyntax? = FindInterpolatedNode(tree.Root, literalSpan.Start)
        // Collect classified hole tokens plus the hole-expression spans. String filler is emitted
        // only for the literal/delimiter text OUTSIDE the holes; inside a hole, classified tokens
        // (identifiers, numbers) are overlaid and the remaining code (operators, punctuation,
        // keywords, member names the model can't resolve) is left for the TextMate grammar so it
        // is colored as code rather than as part of the surrounding string.
        let holeTokens = List[(Span TextSpan, Type SemanticTokenType, Modifiers[]SemanticTokenModifier)]()
        let holeSpans = List[TextSpan]()
        if node != nil {
            for holeExpr in node.HoleExpressions {
                if holeExpr
                    .Span
                    .Length > 0 &&
                    holeExpr
                    .Span
                    .Start >= literalSpan.Start &&
                    holeExpr
                    .Span
                    .End <= literalSpan.End {
                    holeSpans.Add(holeExpr.Span)
                }
                let leaves = List[SyntaxToken]()
                CollectHoleTokens(holeExpr, leaves)
                for leaf in leaves {
                    if leaf.IsMissing || leaf.Span.Length == 0 {
                        continue
                    }
                    if leaf.Span.Start < literalSpan.Start || leaf.Span.End > literalSpan.End {
                        continue
                    }
                    var resolveToken = leaf
                    if leaf.Kind == SyntaxKind.IdentifierToken && compilation != nil {
                        resolveToken = SemanticLookup.FindTokenAt(tree, leaf.Span.Start) ?? leaf
                    }
                    let classification = ClassifyToken(resolveToken, compilation, declarationPositions, ct)
                    if classification == nil {
                        continue
                    }
                    holeTokens.Add((leaf.Span, classification.Type, classification.Modifiers))
                }
            }
        }
        // Emit String filler for the literal span minus the hole-expression spans.
        holeSpans.Sort((a TextSpan, b TextSpan) -> a.Start.CompareTo(b.Start))
        var cursor = literalSpan.Start
        for hole in holeSpans {
            if hole.Start > cursor {
                PushStringRange(builder, text, cursor, hole.Start)
            }
            if hole.End > cursor {
                cursor = hole.End
            }
        }
        if cursor < literalSpan.End {
            PushStringRange(builder, text, cursor, literalSpan.End)
        }
        // Overlay the classified hole tokens (sorted, non-overlapping).
        holeTokens.Sort(
            (
                a(Span TextSpan, Type SemanticTokenType, Modifiers[]SemanticTokenModifier),
                b(Span TextSpan, Type SemanticTokenType, Modifiers[]SemanticTokenModifier)
            ) -> a
                .Span
                .Start
                .CompareTo(b.Span.Start)
        )
        var lastEnd = literalSpan.Start
        for hole in holeTokens {
            if hole.Span.Start < lastEnd {
                continue
            }
            PushRange(builder, text, hole.Span.Start, hole.Span.End, hole.Type, hole.Modifiers)
            lastEnd = hole.Span.End
        }
    }

    private func FindInterpolatedNode(node SyntaxNode, literalStart int32) InterpolatedStringExpressionSyntax? {
        if node is InterpolatedStringExpressionSyntax interpolated &&
            interpolated
            .StringToken
            .Span
            .Start == literalStart {
            return interpolated
        }
        for child in node.GetChildren() {
            if child.Span.Start <= literalStart && literalStart < child.Span.End {
                let found InterpolatedStringExpressionSyntax? = FindInterpolatedNode(child, literalStart)
                if found != nil {
                    return found
                }
            }
        }
        return nil
    }

    private func CollectHoleTokens(node SyntaxNode, tokens List[SyntaxToken]) {
        if node is SyntaxToken token {
            tokens.Add(token)
            return
        }
        // Treat a nested interpolated string as a single String token (avoids overlapping ranges).
        if node is InterpolatedStringExpressionSyntax nested {
            tokens.Add(nested.StringToken)
            return
        }
        for child in node.GetChildren() {
            CollectHoleTokens(child, tokens)
        }
    }

    private func PushStringRange(builder SemanticTokensBuilder, text SourceText, from int32, to int32) {
        PushRange(builder, text, from, to, SemanticTokenType.String, Array.Empty[SemanticTokenModifier]())
    }

    // Pushes a (possibly multi-line) range as a sequence of per-line tokens of a single type.
    private func PushRange(
        builder SemanticTokensBuilder,
        text SourceText,
        from int32,
        to int32,
        type SemanticTokenType,
        modifiers[]SemanticTokenModifier
    ) {
        var pos = from
        while pos < to {
            let lineIndex = text.GetLineIndex(pos)
            let line = text.Lines[lineIndex]
            let segmentEnd = Math.Min(to, line.End)
            if segmentEnd > pos {
                builder.Push(lineIndex, pos - line.Start, segmentEnd - pos, type, modifiers)
            }
            // Advance to the start of the next line, skipping the line break.
            if lineIndex + 1 < text.Lines.Length {
                pos = text.Lines[lineIndex + 1].Start
            } else {
                break
            }
        }
    }

    private func BuildDeclarationPositions(tree SyntaxTree) HashSet[int32] {
        let positions = HashSet[int32]()
        CollectDeclarationPositions(tree.Root, positions)
        return positions
    }

    private func CollectDeclarationPositions(node SyntaxNode, positions HashSet[int32]) {
        switch node {
            case funcDecl is FunctionDeclarationSyntax {
                positions.Add(funcDecl.Identifier.Span.Start)
            }
            case varDecl is VariableDeclarationSyntax {
                positions.Add(varDecl.Identifier.Span.Start)
            }
            case ParameterSyntax{Identifier: {} identifier} {
                positions.Add(identifier.Span.Start)
            }
            case structDecl is StructDeclarationSyntax {
                positions.Add(structDecl.Identifier.Span.Start)
            }
            case enumDecl is EnumDeclarationSyntax {
                positions.Add(enumDecl.Identifier.Span.Start)
            }
            case ifaceDecl is InterfaceDeclarationSyntax {
                positions.Add(ifaceDecl.Identifier.Span.Start)
            }
            case fieldDecl is FieldDeclarationSyntax {
                positions.Add(fieldDecl.Identifier.Span.Start)
            }
            case enumMember is EnumMemberSyntax {
                positions.Add(enumMember.Identifier.Span.Start)
            }
            case varPattern is VarPatternSyntax when varPattern.Designation.Text != "_" {
                positions.Add(varPattern.Designation.Span.Start)
            }
            case typePattern is TypePatternSyntax when typePattern.BindingIdentifier is {
                Text: not "_"
            } typeDesignation {
                positions.Add(typeDesignation.Span.Start)
            }
            case propertyPattern is PropertyPatternSyntax when propertyPattern.Designation is {
                Text: not "_"
            } propertyDesignation {
                positions.Add(propertyDesignation.Span.Start)
            }
            case slicePattern is SlicePatternSyntax when slicePattern.CaptureIdentifier != nil {
                positions.Add(slicePattern.CaptureIdentifier!!.Span.Start)
            }
        }
        for child in node.GetChildren() {
            CollectDeclarationPositions(child, positions)
        }
    }

    private func ClassifyToken(
        token SyntaxToken,
        compilation Compilation?,
        declarationPositions HashSet[int32]?,
        ct CancellationToken = default(CancellationToken)
    )(Type SemanticTokenType, Modifiers[]SemanticTokenModifier)? {
        // Comments
        if token.Kind == SyntaxKind.CommentToken {
            return (SemanticTokenType.Comment, Array.Empty[SemanticTokenModifier]())
        }
        // String literals
        if token.Kind == SyntaxKind.StringToken ||
            token.Kind == SyntaxKind.ByteStringToken ||
            token.Kind == SyntaxKind.Utf8StringToken ||
            token.Kind == SyntaxKind.InterpolatedStringToken {
            return (SemanticTokenType.String, Array.Empty[SemanticTokenModifier]())
        }
        // Number literals
        if token.Kind == SyntaxKind.NumberToken {
            return (SemanticTokenType.Number, Array.Empty[SemanticTokenModifier]())
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
        if IsOperatorOrPunctuation(token.Kind) {
            return nil
        }
        // Identifiers — resolve via semantic model
        if token.Kind == SyntaxKind.IdentifierToken && compilation != nil {
            return ClassifyIdentifier(token, compilation, declarationPositions, ct)
        }
        return nil
    }

    private func ClassifyIdentifier(
        token SyntaxToken,
        compilation Compilation,
        declarationPositions HashSet[int32]?,
        ct CancellationToken = default(CancellationToken)
    )(Type SemanticTokenType, Modifiers[]SemanticTokenModifier)? {
        let symbol Symbol? = SemanticLookup.ResolveSymbol(compilation, token, ct)
        if symbol == nil {
            return nil
        }
        let isDeclaration = declarationPositions != nil && declarationPositions.Contains(token.Span.Start)
        let modifiers = if isDeclaration {
            []SemanticTokenModifier{SemanticTokenModifier.Declaration}
        } else {
            Array.Empty[SemanticTokenModifier]()
        }
        return switch symbol.Kind {
            case GSharpSymbolKind.Function or
                GSharpSymbolKind.ImportedFunction: (
                SemanticTokenType.Function,
                BuildFunctionModifiers(symbol, isDeclaration)
            )
            case GSharpSymbolKind.Parameter: (SemanticTokenType.Parameter, modifiers)
            case GSharpSymbolKind.LocalVariable: (SemanticTokenType.Variable, modifiers)
            case GSharpSymbolKind.GlobalVariable: (SemanticTokenType.Variable, modifiers)
            case GSharpSymbolKind.Type or GSharpSymbolKind.ImportedClass: ClassifyTypeSymbol(symbol, isDeclaration)
            case GSharpSymbolKind.Package: (SemanticTokenType.Namespace, modifiers)
            case GSharpSymbolKind.Field: (SemanticTokenType.Property, modifiers)
            case GSharpSymbolKind.Property: (SemanticTokenType.Property, modifiers)
            case GSharpSymbolKind.EnumMember: (SemanticTokenType.EnumMember, modifiers)
            case GSharpSymbolKind.Event: (SemanticTokenType.Event, modifiers)
            case GSharpSymbolKind.Import: (SemanticTokenType.Namespace, modifiers)
            default: nil
        }
    }

    private func ClassifyTypeSymbol(symbol Symbol, isDeclaration bool)(
        Type SemanticTokenType,
        Modifiers[]SemanticTokenModifier
    ) {
        let modifiers = if isDeclaration {
            []SemanticTokenModifier{SemanticTokenModifier.Declaration}
        } else {
            Array.Empty[SemanticTokenModifier]()
        }
        if symbol is StructSymbol {
            return (SemanticTokenType.Struct, modifiers)
        }
        if symbol is InterfaceSymbol {
            return (SemanticTokenType.Interface, modifiers)
        }
        if symbol is EnumSymbol {
            return (SemanticTokenType.Enum, modifiers)
        }
        if symbol is TypeParameterSymbol {
            return (SemanticTokenType.TypeParameter, modifiers)
        }
        return (SemanticTokenType.Type, modifiers)
    }

    private func BuildFunctionModifiers(symbol Symbol, isDeclaration bool)[]SemanticTokenModifier {
        let modifiers = List[SemanticTokenModifier]()
        if isDeclaration {
            modifiers.Add(SemanticTokenModifier.Declaration)
        }
        if symbol is FunctionSymbol fs && fs.IsAsync {
            modifiers.Add(SemanticTokenModifier.Async)
        }
        return modifiers.ToArray()
    }

    private func IsOperatorOrPunctuation(kind SyntaxKind) bool {
        return kind >= SyntaxKind.PlusToken && kind <= SyntaxKind.AtToken
    }
}
