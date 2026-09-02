// <copyright file="SemanticModel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Per-tree semantic queries over a bound compilation: syntax → symbol,
/// syntax → bound node, and syntax → type resolution (ADR-0169). Obtained via
/// <see cref="Compilation.Compilation.GetSemanticModel(SyntaxTree)"/>; the
/// underlying <see cref="Binding.BoundProgram"/> is the compilation's cached
/// instance, so constructing a model never re-binds.
/// </summary>
public sealed class SemanticModel
{
    /// <summary>
    /// Cached, per-bound-node-type accessors for public instance properties
    /// whose values are <see cref="Symbol"/>s or nested <see cref="BoundNode"/>s.
    /// Mirrors the cached child-accessor pattern used by
    /// <see cref="SyntaxNode.GetChildren"/>.
    /// </summary>
    private static readonly ConcurrentDictionary<Type, BoundNodeAccessors> AccessorCache = new();

    private readonly Compilation.Compilation compilation;
    private readonly SyntaxTree syntaxTree;
    private readonly Lazy<Index> index;

    internal SemanticModel(Compilation.Compilation compilation, SyntaxTree syntaxTree)
    {
        this.compilation = compilation;
        this.syntaxTree = syntaxTree;
        index = new Lazy<Index>(() => BuildIndex(compilation, syntaxTree), LazyThreadSafetyMode.ExecutionAndPublication);
    }

    /// <summary>
    /// Gets the compilation this model answers queries against.
    /// </summary>
    public Compilation.Compilation Compilation => compilation;

    /// <summary>
    /// Gets the syntax tree this model covers.
    /// </summary>
    public SyntaxTree SyntaxTree => syntaxTree;

    /// <summary>
    /// Returns the outermost bound node produced from <paramref name="node"/>,
    /// or <see langword="null"/> when the node has no bound counterpart —
    /// tokens, type clauses, nodes inside unbound declarations, and nodes the
    /// binder does not anchor (it threads <see cref="BoundNode.Syntax"/> onto
    /// statements and the expressions diagnostics need, not onto every
    /// expression).
    /// </summary>
    /// <param name="node">The syntax node to look up.</param>
    /// <param name="cancellationToken">Cancels index construction on first use.</param>
    /// <returns>The bound node, or null.</returns>
    public BoundNode? GetBoundNode(SyntaxNode node, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return index.Value.BoundBySyntax.TryGetValue(node, out var bound) ? bound : null;
    }

    /// <summary>
    /// Returns the symbol declared by <paramref name="node"/> — the
    /// counterpart of Roslyn's <c>GetDeclaredSymbol</c>. Covers functions,
    /// structs, interfaces, enums, delegates, properties, globals, parameters,
    /// and locals whose declaration lives in this tree.
    /// </summary>
    /// <param name="node">The declaration syntax node.</param>
    /// <param name="cancellationToken">Cancels index construction on first use.</param>
    /// <returns>The declared symbol, or null when the node declares nothing.</returns>
    public Symbol? GetDeclaredSymbol(SyntaxNode node, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return index.Value.DeclaredBySyntax.TryGetValue(node, out var symbol) ? symbol : null;
    }

