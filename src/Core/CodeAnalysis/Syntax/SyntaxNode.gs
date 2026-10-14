// <copyright file="SyntaxNode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.IO
import System.Linq
import System.Linq.Expressions
import System.Reflection

/// Represents a syntax node in the language.
abstract class SyntaxNode {
    /// Lazily computed bounding span for this node, stored as a boxed (cref:TextSpan) so
    /// that publication is a single atomic reference store (safe under concurrent first access).
    /// `null` means "not computed yet". Cleared by (cref:InvalidateCachedSpan) when a
    /// parser-time mutation replaces a child-bearing property after construction.
    private var cachedSpan SpanBox?

    /// Initializes a new instance of the (cref:SyntaxNode) class.
    /// @param syntaxTree The parent syntax tree.
    protected init(syntaxTree SyntaxTree) {
        SyntaxTree = syntaxTree
    }

    private enum ChildAccessorKind {
        Node,
        SeparatedList,
        NodeList
    }

    /// Gets the kind of syntax of this type.
    abstract prop Kind SyntaxKind {
        get;
    }

    /// Gets the text span covered by this syntax node.
    open prop Span TextSpan {
        get {
            // Nodes are immutable once the parser finishes building them, and every subtree walk
            // (diagnostics locations, PDB sequence points, the parser's own line checks) funnels
            // through this property, so the computed span is cached after the first access
            // (issue #1675). The few parser-time mutations of child-bearing properties clear the
            // cache through InvalidateCachedSpan().
            if cachedSpan != nil {
                return cachedSpan!!.Value
            }
            let computed = ComputeSpan()
            cachedSpan = SpanBox(computed)
            return computed
        }
    }

    /// Gets the location of this syntax node.
    open prop Location TextLocation -> TextLocation(SyntaxTree.Text, Span)

    /// Gets the parent syntax tree for this syntax node.
    prop SyntaxTree SyntaxTree {
        get;
    }

    /// Gets the parent node, or `null` for the root.
    /// Backed by the tree's lazily built parent index (ADR-0169) — the
    /// Roslyn `SyntaxNode.Parent` analogue analyzers rely on.
    @SyntaxChildIgnore
    prop Parent SyntaxNode? -> SyntaxTree.GetParent(this)

    /// Returns this node or its nearest ancestor of type
    /// `T`, or `null` when none exists —
    /// the Roslyn `FirstAncestorOrSelf` analogue analyzers rely on
    /// (ADR-0169).
    /// @typeparam T The node type to find.
    /// @returns The nearest matching node, or null.
    func FirstAncestorOrSelf[T SyntaxNode]() T? {
        for var node SyntaxNode? = this; node != nil; node = node!!.Parent {
            if node is T match {
                return match
            }
        }
        return nil
    }

    /// Enumerates the ancestors of this node, nearest first — the Roslyn
    /// `Ancestors` analogue (ADR-0169).
    /// @returns The ancestor nodes.
    func Ancestors() sequence[SyntaxNode] {
        for var node SyntaxNode? = Parent; node != nil; node = node!!.Parent {
            yield node
        }
    }

    /// Enumerates this node and its descendants in document order (tokens
    /// excluded) — the Roslyn `DescendantNodesAndSelf` analogue
    /// (ADR-0169).
    /// @returns This node followed by its descendant nodes.
    func DescendantNodesAndSelf() sequence[SyntaxNode] {
        let pending = Stack[SyntaxNode]()
        pending.Push(this)
        while pending.Count > 0 {
            let node = pending.Pop()
            yield node
            // Push in reverse so children pop in GetChildren() order.
            let children = List[SyntaxNode]()
            for child in node.GetChildren() {
                if !(child is SyntaxToken) {
                    children.Add(child)
                }
            }
            for var i = children.Count - 1; i >= 0; i-- {
                pending.Push(children[i])
            }
        }
    }

    /// Enumerates the descendants of this node in document order (tokens
    /// excluded) — the Roslyn `DescendantNodes` analogue (ADR-0169).
    /// @returns The descendant nodes.
    func DescendantNodes() sequence[SyntaxNode] {
        for node in DescendantNodesAndSelf() {
            if !object.ReferenceEquals(node, this) {
                yield node
            }
        }
    }

