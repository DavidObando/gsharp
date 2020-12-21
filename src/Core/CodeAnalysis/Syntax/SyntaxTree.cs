// <copyright file="SyntaxTree.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    using System.Collections.Generic;
    using System.Collections.Immutable;
    using System.IO;
    using GSharp.Core.CodeAnalysis.Text;

    /// <summary>
    /// Represents the language's syntax tree.
    /// </summary>
    public class SyntaxTree
    {
        private SyntaxTree(SourceText text,  ParseHandler handler)
        {
            Text = text;
            handler(this, out var root, out var diagnostics);
            Root = root;
            Diagnostics = diagnostics;
        }

        private delegate void ParseHandler(
            SyntaxTree syntaxTree,
            out CompilationUnitSyntax root,
            out ImmutableArray<Diagnostic> diagnostics);

        /// <summary>
        /// Gets the source text.
        /// </summary>
        public SourceText Text { get; }

        /// <summary>
        /// Gets the diagnostics.
        /// </summary>
        public ImmutableArray<Diagnostic> Diagnostics { get; }

        /// <summary>
        /// Gets the compilation unit root.
        /// </summary>
        public CompilationUnitSyntax Root { get; }

        /// <summary>
        /// Parses the source text from the provided file path into a syntax tree.
        /// </summary>
        /// <param name="filePath">The source file path.</param>
        /// <returns>A parsed syntax tree.</returns>
        public static SyntaxTree Load(string filePath)
        {
            var text = File.ReadAllText(filePath);
            var sourceText = SourceText.From(text, filePath);
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
            static void Parse(SyntaxTree syntaxTree, out CompilationUnitSyntax root, out ImmutableArray<Diagnostic> diagnostics)
            {
                var parser = new Parser(syntaxTree);
                root = parser.ParseCompilationUnit();
                diagnostics = parser.Diagnostics.ToImmutableArray();
            }

            return new SyntaxTree(text, Parse);
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

            void ParseTokens(SyntaxTree st, out CompilationUnitSyntax root, out ImmutableArray<Diagnostic> d)
            {
                root = null;
                var l = new Lexer(st);
                while (true)
                {
                    var token = l.Lex();
                    if (token.Kind == SyntaxKind.EndOfFileToken)
                    {
                        root = new CompilationUnitSyntax(st, ImmutableArray<MemberSyntax>.Empty, token);
                        break;
                    }

                    tokens.Add(token);
                }

                d = l.Diagnostics.ToImmutableArray();
            }

            var syntaxTree = new SyntaxTree(text, ParseTokens);
            diagnostics = syntaxTree.Diagnostics;
            return tokens.ToImmutableArray();
        }
    }
}
