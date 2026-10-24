// <copyright file="SemanticModel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Linq
import System.Reflection
import System.Threading

/// Per-tree semantic queries over a bound compilation: syntax → symbol,
/// syntax → bound node, and syntax → type resolution (ADR-0169). Obtained via
/// (cref:Compilation.Compilation.GetSemanticModel(SyntaxTree)); the
/// underlying (cref:Binding.BoundProgram) is the compilation's cached
/// instance, so constructing a model never re-binds.
partial class SemanticModel {
    private let compilation Compilation
    private let syntaxTree SyntaxTree
    private let index Lazy[SemanticModel.Index]

    internal init(compilation Compilation, syntaxTree SyntaxTree) {
        this.compilation = compilation
        this.syntaxTree = syntaxTree
        index = Lazy[SemanticModel.Index](
            () -> BuildIndex(compilation, syntaxTree),
            LazyThreadSafetyMode.ExecutionAndPublication
        )
    }

    /// Gets the compilation this model answers queries against.
    prop Compilation Compilation -> compilation

    /// Gets the syntax tree this model covers.
    prop SyntaxTree SyntaxTree -> syntaxTree

    /// Returns the outermost bound node produced from [`node`](paramref),
    /// or `null` when the node has no bound counterpart —
    /// tokens, type clauses, nodes inside unbound declarations, and nodes the
    /// binder does not anchor (it threads (cref:BoundNode.Syntax) onto
    /// statements and the expressions diagnostics need, not onto every
    /// expression).
    /// @param node The syntax node to look up.
    /// @param cancellationToken Cancels index construction on first use.
    /// @returns The bound node, or null.
    func GetBoundNode(node SyntaxNode, cancellationToken CancellationToken = default(CancellationToken)) BoundNode? {
        cancellationToken.ThrowIfCancellationRequested()
        if index.Value.BoundBySyntax.TryGetValue(node, out var bound) {
            return PublicCompletionView(bound)
        }
        // A qualified call is split across two syntax nodes in G#: the whole
        // `Receiver.Callee(args)` is an AccessorExpressionSyntax and the binder
        // anchors the call there, while `Callee(args)` is a nested
        // CallExpressionSyntax with no anchor of its own. An unqualified call
        // has no such split, so without this an analyzer that walks for calls
        // (the only way to find one -- there is no "invocation" node covering
        // both shapes) resolves the unqualified ones and silently gets nothing
        // for the qualified ones. Roslyn has one InvocationExpressionSyntax for
        // both, so a faithful surface answers for the call node in both shapes.
        // Miss-only, so a node the binder does anchor keeps its own answer.
        if node is CallExpressionSyntax && node.Parent is AccessorExpressionSyntax accessor && object.ReferenceEquals(
            accessor.RightPart,
            node
        ) &&
            index
            .Value
            .BoundBySyntax
            .TryGetValue(accessor, out var qualified) {
            return PublicCompletionView(qualified)
        }
        // Source-call producers anchor the genuine call before lowering. Keep
        // the established qualified-expression query as the same call-shape
        // alias, without replacing an existing outer conversion/flow anchor.
        if node is AccessorExpressionSyntax qualifiedSyntax {
            var terminal ExpressionSyntax = qualifiedSyntax.RightPart
            while terminal is AccessorExpressionSyntax segment {
                terminal = segment.RightPart
            }
            if terminal is CallExpressionSyntax && index.Value.BoundBySyntax.TryGetValue(terminal, out var namedCall) {
                return PublicCompletionView(namedCall)
            }
        }
        return nil
    }

    private func PublicCompletionView(bound BoundNode) BoundNode {
        var current = bound
        while current is BoundExpression operand &&
            index
            .Value
            .LogicalCompletions
            .TryGetValue(operand, out var completion) &&
            completion != nil {
            current = completion
        }
        return current
    }