    /// Gets an enumeration of all the children of this syntax node.
    /// @returns An (cref:IEnumerable{SyntaxNode}) with the children of this syntax node.
    func GetChildren() sequence[SyntaxNode] {
        let accessors = ChildAccessorsByType.GetOrAdd(GetType(), (type Type) -> BuildChildAccessors(type))
        for accessor in accessors {
            // Kind comes from the property's static type, so a failed `as`
            // here can only represent a legitimate null child/list value.
            switch accessor.Kind {
                case ChildAccessorKind.Node {
                    let child SyntaxNode? = accessor.Getter(this) as SyntaxNode
                    if child != nil {
                        yield child
                    }
                }
                case ChildAccessorKind.SeparatedList {
                    let separatedSyntaxList SeparatedSyntaxList? = accessor.Getter(this) as SeparatedSyntaxList
                    if separatedSyntaxList == nil {
                        break
                    }
                    for listChild in separatedSyntaxList.GetWithSeparators() {
                        yield listChild
                    }
                }
                case ChildAccessorKind.NodeList {
                    let children IEnumerable[SyntaxNode]? = accessor.Getter(this) as IEnumerable[SyntaxNode]
                    if children == nil {
                        break
                    }
                    for enumeratedChild in children {
                        if enumeratedChild != nil {
                            yield enumeratedChild
                        }
                    }
                }
            }
        }
    }

    /// Gets the last token in this syntax node.
    /// @returns A (cref:SyntaxToken).
    func GetLastToken() SyntaxToken {
        if this is SyntaxToken token {
            return token
        }
        // A syntax node should always contain at least 1 token.
        return GetChildren().Last().GetLastToken()
    }

