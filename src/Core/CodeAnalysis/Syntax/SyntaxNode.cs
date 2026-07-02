// <copyright file="SyntaxNode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a syntax node in the language.
/// </summary>
public abstract class SyntaxNode
{
    /// <summary>
    /// Cached, per-type child accessors used by <see cref="GetChildren"/>. Built once per
    /// concrete node type from <c>GetType().GetProperties()</c> so the enumeration order is
    /// identical to the historical reflection-based implementation (issue #1675), but each
    /// subsequent enumeration only pays for an array walk plus compiled delegate calls
    /// instead of a fresh <see cref="Type.GetProperties()"/> allocation and
    /// <see cref="PropertyInfo.GetValue(object)"/> per property.
    /// </summary>
    private static readonly ConcurrentDictionary<Type, ChildAccessor[]> ChildAccessorsByType = new();

    /// <summary>
    /// Lazily computed bounding span for this node, stored as a boxed <see cref="TextSpan"/> so
    /// that publication is a single atomic reference store (safe under concurrent first access).
    /// <c>null</c> means "not computed yet". Cleared by <see cref="InvalidateCachedSpan"/> when a
    /// parser-time mutation replaces a child-bearing property after construction.
    /// </summary>
    private object cachedSpan;

    /// <summary>
    /// Initializes a new instance of the <see cref="SyntaxNode"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    protected SyntaxNode(SyntaxTree syntaxTree)
    {
        SyntaxTree = syntaxTree;
    }

    private enum ChildAccessorKind
    {
        /// <summary>The property is a <see cref="SyntaxNode"/> (yielded directly when non-null).</summary>
        Node,

        /// <summary>The property is a <see cref="SeparatedSyntaxList"/> (expanded with separators).</summary>
        SeparatedList,

        /// <summary>The property is an <see cref="IEnumerable{T}"/> of <see cref="SyntaxNode"/> (each non-null item yielded).</summary>
        NodeList,
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
            // Nodes are immutable once the parser finishes building them, and every subtree walk
            // (diagnostics locations, PDB sequence points, the parser's own line checks) funnels
            // through this property, so the computed span is cached after the first access
            // (issue #1675). The few parser-time mutations of child-bearing properties clear the
            // cache through InvalidateCachedSpan().
            if (cachedSpan is TextSpan cached)
            {
                return cached;
            }

            var computed = ComputeSpan();
            cachedSpan = computed;
            return computed;
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
        var accessors = ChildAccessorsByType.GetOrAdd(GetType(), static type => BuildChildAccessors(type));

        foreach (var accessor in accessors)
        {
            switch (accessor.Kind)
            {
                case ChildAccessorKind.Node:
                    var child = (SyntaxNode)accessor.Getter(this);
                    if (child != null)
                    {
                        yield return child;
                    }

                    break;

                case ChildAccessorKind.SeparatedList:
                    var separatedSyntaxList = (SeparatedSyntaxList)accessor.Getter(this);
                    if (separatedSyntaxList == null)
                    {
                        break;
                    }

                    foreach (var listChild in separatedSyntaxList.GetWithSeparators())
                    {
                        yield return listChild;
                    }

                    break;

                case ChildAccessorKind.NodeList:
                    var children = (IEnumerable<SyntaxNode>)accessor.Getter(this);
                    foreach (var enumeratedChild in children)
                    {
                        if (enumeratedChild != null)
                        {
                            yield return enumeratedChild;
                        }
                    }

                    break;
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

    /// <summary>
    /// Enumerates the public instance properties of <paramref name="nodeType"/> that contribute
    /// children to <see cref="GetChildren"/>, in enumeration order. Exposed for tests that verify
    /// the cached accessors preserve the historical reflection order (issue #1675).
    /// </summary>
    /// <param name="nodeType">The concrete <see cref="SyntaxNode"/> type to inspect.</param>
    /// <returns>The child-bearing properties in the order <see cref="GetChildren"/> visits them.</returns>
    internal static PropertyInfo[] GetChildPropertiesInEnumerationOrder(Type nodeType)
    {
        var properties = nodeType.GetProperties(BindingFlags.Public | BindingFlags.Instance);
        var childProperties = new List<PropertyInfo>(properties.Length);
        foreach (var property in properties)
        {
            if (TryClassifyChildProperty(property, out _))
            {
                childProperties.Add(property);
            }
        }

        return childProperties.ToArray();
    }

    /// <summary>
    /// Invalidates the cached <see cref="Span"/> of this node. Must be called by every setter of
    /// a child-bearing property that the parser assigns after construction (for example
    /// <c>StructDeclarationSyntax.SharedBlock</c>), so a span computed before the mutation is
    /// never served afterwards. Parser mutations happen bottom-up before the node is embedded in
    /// a parent, so no ancestor can have cached a span that included this node yet.
    /// </summary>
    private protected void InvalidateCachedSpan()
    {
        cachedSpan = null;
    }

    private static ChildAccessor[] BuildChildAccessors(Type nodeType)
    {
        var childProperties = GetChildPropertiesInEnumerationOrder(nodeType);
        var accessors = new ChildAccessor[childProperties.Length];
        for (var i = 0; i < childProperties.Length; i++)
        {
            var property = childProperties[i];
            TryClassifyChildProperty(property, out var kind);

            // Compile `node => (object)((TNode)node).Property` once per (type, property). The
            // delegate performs the same virtual getter call PropertyInfo.GetValue used to make,
            // without the reflection overhead.
            var parameter = Expression.Parameter(typeof(SyntaxNode), "node");
            var getterBody = Expression.Convert(
                Expression.Property(Expression.Convert(parameter, nodeType), property),
                typeof(object));
            var getter = Expression.Lambda<Func<SyntaxNode, object>>(getterBody, parameter).Compile();
            accessors[i] = new ChildAccessor(kind, getter);
        }

        return accessors;
    }

    private static bool TryClassifyChildProperty(PropertyInfo property, out ChildAccessorKind kind)
    {
        // Keep the checks in the exact order of the historical reflection-based GetChildren so
        // that a property assignable to more than one category resolves the same way it used to.
        if (typeof(SyntaxNode).IsAssignableFrom(property.PropertyType))
        {
            kind = ChildAccessorKind.Node;
            return true;
        }

        if (typeof(SeparatedSyntaxList).IsAssignableFrom(property.PropertyType))
        {
            kind = ChildAccessorKind.SeparatedList;
            return true;
        }

        if (typeof(IEnumerable<SyntaxNode>).IsAssignableFrom(property.PropertyType))
        {
            kind = ChildAccessorKind.NodeList;
            return true;
        }

        kind = default;
        return false;
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

    private TextSpan ComputeSpan()
    {
        // Compute the bounding span from min(start) and max(end) across all children, rather
        // than the first/last child in reflection order. The property-based enumeration in
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

        return hasChild ? TextSpan.FromBounds(start, end) : new TextSpan(0, 0);
    }

    private readonly struct ChildAccessor
    {
        public ChildAccessor(ChildAccessorKind kind, Func<SyntaxNode, object> getter)
        {
            Kind = kind;
            Getter = getter;
        }

        public ChildAccessorKind Kind { get; }

        public Func<SyntaxNode, object> Getter { get; }
    }
}