    /// Returns the symbol declared by [`node`](paramref) — the
    /// counterpart of Roslyn's `GetDeclaredSymbol`. Covers functions,
    /// structs, interfaces, enums, delegates, properties, globals, parameters,
    /// and locals whose declaration lives in this tree.
    /// @param node The declaration syntax node.
    /// @param cancellationToken Cancels index construction on first use.
    /// @returns The declared symbol, or null when the node declares nothing.
    func GetDeclaredSymbol(node SyntaxNode, cancellationToken CancellationToken = default(CancellationToken)) Symbol? {
        cancellationToken.ThrowIfCancellationRequested()
        return if index.Value.DeclaredBySyntax.TryGetValue(node, out var symbol) {
            symbol
        } else {
            default(Symbol?)
        }
    }

    /// Returns the symbol referenced by [`node`](paramref) — the
    /// counterpart of Roslyn's `GetSymbolInfo`: the invoked function of a
    /// call, the variable of a name expression, the member of an access, and
    /// so on. Implicit conversion wrappers sharing the node's syntax are
    /// unwrapped, and a parenthesized node answers for its operand (ADR-0212).
    /// @remarks The query answers what a bound node means, not only the first
    /// symbol it holds: the field or enum member behind a constant-folded
    /// literal, the property behind an auto-property backing-field read (at the
    /// constructed receiver's signature), and the type behind a static
    /// qualifier whose read the binder folded. An identifier token answers the
    /// symbol it declares or names; a name that differs from the token text, and
    /// a field-like event's backing field, answer nothing.
    /// @param node The syntax node to resolve.
    /// @param cancellationToken Cancels index construction on first use.
    /// @returns The resolution result; (cref:SymbolInfo.Symbol) is null when nothing is referenced.
    func GetSymbolInfo(node SyntaxNode, cancellationToken CancellationToken = default(CancellationToken)) SymbolInfo {
        if node is SyntaxToken{Kind: SyntaxKind.IdentifierToken} token {
            return SymbolInfo(GetTokenSymbol(token))
        }
        var target SyntaxNode = node
        while target is ParenthesizedExpressionSyntax parenthesized {
            target = parenthesized.Expression
        }
        var bound BoundNode? = GetBoundNode(target, cancellationToken)
        for var depth = 0; depth < 16; depth++ {
            if bound is not{} current {
                break
            }
            if current is BoundExpression{LogicalCompletionOperand: {} operand} {
                bound = operand
                continue
            }
            if current is BoundExpression expression &&
                (
                current is BoundLiteralExpression ||
                    current is BoundFieldAccessExpression ||
                    current is BoundPropertyAccessExpression
            ) &&
                ReferencedSourceSymbol(expression) is {} widened {
                return SymbolInfo(widened)
            }
            let accessors = GetAccessors(current.GetType())
            for getter in accessors.SymbolProperties {
                if (getter(current) is Symbol symbol and not TypeSymbol) {
                    return SymbolInfo(symbol)
                }
            }
            // No directly referenced symbol here — unwrap a same-syntax child
            // (e.g. an implicit BoundConversionExpression wrapper) and retry.
            // "Same syntax" is measured against the bound node's own syntax,
            // not the queried node: a qualified call is queried through its
            // nested CallExpressionSyntax while every bound node in the wrapper
            // chain carries the enclosing AccessorExpressionSyntax.
            var sameSyntaxChild BoundNode? = nil
            let boundSyntax = current.Syntax ?? target
            for getter in accessors.BoundNodeProperties {
                if getter(current) is BoundNode child && object.ReferenceEquals(child.Syntax, boundSyntax) {
                    sameSyntaxChild = child
                    break
                }
            }
            bound = sameSyntaxChild
        }
        // A static qualifier has no bound node of its own once the binder folds
        // the read; the folded read records the type the qualifier named.
        if index.Value.StaticQualifierTypes.TryGetValue(target, out var qualifierType) && qualifierType != nil {
            return SymbolInfo(qualifierType)
        }
        return SymbolInfo.None
    }

