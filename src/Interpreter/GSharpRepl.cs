// <copyright file="GSharpRepl.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Interpreter
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using GSharp.Core.CodeAnalysis;
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Syntax;
    using GSharp.Core.CodeAnalysis.Text;
    using static GSharp.Core.CodeAnalysis.Text.TextSpan;

    /// <summary>
    /// Implements a GSharp-specific read-eval-print loop.
    /// </summary>
    public class GSharpRepl : Repl
    {
        private readonly Dictionary<VariableSymbol, object> variables = new Dictionary<VariableSymbol, object>();

        private Compilation previous;
        private bool showTree;
        private bool showProgram;

        private List<int> linesWithOpenMultilineComments = new List<int>();

        /// <inheritdoc/>
        protected override void RenderLine(string line, int lineNumber)
        {
            if (linesWithOpenMultilineComments.Contains(lineNumber))
            {
                linesWithOpenMultilineComments.Remove(lineNumber);
            }

            var isMultilineComment = linesWithOpenMultilineComments.Contains(lineNumber - 1);
            var tokens = SyntaxTree.ParseTokens(line);
            foreach (var token in tokens)
            {
                var isKeyword = token.Kind.ToString().EndsWith("Keyword");
                var isIdentifier = token.Kind == SyntaxKind.IdentifierToken;
                var isNumber = token.Kind == SyntaxKind.NumberToken;
                var isString = token.Kind == SyntaxKind.StringToken;
                var isComment = token.Kind == SyntaxKind.CommentToken;

                if (isKeyword)
                {
                    Console.ForegroundColor = ConsoleColor.Blue;
                }
                else if (isIdentifier)
                {
                    Console.ForegroundColor = ConsoleColor.DarkYellow;
                }
                else if (isNumber)
                {
                    Console.ForegroundColor = ConsoleColor.Cyan;
                }
                else if (isString)
                {
                    Console.ForegroundColor = ConsoleColor.Magenta;
                }
                else if (isComment)
                {
                    if (!linesWithOpenMultilineComments.Contains(lineNumber))
                    {
                        var openMultilineCommentIndex = line.IndexOf("/*");
                        var closeMultilineCommentIndex = line.IndexOf("*/");
                        if (openMultilineCommentIndex != -1 &&
                            (closeMultilineCommentIndex == -1 || closeMultilineCommentIndex < openMultilineCommentIndex))
                        {
                            linesWithOpenMultilineComments.Add(lineNumber);
                        }
                    }

                    Console.ForegroundColor = ConsoleColor.DarkGreen;
                }
                else
                {
                    Console.ForegroundColor = ConsoleColor.DarkGray;
                }

                if (isMultilineComment)
                {
                    if (!linesWithOpenMultilineComments.Contains(lineNumber))
                    {
                        var lastOpenMultilineCommentIndex = line.LastIndexOf("/*");
                        var lastCloseMultilineCommentIndex = line.LastIndexOf("*/");
                        if (lastCloseMultilineCommentIndex == -1 || (lastOpenMultilineCommentIndex > lastCloseMultilineCommentIndex))
                        {
                            linesWithOpenMultilineComments.Add(lineNumber);
                        }
                    }

                    var firstCloseMultilineCommentIndex = line.IndexOf("*/");
                    if (firstCloseMultilineCommentIndex == -1 || token.Position <= (firstCloseMultilineCommentIndex + 1))
                    {
                        Console.ForegroundColor = ConsoleColor.DarkGreen;
                    }
                }

                Console.Write(token.Text);

                Console.ResetColor();
            }
        }

        /// <inheritdoc/>
        protected override void EvaluateMetaCommand(string input)
        {
            switch (input)
            {
                case "#showTree":
                    showTree = !showTree;
                    Console.WriteLine(showTree ? "Showing parse trees." : "Not showing parse trees.");
                    break;
                case "#showProgram":
                    showProgram = !showProgram;
                    Console.WriteLine(showProgram ? "Showing bound tree." : "Not showing bound tree.");
                    break;
                case "#cls":
                    Console.Clear();
                    break;
                case "#reset":
                    previous = null;
                    variables.Clear();
                    break;
                default:
                    base.EvaluateMetaCommand(input);
                    break;
            }
        }

        /// <inheritdoc/>
        protected override bool IsCompleteSubmission(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return true;
            }

            var lastTwoLinesAreBlank = text.Split(Environment.NewLine)
                                           .Reverse()
                                           .TakeWhile(s => string.IsNullOrEmpty(s))
                                           .Take(2)
                                           .Count() == 2;
            if (lastTwoLinesAreBlank)
            {
                return true;
            }

            var syntaxTree = SyntaxTree.Parse(text);

            // Use Members because we need to exclude the EndOfFileToken.
            if (syntaxTree.Root.Members.Length == 0 ||
                syntaxTree.Root.Members.Last().GetLastToken().IsMissing)
            {
                return false;
            }

            return true;
        }

        /// <inheritdoc/>
        protected override void EvaluateSubmission(string text)
        {
            linesWithOpenMultilineComments.Clear();

            var syntaxTree = SyntaxTree.Parse(text);

            var compilation = previous == null
                                ? new Compilation(syntaxTree)
                                : previous.ContinueWith(syntaxTree);

            if (showTree)
            {
                syntaxTree.Root.WriteTo(Console.Out);
            }

            if (showProgram)
            {
                compilation.EmitTree(Console.Out);
            }

            var result = compilation.Evaluate(variables);

            if (!result.Diagnostics.Any())
            {
                if (result.Value != null)
                {
                    Console.ForegroundColor = ConsoleColor.White;
                    Console.WriteLine(result.Value);
                    Console.ResetColor();
                }

                previous = compilation;
            }
            else
            {
                foreach (var diagnostic in result.Diagnostics.OrderBy(diag => diag.Span, new TextSpanComparer()))
                {
                    var lineIndex = syntaxTree.Text.GetLineIndex(diagnostic.Span.Start);
                    var line = syntaxTree.Text.Lines[lineIndex];
                    var lineNumber = lineIndex + 1;
                    var character = diagnostic.Span.Start - line.Start + 1;

                    Console.WriteLine();

                    Console.ForegroundColor = ConsoleColor.DarkRed;
                    Console.Write($"({lineNumber}, {character}): ");
                    Console.WriteLine(diagnostic);
                    Console.ResetColor();

                    var prefixSpan = TextSpan.FromBounds(line.Start, diagnostic.Span.Start);
                    var suffixSpan = TextSpan.FromBounds(diagnostic.Span.End, line.End);

                    var prefix = syntaxTree.Text.ToString(prefixSpan);
                    var error = syntaxTree.Text.ToString(diagnostic.Span);
                    var suffix = syntaxTree.Text.ToString(suffixSpan);

                    Console.Write("    ");
                    Console.Write(prefix);

                    Console.ForegroundColor = ConsoleColor.DarkRed;
                    Console.Write(error);
                    Console.ResetColor();

                    Console.Write(suffix);

                    Console.WriteLine();
                }

                Console.WriteLine();
            }
        }
    }
}
