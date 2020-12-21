// <copyright file="SyntaxNode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Reflection;
    using GSharp.Core.CodeAnalysis.Text;

    /// <summary>
    /// Represents a syntax node in the language.
    /// </summary>
    public abstract class SyntaxNode
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="SyntaxNode"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        protected SyntaxNode(SyntaxTree syntaxTree)
        {
            SyntaxTree = syntaxTree;
        }

        /// <summary>
        /// Gets the kind of syntax of this type.
        /// </summary>
        public abstract SyntaxKind Kind { get; }

        /// <summary>
        /// Gets the text span covered by this syntax node.
        /// </summary>
        public virtual TextSpan Span
        {
            get
            {
                var first = GetChildren().First().Span;
                var last = GetChildren().Last().Span;
                return TextSpan.FromBounds(first.Start, last.End);
            }
        }

        /// <summary>
        /// Gets the location of this syntax node.
        /// </summary>
        public virtual TextLocation Location => new TextLocation(SyntaxTree.Text, Span);

        /// <summary>
        /// Gets the parent syntax tree for this syntax node.
        /// </summary>
        public SyntaxTree SyntaxTree { get; }

        /// <summary>
        /// Gets an enumeration of all the children of this syntax node.
        /// </summary>
        /// <returns>An <see cref="IEnumerable{SyntaxNode}"/> with the children of this syntax node.</returns>
        public IEnumerable<SyntaxNode> GetChildren()
        {
            var properties = GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance);

            foreach (var property in properties)
            {
                if (typeof(SyntaxNode).IsAssignableFrom(property.PropertyType))
                {
                    var child = (SyntaxNode)property.GetValue(this);
                    if (child != null)
                    {
                        yield return child;
                    }
                }
                else if (typeof(SeparatedSyntaxList).IsAssignableFrom(property.PropertyType))
                {
                    var separatedSyntaxList = (SeparatedSyntaxList)property.GetValue(this);
                    foreach (var child in separatedSyntaxList.GetWithSeparators())
                    {
                        yield return child;
                    }
                }
                else if (typeof(IEnumerable<SyntaxNode>).IsAssignableFrom(property.PropertyType))
                {
                    var children = (IEnumerable<SyntaxNode>)property.GetValue(this);
                    foreach (var child in children)
                    {
                        if (child != null)
                        {
                            yield return child;
                        }
                    }
                }
            }
        }

        /// <summary>
        /// Gets the last token in this syntax node.
        /// </summary>
        /// <returns>A <see cref="SyntaxToken"/>.</returns>
        public SyntaxToken GetLastToken()
        {
            if (this is SyntaxToken token)
            {
                return token;
            }

            // A syntax node should always contain at least 1 token.
            return GetChildren().Last().GetLastToken();
        }

        /// <inheritdoc/>
        public override string ToString()
        {
            using (var writer = new StringWriter())
            {
                WriteTo(writer);
                return writer.ToString();
            }
        }

        /// <summary>
        /// Writes this syntax node to the specified text writer.
        /// </summary>
        /// <param name="writer">The writer to write to.</param>
        public void WriteTo(TextWriter writer)
        {
            PrettyPrint(writer, this);
        }

        private static void PrettyPrint(TextWriter writer, SyntaxNode node, string indent = "", bool isLast = true)
        {
            var isToConsole = writer == Console.Out;
            var marker = isLast ? "└──" : "├──";

            if (isToConsole)
            {
                Console.ForegroundColor = ConsoleColor.DarkGray;
            }

            writer.Write(indent);
            writer.Write(marker);

            if (isToConsole)
            {
                Console.ForegroundColor = node is SyntaxToken ? ConsoleColor.Blue : ConsoleColor.Cyan;
            }

            writer.Write(node.Kind);

            if (node is SyntaxToken t && t.Value != null)
            {
                writer.Write(" ");
                writer.Write(t.Value);
            }

            if (isToConsole)
            {
                Console.ResetColor();
            }

            writer.WriteLine();

            indent += isLast ? "   " : "│  ";

            var lastChild = node.GetChildren().LastOrDefault();

            foreach (var child in node.GetChildren())
            {
                PrettyPrint(writer, child, indent, child == lastChild);
            }
        }
    }
}
