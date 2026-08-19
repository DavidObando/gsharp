// <copyright file="Adr0169SemanticModelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Covers the ADR-0169 <see cref="SemanticModel"/> (syntax→symbol,
/// syntax→bound-node, syntax→type queries), <see cref="Symbol.DeclaringSyntaxNodes"/>,
/// and <see cref="GSharpSyntaxWalker"/>.
/// </summary>
public class Adr0169SemanticModelTests
{
    private const string Source = @"package App
import System

func Add(left int32, right int32) int32 {
    return left + right
}

func Main() {
    var total = Add(1, 2)
    Console.WriteLine(total)
}
";

    [Fact]
    public void GetDeclaredSymbol_OnFunctionDeclaration_ReturnsFunctionSymbol()
    {
        var (model, tree) = CreateModel(Source);
        var declaration = NodesOfType<FunctionDeclarationSyntax>(tree).First(f => f.Identifier.Text == "Add");

        var symbol = model.GetDeclaredSymbol(declaration);

        var function = Assert.IsType<FunctionSymbol>(symbol);
        Assert.Equal("Add", function.Name);
        Assert.Contains(declaration, function.DeclaringSyntaxNodes);
    }

    [Fact]
    public void GetSymbolInfo_OnCallExpression_ResolvesInvokedFunction()
    {
        var (model, tree) = CreateModel(Source);
        var call = NodesOfType<CallExpressionSyntax>(tree).First(c => c.Identifier.Text == "Add");

        var info = model.GetSymbolInfo(call);

        var function = Assert.IsType<FunctionSymbol>(info.Symbol);
        Assert.Equal("Add", function.Name);
    }

    [Fact]
    public void GetTypeInfo_OnCallExpression_ReturnsInt32()
    {
        var (model, tree) = CreateModel(Source);
        var call = NodesOfType<CallExpressionSyntax>(tree).First(c => c.Identifier.Text == "Add");

        var info = model.GetTypeInfo(call);

        Assert.NotNull(info.Type);
        Assert.Equal("int32", info.Type.Name);
    }

    [Fact]
    public void GetBoundNode_OnStatement_ReturnsBoundCounterpart()
    {
        var (model, tree) = CreateModel(Source);
        var declaration = NodesOfType<FunctionDeclarationSyntax>(tree).First(f => f.Identifier.Text == "Add");
        var call = NodesOfType<CallExpressionSyntax>(tree).First(c => c.Identifier.Text == "Add");

        // The binder anchors call expressions; nodes it does not anchor (or
        // tokens) legitimately have no bound counterpart.
        Assert.NotNull(model.GetBoundNode(call));
        Assert.Null(model.GetBoundNode(declaration.Identifier));
    }

    [Fact]
    public void GetSemanticModel_CachesPerTree_AndRejectsForeignTrees()
    {
        var tree = SyntaxTree.Parse(SourceText.From(Source, "app.gs"));
        var compilation = new Compilation(tree);
        var foreign = SyntaxTree.Parse(SourceText.From(Source, "foreign.gs"));

        Assert.Same(compilation.GetSemanticModel(tree), compilation.GetSemanticModel(tree));
        Assert.Throws<ArgumentException>(() => compilation.GetSemanticModel(foreign));
    }

    [Fact]
    public void GetDeclaredSymbol_OnLocalDeclaration_ReturnsVariableSymbol()
    {
        var (model, tree) = CreateModel(Source);
        var declaredSymbols = AllNodes(tree)
            .Select(node => model.GetDeclaredSymbol(node))
            .Where(symbol => symbol is VariableSymbol)
            .Cast<VariableSymbol>()
            .ToList();

        Assert.Contains(declaredSymbols, v => v.Name == "total");
        Assert.Contains(declaredSymbols, v => v.Name == "left");
    }

    [Fact]
    public void SyntaxWalker_VisitsEveryNodeDepthFirst()
    {
        var tree = SyntaxTree.Parse(SourceText.From(Source, "app.gs"));
        var collector = new CollectingWalker();

        collector.Visit(tree.Root);

        Assert.Contains(collector.Nodes, n => n is CallExpressionSyntax);
        Assert.Contains(collector.Nodes, n => n is FunctionDeclarationSyntax);
        Assert.True(collector.TokenCount > 0);

        // Depth-first: a function declaration is visited before the call inside it.
        var declarationIndex = collector.Nodes.FindIndex(n => n is FunctionDeclarationSyntax);
        var callIndex = collector.Nodes.FindIndex(n => n is CallExpressionSyntax);
        Assert.True(declarationIndex < callIndex);
    }

    private static (SemanticModel Model, SyntaxTree Tree) CreateModel(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"));
        var compilation = new Compilation(tree);
        Assert.Empty(compilation.GlobalScope.Diagnostics.Where(d => d.IsError));
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
        return (compilation.GetSemanticModel(tree), tree);
    }

    private static IEnumerable<T> NodesOfType<T>(SyntaxTree tree)
        where T : SyntaxNode
    {
        var collector = new CollectingWalker();
        collector.Visit(tree.Root);
        return collector.Nodes.OfType<T>();
    }

    private static IEnumerable<SyntaxNode> AllNodes(SyntaxTree tree)
    {
        var pending = new Stack<SyntaxNode>();
        pending.Push(tree.Root);
        while (pending.Count > 0)
        {
            var node = pending.Pop();
            yield return node;
            foreach (var child in node.GetChildren())
            {
                pending.Push(child);
            }
        }
    }

    private sealed class CollectingWalker : GSharpSyntaxWalker
    {
        public List<SyntaxNode> Nodes { get; } = new();

        public int TokenCount { get; private set; }

        public override void Visit(SyntaxNode node)
        {
            if (node is not null and not SyntaxToken)
            {
                Nodes.Add(node);
            }

            base.Visit(node);
        }

        public override void VisitToken(SyntaxToken token)
        {
            TokenCount++;
        }
    }
}