    /// <summary>
    /// Returns the symbol referenced by <paramref name="node"/> — the
    /// counterpart of Roslyn's <c>GetSymbolInfo</c>: the invoked function of a
    /// call, the variable of a name expression, the member of an access, and
    /// so on. Implicit conversion wrappers sharing the node's syntax are
    /// unwrapped.
    /// </summary>
    /// <param name="node">The syntax node to resolve.</param>
    /// <param name="cancellationToken">Cancels index construction on first use.</param>
    /// <returns>The resolution result; <see cref="SymbolInfo.Symbol"/> is null when nothing is referenced.</returns>
    public SymbolInfo GetSymbolInfo(SyntaxNode node, CancellationToken cancellationToken = default)
    {
        var bound = GetBoundNode(node, cancellationToken);
        for (var depth = 0; bound is not null && depth < 16; depth++)
        {
            var accessors = GetAccessors(bound.GetType());
            foreach (var getter in accessors.SymbolProperties)
            {
                if (getter(bound) is Symbol symbol and not TypeSymbol)
                {
                    return new SymbolInfo(symbol);
                }
            }

            // No directly referenced symbol here — unwrap a same-syntax child
            // (e.g. an implicit BoundConversionExpression wrapper) and retry.
            BoundNode? sameSyntaxChild = null;
            foreach (var getter in accessors.BoundNodeProperties)
            {
                if (getter(bound) is BoundNode child && ReferenceEquals(child.Syntax, node))
                {
                    sameSyntaxChild = child;
                    break;
                }
            }

            bound = sameSyntaxChild;
        }

        return SymbolInfo.None;
    }

    /// <summary>
    /// Returns the type of the expression at <paramref name="node"/> — the
    /// counterpart of Roslyn's <c>GetTypeInfo</c>. The outermost bound node's
    /// type is reported, so implicit conversions yield the converted type.
    /// </summary>
    /// <param name="node">The syntax node to resolve.</param>
    /// <param name="cancellationToken">Cancels index construction on first use.</param>
    /// <returns>The resolution result; <see cref="TypeInfo.Type"/> is null for non-expressions.</returns>
    public TypeInfo GetTypeInfo(SyntaxNode node, CancellationToken cancellationToken = default)
    {
        return GetBoundNode(node, cancellationToken) is BoundExpression expression
            ? new TypeInfo(expression.Type)
            : TypeInfo.None;
    }

    private static Index BuildIndex(Compilation.Compilation compilation, SyntaxTree tree)
    {
        var boundBySyntax = new Dictionary<SyntaxNode, BoundNode>(ReferenceEqualityComparer.Instance);
        var declaredBySyntax = new Dictionary<SyntaxNode, Symbol>(ReferenceEqualityComparer.Instance);

        var program = compilation.BoundProgram;
        var globalScope = compilation.GlobalScope;

        foreach (var symbol in EnumerateDeclaredSymbols(program, globalScope))
        {
            RecordDeclarations(symbol, tree, declaredBySyntax);
        }

        var walker = new IndexingWalker(tree, boundBySyntax, declaredBySyntax);
        foreach (var (function, body) in program.Functions)
        {
            if (function.Declaration is { } declaration && !ReferenceEquals(declaration.SyntaxTree, tree))
            {
                continue;
            }

            walker.Visit(body);
        }

        walker.Visit(program.Statement);

        return new Index(boundBySyntax, declaredBySyntax);
    }

    private static IEnumerable<Symbol> EnumerateDeclaredSymbols(BoundProgram program, BoundGlobalScope globalScope)
    {
        foreach (var function in program.Functions.Keys)
        {
            yield return function;
            foreach (var parameter in function.Parameters)
            {
                yield return parameter;
            }
        }

        foreach (var global in program.Globals)
        {
            yield return global;
        }

        foreach (var declaredEnum in program.Enums)
        {
            yield return declaredEnum;
        }

        foreach (var declaredDelegate in program.Delegates)
        {
            yield return declaredDelegate;
        }

        foreach (var declaredInterface in program.Interfaces)
        {
            yield return declaredInterface;
        }

        foreach (var declaredStruct in program.Structs)
        {
            // ADR-0169 / issue #3795: anchor member containment as the model's
            // symbols surface, not only on the analyzer driver's SYMBOL-action
            // path. A syntax-node analyzer reaches a member symbol through
            // GetDeclaredSymbol/GetSymbolInfo and registers no symbol action,
            // so without this its `ContainingType` is null where Roslyn's is
            // always populated -- and every containment-keyed rule silently
            // reports nothing.
            SymbolContainment.AnchorMembers(declaredStruct);

            yield return declaredStruct;
            foreach (var property in declaredStruct.Properties.Concat(declaredStruct.StaticProperties))
            {
                yield return property;
            }
        }

        // Signature-only functions (e.g. bodies that failed to bind) still
        // declare symbols; the global scope is the authority for those.
        foreach (var function in globalScope.Functions)
        {
            yield return function;
        }

        foreach (var variable in globalScope.Variables)
        {
            yield return variable;
        }
    }

