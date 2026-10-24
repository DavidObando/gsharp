// <copyright file="SyntaxNode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
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

    /// Children array for a node whose child properties cannot be indexed in place. `null` means
    /// "not built yet". Published as one reference store, like (cref:cachedSpan).
    private var childrenBox ChildrenBox?

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
            let count = node.ChildCount
            for var i = count - 1; i >= 0; i-- {
                let child = node.GetChild(i)
                if !(child is SyntaxToken) {
                    pending.Push(child)
                }
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

    /// Gets the number of children of this syntax node. Every concrete node class overrides this
    /// in `SyntaxNode.Children.g.gs`, which `build/generate-syntax-children.py` writes (issue #5136).
    /// A class that the generator did not see, or a subclass of a generated open class, uses the
    /// reflection projection instead (cref:CachedChildren).
    internal open prop ChildCount int32 -> CachedChildren().Length

    /// Gets one child of this syntax node without allocating on the generated path.
    /// @param index The index of the child, from 0 to (cref:ChildCount) - 1.
    /// @returns The child at that index, in the order of (cref:GetChildren).
    internal open func GetChild(index int32) SyntaxNode -> ChildAt(CachedChildren(), index)

    /// Builds the children of this node as one array. The base implementation reads the public
    /// properties by reflection on the runtime type. A generated class overrides it when a
    /// property cannot be indexed in place, and guards the override by the exact runtime type.
    /// @returns The children in the order of (cref:GetChildren).
    internal open func BuildChildren() ImmutableArray[SyntaxNode] -> BuildChildrenByReflection()

    /// Returns the children array of this node, built once per node. The parser clears it through
    /// (cref:InvalidateCachedSpan) when it assigns a child-bearing property after construction.
    /// @returns The children.
    internal func CachedChildren() ImmutableArray[SyntaxNode] {
        let box = childrenBox
        if box != nil {
            return box.Items
        }
        let built = BuildChildren()
        CompilationMeasurements.Count("syntax.child-projections")
        childrenBox = ChildrenBox(built)
        return built
    }

    /// Builds the children by reflection over the public properties of the runtime type.
    /// @returns The children in the order of (cref:GetChildren).
    internal func BuildChildrenByReflection() ImmutableArray[SyntaxNode] {
        CompilationMeasurements.Count("syntax.child-reflection-fallbacks")
        return GetChildrenByReflection().ToImmutableArray()
    }

    /// Gets an enumeration of all the children of this syntax node.
    /// @returns An (cref:IEnumerable{SyntaxNode}) with the children of this syntax node.
    func GetChildren() sequence[SyntaxNode] {
        let count = ChildCount
        for var i = 0; i < count; i++ {
            yield GetChild(i)
        }
    }

    /// Enumerates the children by reflection over the public properties. A class marked with
    /// `@SyntaxChildSourceOrder` gets its children sorted by source position. This is the order
    /// and the content that the generated (cref:GetChild) must reproduce, so tests use it as the oracle.
    /// @returns The children of this syntax node.
    internal func GetChildrenByReflection() sequence[SyntaxNode] {
        if IsSourceOrdered(GetType()) {
            for child in SortBySourcePosition(EnumerateChildrenByProperty().ToImmutableArray()) {
                yield child
            }
        } else {
            for child in EnumerateChildrenByProperty() {
                yield child
            }
        }
    }

    private func EnumerateChildrenByProperty() sequence[SyntaxNode] {
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
        return GetChild(ChildCount - 1).GetLastToken()
    }

    /// Gets the first token in this syntax node.
    /// @returns A (cref:SyntaxToken).
    func GetFirstToken() SyntaxToken {
        if this is SyntaxToken token {
            return token
        }
        // A syntax node should always contain at least 1 token.
        return GetChild(0).GetFirstToken()
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
        childrenBox = nil
    }

    private func ComputeSpan() TextSpan {
        // Take the minimum start and the maximum end over all children. Children can overlap
        // even in source order: an interpolated string token contains its holes, and the parser
        // synthesizes tokens at the position of a real one (issue #5185). The first and last
        // child would give a truncated span and break position-based walks such as the language
        // server's interpolated-string hole detection (issue #5136).
        var hasChild = false
        var start = int32.MaxValue
        var end = int32.MinValue
        let count = ChildCount
        for var i = 0; i < count; i++ {
            var childSpan = GetChild(i).Span
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

    private class ChildrenBox {
        init(items ImmutableArray[SyntaxNode]) {
            Items = items
        }

        prop Items ImmutableArray[SyntaxNode] {
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
        /// Sorts children by the start of their span. The sort is stable, so children with the
        /// same start (for example a missing token) keep their property order. Issue #5185.
        /// @param items The children in property order.
        /// @returns The children in source order.
        internal func SortBySourcePosition(items ImmutableArray[SyntaxNode]) ImmutableArray[SyntaxNode] {
            return items.OrderBy((item SyntaxNode) -> item.Span.Start).ToImmutableArray()
        }

        /// Returns whether a node class, or one of its base classes, has `@SyntaxChildSourceOrder`.
        /// @param nodeType The runtime type of a node.
        /// @returns `true` when the children of the class are sorted by source position.
        internal func IsSourceOrdered(nodeType Type) bool {
            return SourceOrderedByType.GetOrAdd(
                nodeType,
                (type Type) -> Attribute.IsDefined(type, typeof(SyntaxChildSourceOrderAttribute), true)
            )
        }

        private let SourceOrderedByType ConcurrentDictionary[Type, bool] = ConcurrentDictionary[Type, bool]()

        /// Returns one element of a children array, with the argument check of the generated accessors.
        /// @param items The children.
        /// @param index The index.
        /// @returns The child.
        internal func ChildAt(items ImmutableArray[SyntaxNode], index int32) SyntaxNode {
            if index < 0 || index >= items.Length {
                throw ArgumentOutOfRangeException(nameof(index))
            }
            return items[index]
        }

        /// Returns whether an optional child is present. The generated child accessors use this for
        /// every single-node property.
        /// @param node The property value.
        /// @returns `true` when the value is not null.
        internal func IsPresent(node SyntaxNode?) bool -> node != nil

        /// Returns the number of nodes and separators of a separated list; a null list has none.
        /// @param list The property value.
        /// @returns The number of items.
        internal func SeparatedLength(list SeparatedSyntaxList?) int32 {
            return if list == nil {
                0
            } else {
                list.GetWithSeparators().Length
            }
        }

        /// Returns the nodes and separators of a separated list; a null list has none.
        /// @param list The property value.
        /// @returns The items in source order.
        internal func SeparatedItems(list SeparatedSyntaxList?) ImmutableArray[SyntaxNode] {
            return if list == nil {
                ImmutableArray[SyntaxNode].Empty
            } else {
                list.GetWithSeparators()
            }
        }

        /// Copies a computed sequence of child nodes. The generated accessors use this for
        /// properties that build the sequence on each read.
        /// @param items The property value.
        /// @returns The items without nulls.
        internal func EnumerableItems(items IEnumerable[SyntaxNode]?) ImmutableArray[SyntaxNode] {
            let builder = ImmutableArray.CreateBuilder[SyntaxNode]()
            if items != nil {
                for item in items {
                    if item != nil {
                        builder.Add(item)
                    }
                }
            }
            return builder.ToImmutable()
        }

        /// Returns the tokens of a list that allows absent entries, without the absent entries.
        /// @param tokens The property value.
        /// @returns The present tokens.
        internal func PresentTokens(tokens ImmutableArray[SyntaxToken?]) ImmutableArray[SyntaxNode] {
            let builder = ImmutableArray.CreateBuilder[SyntaxNode]()
            for token in tokens {
                if token != nil {
                    builder.Add(token)
                }
            }
            return builder.ToImmutable()
        }

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