    /// Returns the type of the expression at [`node`](paramref) — the
    /// counterpart of Roslyn's `GetTypeInfo`. The outermost bound node's
    /// type is reported, so implicit conversions yield the converted type.
    /// @param node The syntax node to resolve.
    /// @param cancellationToken Cancels index construction on first use.
    /// @returns The resolution result; (cref:TypeInfo.Type) is null for non-expressions.
    func GetTypeInfo(node SyntaxNode, cancellationToken CancellationToken = default(CancellationToken)) TypeInfo {
        return if GetBoundNode(node, cancellationToken) is BoundExpression expression {
            TypeInfo(expression.Type)
        } else {
            TypeInfo.None
        }
    }

    /// Reads the actual binder's closed type-receiver decision at an original
    /// member boundary. No scope rebuilding, member reselection or AST adaptation.
    internal func TryGetStaticTypeQualifier(
        root AccessorExpressionSyntax,
        member ExpressionSyntax,
        out type TypeSymbol?,
        out qualifier ExpressionSyntax?,
        out read BoundExpression?
    ) bool {
        type = nil
        qualifier = nil
        read = nil
        if !object.ReferenceEquals(root.SyntaxTree, syntaxTree) || !object.ReferenceEquals(
            member.SyntaxTree,
            syntaxTree
        ) {
            return false
        }
        var current SyntaxNode = member
        while !object.ReferenceEquals(current, root) {
            if current.Parent is AccessorExpressionSyntax accessor &&
                (
                object.ReferenceEquals(accessor.LeftPart, current) || object.ReferenceEquals(
                    accessor.RightPart,
                    current
                )
            ) {
                current = accessor
            } else if current.Parent is IndexExpressionSyntax parentIndex && object.ReferenceEquals(
                parentIndex.Target,
                current
            ) {
                current = parentIndex
            } else {
                return false
            }
        }
        if !index
            .Value
            .StaticQualifierReads
            .TryGetValue(member, out var selected) ||
            selected == nil ||
            selected.StaticQualifierType == nil ||
            selected.StaticQualifierSyntax == nil {
            return false
        }
        type = selected.StaticQualifierType
        qualifier = selected.StaticQualifierSyntax
        read = selected
        return true
    }

    private data class BoundNodeAccessors(
        SymbolProperties[](BoundNode) -> object?,
        BoundNodeProperties[](BoundNode) -> object?
    ) : IEquatable[BoundNodeAccessors] { }

    private data class Index(
        BoundBySyntax Dictionary[SyntaxNode, BoundNode],
        DeclaredBySyntax Dictionary[SyntaxNode, Symbol],
        StaticQualifierReads Dictionary[SyntaxNode, BoundExpression?],
        LogicalCompletions Dictionary[BoundExpression, BoundExpression?],
        StaticQualifierTypes Dictionary[SyntaxNode, TypeSymbol?]
    ) : IEquatable[SemanticModel.Index] { }

    /// Records the outermost bound node per syntax node (first-win in a
    /// pre-order walk) and harvests local/pattern variable declarations from
    /// symbol-valued bound-node properties.
    private class IndexingWalker : BoundTreeWalker {
        private let tree SyntaxTree
        private let boundBySyntax Dictionary[SyntaxNode, BoundNode]
        private let declaredBySyntax Dictionary[SyntaxNode, Symbol]
        private let staticQualifierReads Dictionary[SyntaxNode, BoundExpression?]
        private let logicalCompletions Dictionary[BoundExpression, BoundExpression?]
        private let staticQualifierTypes Dictionary[SyntaxNode, TypeSymbol?]

