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
        private SyntaxTree(SourceText text)
        {
            var parser = new Parser(text);
            var root = parser.ParseCompilationUnit();

            Text = text;
            Diagnostics = parser.Diagnostics.ToImmutableArray();
            Root = root;
        }

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
            return new SyntaxTree(text);
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
            IEnumerable<SyntaxToken> LexTokens(Lexer lexer)
            {
                while (true)
                {
                    var token = lexer.Lex();
                    if (token.Kind == SyntaxKind.EndOfFileToken)
                    {
                        break;
                    }

                    yield return token;
                }
            }

            var l = new Lexer(text);
            var result = LexTokens(l).ToImmutableArray();
            diagnostics = l.Diagnostics.ToImmutableArray();
            return result;
        }
    }
}