    /// Gets the first token in this syntax node.
    /// @returns A (cref:SyntaxToken).
    func GetFirstToken() SyntaxToken {
        if this is SyntaxToken token {
            return token
        }
        // A syntax node should always contain at least 1 token.
        return GetChildren().First().GetFirstToken()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override func ToString() string {
        {
            using let writer = StringWriter()
            WriteTo(writer)
            return writer.ToString()
        }
    }

    /// Writes this syntax node to the specified text writer.
    /// @param writer The writer to write to.
    func WriteTo(writer TextWriter) {
        PrettyPrint(writer, this)
    }

    /// Invalidates the cached (cref:Span) of this node. Must be called by every setter of
    /// a child-bearing property that the parser assigns after construction (for example
    /// `StructDeclarationSyntax.SharedBlock`), so a span computed before the mutation is
    /// never served afterwards. Parser mutations happen bottom-up before the node is embedded in
    /// a parent, so no ancestor can have cached a span that included this node yet.
    internal func InvalidateCachedSpan() {
        cachedSpan = nil
    }

    private func ComputeSpan() TextSpan {
        // Compute the bounding span from min(start) and max(end) across all children, rather
        // than the first/last child in reflection order. The property-based enumeration in
        // GetChildren() returns properties in C# declaration order, which is not always the
        // source order: nodes that expose `{ get; set; }` properties assigned by the parser
        // after construction (e.g. StructDeclarationSyntax.SharedBlock) are enumerated after
        // the structural CloseBraceToken even though they sit inside the braces. Using
        // first/last in that case truncates the span and breaks position-based traversals
        // such as the language server's interpolated-string hole detection.
        var hasChild = false
        var start = int32.MaxValue
        var end = int32.MinValue
        for child in GetChildren() {
            var childSpan = child.Span
            if childSpan.Start < start {
                start = childSpan.Start
            }
            if childSpan.End > end {
                end = childSpan.End
            }
            hasChild = true
        }
        return if hasChild {
            TextSpan.FromBounds(start, end)
        } else {
            TextSpan(0, 0)
        }
    }

    private struct ChildAccessor {
        init(kind ChildAccessorKind, getter(SyntaxNode) -> object) {
            Kind = kind
            Getter = getter
        }

        prop Kind ChildAccessorKind {
            get;
        }

        prop Getter(SyntaxNode) -> object {
            get;
        }
    }

    private class SpanBox {
        init(value TextSpan) {
            Value = value
        }

        prop Value TextSpan {
            get;
        }
    }

    shared {
        // ponytail: nodes are immutable once handed back to the caller -- the parser's
        // few `{ get; set; }` properties (e.g. StructDeclarationSyntax.SharedBlock) are
        // only ever assigned right after `new X(...)`, before anyone reads .Span. So a
        // simple lazy cache is safe and turns Span from an O(subtree) walk into O(1)
        // amortized (each new wrapper node only re-scans its direct, already-cached
        // children). This is what kills the quadratic `*` chain parse (issue #1604).
        //
        // ponytail: the LSP parses/analyzes in parallel, so first-read of .Span can
        // race across threads. The cache is published as a single boxed reference store
        // below (see cachedSpan), which is atomic and needs no separate "computed" flag.
        /// Cached, per-type child accessors used by (cref:GetChildren). Built once per
        /// concrete node type from `GetType().GetProperties()` so the enumeration order is
        /// identical to the historical reflection-based implementation (issue #1675), but each
        /// subsequent enumeration only pays for an array walk plus compiled delegate calls
        /// instead of a fresh (cref:Type.GetProperties()) allocation and
        /// (cref:PropertyInfo.GetValue(object)) per property.
        private let ChildAccessorsByType ConcurrentDictionary[Type, []ChildAccessor] = ConcurrentDictionary[
            Type,
            []ChildAccessor
        ]()

        /// Enumerates the public instance properties of [`nodeType`](paramref) that contribute
        /// children to (cref:GetChildren), in enumeration order. Exposed for tests that verify
        /// the cached accessors preserve the historical reflection order (issue #1675).
        /// @param nodeType The concrete (cref:SyntaxNode) type to inspect.
        /// @returns The child-bearing properties in the order (cref:GetChildren) visits them.
        internal func GetChildPropertiesInEnumerationOrder(nodeType Type)[]PropertyInfo {
            let properties = nodeType.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            let childProperties = List[PropertyInfo](properties.Length)
            for property in properties {
                if property.GetCustomAttribute[SyntaxChildIgnoreAttribute]() == nil &&
                    TryClassifyChildProperty(property, out _) {
                    childProperties.Add(property)
                }
            }
            return childProperties.ToArray()
        }

        private func BuildChildAccessors(nodeType Type)[]ChildAccessor {
            let childProperties = GetChildPropertiesInEnumerationOrder(nodeType)
            let accessors = [childProperties.Length]ChildAccessor
            for var i = 0; i < childProperties.Length; i++ {
                let property = childProperties[i]
                TryClassifyChildProperty(property, out var kind)
                // Compile `node => (object)((TNode)node).Property` once per (type, property). The
                // delegate performs the same virtual getter call PropertyInfo.GetValue used to make,
                // without the reflection overhead.
                let parameter = Expression.Parameter(typeof(SyntaxNode), "node")
                let getterBody = Expression.Convert(
                    Expression.Property(Expression.Convert(parameter, nodeType), property),
                    typeof(object)
                )
                let getter = Expression.Lambda[(SyntaxNode) -> object](getterBody, parameter).Compile()
                accessors[i] = ChildAccessor(kind, getter)
            }
            return accessors
        }

        private func TryClassifyChildProperty(property PropertyInfo, out kind ChildAccessorKind) bool {
            // Keep the checks in the exact order of the historical reflection-based GetChildren so
            // that a property assignable to more than one category resolves the same way it used to.
            if typeof(SyntaxNode).IsAssignableFrom(property.PropertyType) {
                kind = ChildAccessorKind.Node
                return true
            }
            if typeof(SeparatedSyntaxList).IsAssignableFrom(property.PropertyType) {
                kind = ChildAccessorKind.SeparatedList
                return true
            }
            if typeof(IEnumerable[SyntaxNode]).IsAssignableFrom(property.PropertyType) {
                kind = ChildAccessorKind.NodeList
                return true
            }
            kind = default(ChildAccessorKind)
            return false
        }

        private func PrettyPrint(writer TextWriter, node SyntaxNode, indent string = "", isLast bool = true) {
            var indent = indent
            let isToConsole = writer == Console.Out
            let marker = if isLast {
                "└──"
            } else {
                "├──"
            }
            if isToConsole {
                Console.ForegroundColor = ConsoleColor.DarkGray
            }
            writer.Write(indent)
            writer.Write(marker)
            if isToConsole {
                Console.ForegroundColor = if node is SyntaxToken {
                    ConsoleColor.Blue
                } else {
                    ConsoleColor.Cyan
                }
            }
            writer.Write(node.Kind)
            if node is SyntaxToken t && t.Value != nil {
                writer.Write(" ")
                writer.Write(t.Value)
            }
            if isToConsole {
                Console.ResetColor()
            }
            writer.WriteLine()
            indent += if isLast {
                "   "
            } else {
                "│  "
            }
            let lastChild = node.GetChildren().LastOrDefault()
            for child in node.GetChildren() {
                PrettyPrint(writer, child, indent, child == lastChild)
            }
        }
    }
}