        init(
            tree SyntaxTree,
            boundBySyntax Dictionary[SyntaxNode, BoundNode],
            declaredBySyntax Dictionary[SyntaxNode, Symbol],
            staticQualifierReads Dictionary[SyntaxNode, BoundExpression?],
            logicalCompletions Dictionary[BoundExpression, BoundExpression?],
            staticQualifierTypes Dictionary[SyntaxNode, TypeSymbol?]
        ) {
            this.tree = tree
            this.boundBySyntax = boundBySyntax
            this.declaredBySyntax = declaredBySyntax
            this.staticQualifierReads = staticQualifierReads
            this.logicalCompletions = logicalCompletions
            this.staticQualifierTypes = staticQualifierTypes
        }

        override func Visit(node BoundNode?) {
            Record(node)
            base.Visit(node)
        }

        override func VisitStatement(node BoundStatement?) {
            Record(node)
            base.VisitStatement(node)
        }

        override func VisitExpression(node BoundExpression?) {
            Record(node)
            base.VisitExpression(node)
        }

        override func VisitPattern(node BoundPattern?) {
            Record(node)
            base.VisitPattern(node)
        }

        private func Record(node BoundNode?) {
            if node == nil {
                return
            }
            if node.Syntax is {} syntax && object.ReferenceEquals(syntax.SyntaxTree, tree) &&
                !boundBySyntax.ContainsKey(syntax) {
                boundBySyntax.Add(syntax, node)
            }
            if node is BoundExpression{LogicalCompletionOperand: {} operand} completion &&
                operand.Syntax is {} origin &&
                object
                .ReferenceEquals(origin.SyntaxTree, tree) {
                if !logicalCompletions.TryGetValue(operand, out var existingCompletion) {
                    logicalCompletions.Add(operand, completion)
                } else if !object.ReferenceEquals(existingCompletion, completion) {
                    logicalCompletions[operand] = nil
                }
            }
            if node is BoundExpression{StaticMemberSyntax: {} member, StaticQualifierType: not nil} expression &&
                object
                .ReferenceEquals(member.SyntaxTree, tree) {
                if !staticQualifierReads.TryGetValue(member, out var existing) {
                    staticQualifierReads.Add(member, expression)
                } else if !object.ReferenceEquals(existing, expression) {
                    // Multiple distinct reads for one boundary are not authority.
                    staticQualifierReads[member] = nil
                }
            }
            if node is BoundExpression{StaticQualifierSyntax: {} qualifier, StaticQualifierType: {} qualifierType} &&
                object
                .ReferenceEquals(qualifier.SyntaxTree, tree) {
                if !staticQualifierTypes.TryGetValue(qualifier, out var existingType) {
                    staticQualifierTypes.Add(qualifier, qualifierType)
                } else if !object.ReferenceEquals(existingType, qualifierType) {
                    // Reads that disagree on the qualifier's type are not authority.
                    staticQualifierTypes[qualifier] = nil
                }
            }
            for getter in SemanticModel.GetAccessors(node.GetType()).SymbolProperties {
                if getter(node) is Symbol symbol {
                    SemanticModel.RecordDeclarations(symbol, tree, declaredBySyntax)
                }
            }
        }
    }

