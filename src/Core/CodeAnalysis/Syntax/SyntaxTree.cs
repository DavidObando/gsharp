// <copyright file="SyntaxTree.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents the language's syntax tree.
/// </summary>
public class SyntaxTree
{
    private Dictionary<SyntaxNode, string>? documentationTable;

    private SyntaxTree(SourceText text)
    {
        Text = text;
        Root = null!;
        Diagnostics = ImmutableArray<Diagnostic>.Empty;
        DocumentationTokens = ImmutableArray<SyntaxToken>.Empty;
    }

    /// <summary>
    /// Gets the source text.
    /// </summary>
    public SourceText Text { get; }

    /// <summary>
    /// Gets the diagnostics.
    /// </summary>
    public ImmutableArray<Diagnostic> Diagnostics { get; private set; }

    /// <summary>
    /// Gets the compilation unit root.
    /// </summary>
    public CompilationUnitSyntax Root { get; private set; }

    /// <summary>
    /// Gets the documentation comment tokens collected during lexing (ADR-0057 §7).
    /// </summary>
    internal ImmutableArray<SyntaxToken> DocumentationTokens { get; private set; }

    /// <summary>
    /// Parses the source text from the provided file path into a syntax tree.
    /// </summary>
    /// <param name="filePath">The source file path.</param>
    /// <returns>A parsed syntax tree.</returns>
    public static SyntaxTree Load(string filePath)
    {
        var rawBytes = File.ReadAllBytes(filePath);
        var text = File.ReadAllText(filePath);
        var sourceText = SourceText.From(text, filePath, rawBytes);
        return Parse(sourceText);
    }

    /// <summary>
    /// Parses the source text into a syntax tree.
    /// </summary>
    /// <param name="text">The source text.</param>
    /// <returns>A parsed syntax tree.</returns>
    public static SyntaxTree Parse(string text)
    {
        var sourceText = SourceText.From(text);
        return Parse(sourceText);
    }

    /// <summary>
    /// Parses the source text into a syntax tree.
    /// </summary>
    /// <param name="text">The source text.</param>
    /// <returns>A parsed syntax tree.</returns>
    public static SyntaxTree Parse(SourceText text)
    {
        var syntaxTree = new SyntaxTree(text);
        var parser = new Parser(syntaxTree);
        syntaxTree.SetParseResult(
            parser.ParseCompilationUnit(),
            parser.Diagnostics.ToImmutableArray(),
            parser.DocumentationTokens);
        return syntaxTree;
    }

    /// <summary>
    /// Parses the tokens in the provided source text.
    /// </summary>
    /// <param name="text">The source text.</param>
    /// <returns>The tokens in the source text.</returns>
    public static ImmutableArray<SyntaxToken> ParseTokens(string text)
    {
        var sourceText = SourceText.From(text);
        return ParseTokens(sourceText);
    }

    /// <summary>
    /// Parses the tokens in the provided source text.
    /// </summary>
    /// <param name="text">The source text.</param>
    /// <returns>The tokens in the source text.</returns>
    public static ImmutableArray<SyntaxToken> ParseTokens(SourceText text)
    {
        return ParseTokens(text, out _);
    }

    /// <summary>
    /// Parses the tokens in the provided source text and provides error diagnostics information.
    /// </summary>
    /// <param name="text">The source text.</param>
    /// <param name="diagnostics">The diagnostics obtained by parsing the source text.</param>
    /// <returns>The tokens in the source text.</returns>
    public static ImmutableArray<SyntaxToken> ParseTokens(string text, out ImmutableArray<Diagnostic> diagnostics)
    {
        var sourceText = SourceText.From(text);
        return ParseTokens(sourceText, out diagnostics);
    }

    /// <summary>
    /// Parses the tokens in the provided source text and provides error diagnostics information.
    /// </summary>
    /// <param name="text">The source text.</param>
    /// <param name="diagnostics">The diagnostics obtained by parsing the source text.</param>
    /// <returns>The tokens in the source text.</returns>
    public static ImmutableArray<SyntaxToken> ParseTokens(SourceText text, out ImmutableArray<Diagnostic> diagnostics)
    {
        var tokens = new List<SyntaxToken>();
        var syntaxTree = new SyntaxTree(text);
        var lexer = new Lexer(syntaxTree);
        CompilationUnitSyntax? root = null;
        while (true)
        {
            var token = lexer.Lex();
            if (token.Kind == SyntaxKind.EndOfFileToken)
            {
                root = new CompilationUnitSyntax(syntaxTree, ImmutableArray<MemberSyntax>.Empty, token);
                break;
            }

            tokens.Add(token);
        }

        syntaxTree.SetParseResult(
            root,
            lexer.Diagnostics.ToImmutableArray(),
            ImmutableArray<SyntaxToken>.Empty);
        diagnostics = syntaxTree.Diagnostics;
        return tokens.ToImmutableArray();
    }

    /// <summary>
    /// Gets the attached documentation text for a declaration node, or <see langword="null"/>
    /// when no documentation block is associated (ADR-0057 §7).
    /// </summary>
    /// <param name="node">The declaration syntax node.</param>
    /// <returns>The joined documentation block text, or <see langword="null"/>.</returns>
    internal string? GetDocumentation(SyntaxNode node)
    {
        if (documentationTable == null)
        {
            documentationTable = DocumentationAttacher.Attach(this);
        }

        return documentationTable.TryGetValue(node, out var doc) ? doc : null;
    }

    private void SetParseResult(
        CompilationUnitSyntax root,
        ImmutableArray<Diagnostic> diagnostics,
        ImmutableArray<SyntaxToken> documentationTokens)
    {
        Root = root;
        Diagnostics = diagnostics;
        DocumentationTokens = documentationTokens;
    }
}
