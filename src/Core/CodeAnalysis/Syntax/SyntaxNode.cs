// <copyright file="SyntaxNode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a syntax node in the language.
/// </summary>
public abstract class SyntaxNode
{
    // ponytail: nodes are immutable once handed back to the caller -- the parser's
    // few `{ get; set; }` properties (e.g. StructDeclarationSyntax.SharedBlock) are
    // only ever assigned right after `new X(...)`, before anyone reads .Span. So a
    // simple lazy cache is safe and turns Span from an O(subtree) walk into O(1)
    // amortized (each new wrapper node only re-scans its direct, already-cached
    // children). This is what kills the quadratic `*` chain parse (issue #1604).
    private TextSpan? cachedSpan;

    // ponytail: GetType().GetProperties() is uncached reflection, paid on every
    // GetChildren() call (i.e. every Span/Location access). One PropertyInfo[]
    // per concrete node type never changes, so cache it once per Type (issue #1604).
    private static readonly ConcurrentDictionary<Type, PropertyInfo[]> PropertyCache = new();

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
            if (cachedSpan != null)
            {
                return cachedSpan.Value;
            }

            // Compute the bounding span from min(start) and max(end) across all children, rather
            // than the first/last child in reflection order. The reflection-based enumeration in
            // GetChildren() returns properties in C# declaration order, which is not always the
            // source order: nodes that expose `{ get; set; }` properties assigned by the parser
            // after construction (e.g. StructDeclarationSyntax.SharedBlock) are enumerated after
            // the structural CloseBraceToken even though they sit inside the braces. Using
            // first/last in that case truncates the span and breaks position-based traversals
            // such as the language server's interpolated-string hole detection.
            var hasChild = false;
            var start = int.MaxValue;
            var end = int.MinValue;
            foreach (var child in GetChildren())
            {
                var childSpan = child.Span;
                if (childSpan.Start < start)
                {
                    start = childSpan.Start;
                }

                if (childSpan.End > end)
                {
                    end = childSpan.End;
                }

                hasChild = true;
            }

            var span = hasChild ? TextSpan.FromBounds(start, end) : new TextSpan(0, 0);
            cachedSpan = span;
            return span;
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
        var properties = PropertyCache.GetOrAdd(GetType(), static t => t.GetProperties(BindingFlags.Public | BindingFlags.Instance));

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
                if (separatedSyntaxList == null)
                {
                    continue;
                }

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