    shared {
        /// Cached, per-bound-node-type accessors for public instance properties
        /// whose values are (cref:Symbol)s or nested (cref:BoundNode)s.
        /// Mirrors the cached child-accessor pattern used by
        /// (cref:SyntaxNode.GetChildren).
        private let AccessorCache ConcurrentDictionary[Type, BoundNodeAccessors] = ConcurrentDictionary[
            Type,
            BoundNodeAccessors
        ]()

        private func BuildIndex(compilation Compilation, tree SyntaxTree) SemanticModel.Index {
            let boundBySyntax = Dictionary[SyntaxNode, BoundNode](ReferenceEqualityComparer.Instance)
            let declaredBySyntax = Dictionary[SyntaxNode, Symbol](ReferenceEqualityComparer.Instance)
            let staticQualifierReads = Dictionary[SyntaxNode, BoundExpression?](ReferenceEqualityComparer.Instance)
            let logicalCompletions = Dictionary[BoundExpression, BoundExpression?](ReferenceEqualityComparer.Instance)
            let staticQualifierTypes = Dictionary[SyntaxNode, TypeSymbol?](ReferenceEqualityComparer.Instance)
            let program = compilation.BoundProgram
            let globalScope = compilation.GlobalScope
            for symbol in EnumerateDeclaredSymbols(program, globalScope) {
                RecordDeclarations(symbol, tree, declaredBySyntax)
            }
            let walker = IndexingWalker(
                tree,
                boundBySyntax,
                declaredBySyntax,
                staticQualifierReads,
                logicalCompletions,
                staticQualifierTypes
            )
            for (function, body) in program.Functions {
                if function.Declaration is {} declaration && !object.ReferenceEquals(declaration.SyntaxTree, tree) {
                    continue
                }
                walker.Visit(body)
            }
            walker.Visit(program.Statement)
            return SemanticModel.Index(
                boundBySyntax,
                declaredBySyntax,
                staticQualifierReads,
                logicalCompletions,
                staticQualifierTypes
            )
        }

        private func EnumerateDeclaredSymbols(program BoundProgram, globalScope BoundGlobalScope) sequence[Symbol] {
            for function in program.Functions.Keys {
                yield function
                for parameter in function.Parameters {
                    yield parameter
                }
            }
            for global in program.Globals {
                yield global
            }
            for declaredEnum in program.Enums {
                yield declaredEnum
            }
            for declaredDelegate in program.Delegates {
                yield declaredDelegate
            }
            for declaredInterface in program.Interfaces {
                yield declaredInterface
            }
            for declaredStruct in program.Structs {
                // ADR-0169 / issue #3795: anchor member containment as the model's
                // symbols surface, not only on the analyzer driver's SYMBOL-action
                // path. A syntax-node analyzer reaches a member symbol through
                // GetDeclaredSymbol/GetSymbolInfo and registers no symbol action,
                // so without this its `ContainingType` is null where Roslyn's is
                // always populated -- and every containment-keyed rule silently
                // reports nothing.
                SymbolContainment.AnchorMembers(declaredStruct)
                yield declaredStruct
                for property in declaredStruct.Properties.Concat(declaredStruct.StaticProperties) {
                    yield property
                }
            }
            // Signature-only functions (e.g. bodies that failed to bind) still
            // declare symbols; the global scope is the authority for those.
            for function in globalScope.Functions {
                yield function
            }
            for variable in globalScope.Variables {
                yield variable
            }
        }

        private func RecordDeclarations(
            symbol Symbol,
            tree SyntaxTree,
            declaredBySyntax Dictionary[SyntaxNode, Symbol]
        ) {
            for declaration in symbol.DeclaringSyntaxNodes {
                if object.ReferenceEquals(declaration.SyntaxTree, tree) && !declaredBySyntax.ContainsKey(declaration) {
                    declaredBySyntax.Add(declaration, symbol)
                }
            }
        }

        private func GetAccessors(boundNodeType Type) BoundNodeAccessors -> AccessorCache.GetOrAdd(
            boundNodeType,
            (type Type) -> {
                let symbolGetters = List[(BoundNode) -> object?]()
                let boundGetters = List[(BoundNode) -> object?]()
                for property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance) {
                    if property.GetIndexParameters().Length != 0 {
                        continue
                    }
                    let getterProperty = property
                    if typeof(Symbol).IsAssignableFrom(property.PropertyType) {
                        symbolGetters.Add((node BoundNode) -> getterProperty.GetValue(node))
                    } else if typeof(BoundNode).IsAssignableFrom(property.PropertyType) {
                        boundGetters.Add((node BoundNode) -> getterProperty.GetValue(node))
                    }
                }
                return BoundNodeAccessors(symbolGetters.ToArray(), boundGetters.ToArray())
            }
        )
    }
}