    private static void RecordDeclarations(Symbol symbol, SyntaxTree tree, Dictionary<SyntaxNode, Symbol> declaredBySyntax)
    {
        foreach (var declaration in symbol.DeclaringSyntaxNodes)
        {
            if (ReferenceEquals(declaration.SyntaxTree, tree) && !declaredBySyntax.ContainsKey(declaration))
            {
                declaredBySyntax.Add(declaration, symbol);
            }
        }
    }

    private static BoundNodeAccessors GetAccessors(Type boundNodeType)
        => AccessorCache.GetOrAdd(boundNodeType, static type =>
        {
            var symbolGetters = new List<Func<BoundNode, object?>>();
            var boundGetters = new List<Func<BoundNode, object?>>();
            foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (property.GetIndexParameters().Length != 0)
                {
                    continue;
                }

                var getterProperty = property;
                if (typeof(Symbol).IsAssignableFrom(property.PropertyType))
                {
                    symbolGetters.Add(node => getterProperty.GetValue(node));
                }
                else if (typeof(BoundNode).IsAssignableFrom(property.PropertyType))
                {
                    boundGetters.Add(node => getterProperty.GetValue(node));
                }
            }

            return new BoundNodeAccessors(symbolGetters.ToArray(), boundGetters.ToArray());
        });

    private sealed record BoundNodeAccessors(
        Func<BoundNode, object?>[] SymbolProperties,
        Func<BoundNode, object?>[] BoundNodeProperties);

    private sealed record Index(
        Dictionary<SyntaxNode, BoundNode> BoundBySyntax,
        Dictionary<SyntaxNode, Symbol> DeclaredBySyntax);

    /// <summary>
    /// Records the outermost bound node per syntax node (first-win in a
    /// pre-order walk) and harvests local/pattern variable declarations from
    /// symbol-valued bound-node properties.
    /// </summary>
    private sealed class IndexingWalker : BoundTreeWalker
    {
        private readonly SyntaxTree tree;
        private readonly Dictionary<SyntaxNode, BoundNode> boundBySyntax;
        private readonly Dictionary<SyntaxNode, Symbol> declaredBySyntax;

        public IndexingWalker(
            SyntaxTree tree,
            Dictionary<SyntaxNode, BoundNode> boundBySyntax,
            Dictionary<SyntaxNode, Symbol> declaredBySyntax)
        {
            this.tree = tree;
            this.boundBySyntax = boundBySyntax;
            this.declaredBySyntax = declaredBySyntax;
        }

        public override void Visit(BoundNode? node)
        {
            Record(node);
            base.Visit(node);
        }

        public override void VisitStatement(BoundStatement? node)
        {
            Record(node);
            base.VisitStatement(node);
        }

        public override void VisitExpression(BoundExpression? node)
        {
            Record(node);
            base.VisitExpression(node);
        }

        public override void VisitPattern(BoundPattern? node)
        {
            Record(node);
            base.VisitPattern(node);
        }

        private void Record(BoundNode? node)
        {
            if (node is null)
            {
                return;
            }

            if (node.Syntax is { } syntax && ReferenceEquals(syntax.SyntaxTree, tree) && !boundBySyntax.ContainsKey(syntax))
            {
                boundBySyntax.Add(syntax, node);
            }

            foreach (var getter in GetAccessors(node.GetType()).SymbolProperties)
            {
                if (getter(node) is Symbol symbol)
                {
                    RecordDeclarations(symbol, tree, declaredBySyntax);
                }
            }
        }
    }
}
