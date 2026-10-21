// <copyright file="SemanticModel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Threading

/// Per-tree semantic queries over a bound compilation: syntax → symbol,
/// syntax → bound node, and syntax → type resolution (ADR-0169). Obtained via
/// (cref:Compilation.Compilation.GetSemanticModel(SyntaxTree)); the
/// underlying (cref:Binding.BoundProgram) is the compilation's cached
/// instance, so constructing a model never re-binds.
class SemanticModel {
    private let compilation Compilation
    private let syntaxTree SyntaxTree
    private let index Lazy[SemanticModel.Index]

    internal init(compilation Compilation, syntaxTree SyntaxTree) {
        this.compilation = compilation
        this.syntaxTree = syntaxTree
        CompilationMeasurements.Count("semantic.models.created")
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
            return bound
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
            return qualified
        }
        return nil
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
    /// unwrapped.
    /// @param node The syntax node to resolve.
    /// @param cancellationToken Cancels index construction on first use.
    /// @returns The resolution result; (cref:SymbolInfo.Symbol) is null when nothing is referenced.
    func GetSymbolInfo(node SyntaxNode, cancellationToken CancellationToken = default(CancellationToken)) SymbolInfo {
        var bound BoundNode? = GetBoundNode(node, cancellationToken)
        for var depth = 0; bound != nil && depth < 16; depth++ {
            let accessors = GetAccessors(bound.GetType())
            for getter in accessors.SymbolProperties {
                if (getter(bound) is Symbol symbol and not TypeSymbol) {
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
            let boundSyntax = bound.Syntax ?? node
            for getter in accessors.BoundNodeProperties {
                if getter(bound) is BoundNode child && object.ReferenceEquals(child.Syntax, boundSyntax) {
                    sameSyntaxChild = child
                    break
                }
            }
            bound = sameSyntaxChild
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

    private data class Index(
        BoundBySyntax Dictionary[SyntaxNode, BoundNode],
        DeclaredBySyntax Dictionary[SyntaxNode, Symbol]
    ) : IEquatable[SemanticModel.Index] { }

    /// Partitions source ownership once, without building other trees' detailed indexes.
    internal class OwnershipIndex {
        private class Bucket {
            init(declarations ImmutableArray[KeyValuePair[SyntaxNode, Symbol]], bodies ImmutableArray[BoundNode]) {
                Declarations = declarations
                Bodies = bodies
            }

            prop Declarations ImmutableArray[KeyValuePair[SyntaxNode, Symbol]] {
                get;
            }
            prop Bodies ImmutableArray[BoundNode] {
                get;
            }
        }

        private class BucketBuilder {
            let Declarations List[KeyValuePair[SyntaxNode, Symbol]] = List[KeyValuePair[SyntaxNode, Symbol]]()
            let Bodies List[BoundNode] = List[BoundNode]()
            var LastBodyOrdinal int32 = -1
        }

        // Only this constructor writes the dictionary; published buckets contain immutable fact arrays.
        private let buckets Dictionary[SyntaxTree, Bucket]

        internal init(compilation Compilation) {
            let program = compilation.BoundProgram
            let globalScope = compilation.GlobalScope
            using let measurement = CompilationMeasurements.BeginPhase("semantic.ownership")
            CompilationMeasurements.Count("semantic.ownership.builds")
            let builders = Dictionary[SyntaxTree, BucketBuilder](ReferenceEqualityComparer.Instance)
            for symbol in SemanticModel.EnumerateDeclaredSymbols(program, globalScope) {
                CompilationMeasurements.Count("semantic.declaration.visits")
                for declaration in symbol.DeclaringSyntaxNodes {
                    GetBuilder(builders, declaration.SyntaxTree).Declarations.Add(
                        KeyValuePair[SyntaxNode, Symbol](declaration, symbol)
                    )
                }
            }
            var ordinal = 0
            for (function, body) in program.Functions {
                CompilationMeasurements.Count("semantic.function.visits")
                if function.Declaration is {} declaration {
                    AddBody(builders, declaration.SyntaxTree, body, ordinal)
                } else {
                    AddUnownedBody(builders, body, ordinal)
                }
                ordinal++
            }
            AddUnownedBody(builders, program.Statement, ordinal)
            let result = Dictionary[SyntaxTree, Bucket](builders.Count, ReferenceEqualityComparer.Instance)
            for pair in builders {
                result.Add(
                    pair.Key,
                    Bucket(pair.Value.Declarations.ToImmutableArray(), pair.Value.Bodies.ToImmutableArray())
                )
            }
            buckets = result
        }

        internal func GetDeclarations(tree SyntaxTree) ImmutableArray[
            KeyValuePair[SyntaxNode, Symbol]
        ] -> if buckets.TryGetValue(tree, out var bucket) {
            bucket.Declarations
        } else {
            ImmutableArray[KeyValuePair[SyntaxNode, Symbol]].Empty
        }

        internal func GetBodies(tree SyntaxTree) ImmutableArray[BoundNode] -> if buckets.TryGetValue(
            tree,
            out var bucket
        ) {
            bucket.Bodies
        } else {
            ImmutableArray[BoundNode].Empty
        }

        shared {
            private func GetBuilder(builders Dictionary[SyntaxTree, BucketBuilder], tree SyntaxTree) BucketBuilder {
                if !builders.TryGetValue(tree, out var builder) {
                    builder = BucketBuilder()
                    builders.Add(tree, builder)
                }
                return builder
            }

            private func AddBody(
                builders Dictionary[SyntaxTree, BucketBuilder],
                tree SyntaxTree,
                body BoundNode,
                ordinal int32
            ) {
                let builder = GetBuilder(builders, tree)
                // Several facts can name one tree. Keep each root once at its original position.
                if builder.LastBodyOrdinal != ordinal {
                    builder.Bodies.Add(body)
                    builder.LastBodyOrdinal = ordinal
                }
            }

            private func AddUnownedBody(
                builders Dictionary[SyntaxTree, BucketBuilder],
                body BoundBlockStatement,
                ordinal int32
            ) {
                let facts = body.GetSourceOwnership()
                for tree in facts.SyntaxTrees {
                    AddBody(builders, tree, body, ordinal)
                }
                CompilationMeasurements.Count("semantic.ownership.symbol-node-visits", facts.SymbolNodes.Length)
                // Evaluate current getters only after BoundProgram completes, including inference and cache repointing.
                for node in facts.SymbolNodes {
                    for getter in BoundNodeAccessors.Get(node.GetType()).SymbolProperties {
                        if getter(node) is Symbol symbol {
                            for declaration in symbol.DeclaringSyntaxNodes {
                                AddBody(builders, declaration.SyntaxTree, body, ordinal)
                            }
                        }
                    }
                }
            }
        }
    }

    private abstract class RecordingWalker : BoundTreeWalker {
        protected open func Record(node BoundNode?);

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
    }

    /// Records the outermost bound node per syntax node (first-win in a
    /// pre-order walk) and harvests local/pattern variable declarations from
    /// symbol-valued bound-node properties.
    private class IndexingWalker : RecordingWalker {
        private let tree SyntaxTree
        private let boundBySyntax Dictionary[SyntaxNode, BoundNode]
        private let declaredBySyntax Dictionary[SyntaxNode, Symbol]
        private let measure bool = CompilationMeasurements.IsEnabled

        init(
            tree SyntaxTree,
            boundBySyntax Dictionary[SyntaxNode, BoundNode],
            declaredBySyntax Dictionary[SyntaxNode, Symbol]
        ) {
            this.tree = tree
            this.boundBySyntax = boundBySyntax
            this.declaredBySyntax = declaredBySyntax
        }

        protected override func Record(node BoundNode?) {
            if node == nil {
                return
            }
            if measure {
                CompilationMeasurements.Count("semantic.index.record_visits")
            }
            if node.Syntax is {} syntax && object.ReferenceEquals(syntax.SyntaxTree, tree) &&
                !boundBySyntax.ContainsKey(syntax) {
                boundBySyntax.Add(syntax, node)
            }
            for getter in SemanticModel.GetAccessors(node.GetType()).SymbolProperties {
                if getter(node) is Symbol symbol {
                    SemanticModel.RecordDeclarations(symbol, tree, declaredBySyntax)
                }
            }
        }
    }

    shared {
        private func BuildIndex(compilation Compilation, tree SyntaxTree) SemanticModel.Index {
            let ownership = compilation.SemanticOwnership
            using let measurement = CompilationMeasurements.BeginPhase("semantic.index")
            CompilationMeasurements.Count("semantic.index.builds")
            let boundBySyntax = Dictionary[SyntaxNode, BoundNode](ReferenceEqualityComparer.Instance)
            let declaredBySyntax = Dictionary[SyntaxNode, Symbol](ReferenceEqualityComparer.Instance)
            for declaration in ownership.GetDeclarations(tree) {
                declaredBySyntax.TryAdd(declaration.Key, declaration.Value)
            }
            let walker = IndexingWalker(tree, boundBySyntax, declaredBySyntax)
            for body in ownership.GetBodies(tree) {
                CompilationMeasurements.Count("semantic.index.bodies")
                walker.Visit(body)
            }
            return SemanticModel.Index(boundBySyntax, declaredBySyntax)
        }

        private func EnumerateDeclaredSymbols(program BoundProgram, globalScope BoundGlobalScope) sequence[Symbol] {
            for function in program.Functions.Keys {
                CompilationMeasurements.Count("semantic.declaration_function.visits")
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

        private func GetAccessors(boundNodeType Type) BoundNodeAccessors -> BoundNodeAccessors.Get(boundNodeType)
    }
}
