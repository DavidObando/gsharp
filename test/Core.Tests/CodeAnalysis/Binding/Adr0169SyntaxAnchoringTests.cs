// <copyright file="Adr0169SyntaxAnchoringTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0169: the binder guarantees a non-null <see cref="BoundNode.Syntax"/>
/// anchor on every statement, expression, and pattern reachable from
/// <see cref="BoundProgram"/> — precise anchors from the bind dispatchers,
/// inherited anchors (nearest ancestor) for nodes synthesized during binding
/// or per-member lowering.
/// </summary>
public class Adr0169SyntaxAnchoringTests
{
    private const string DiverseSource = @"package App
import System

open class Animal {
    var Name string

    open func Describe() string {
        return ""animal ${Name}""
    }
}

class Dog : Animal {
    var Bark int32

    override func Describe() string {
        return ""dog ${Name} barks ${Bark}""
    }
}

func Categorize(n int32) string {
    switch n {
        case 0 { return ""zero"" }
        case < 0 { return ""negative"" }
        default { return ""positive"" }
    }
}

func Speak(a Animal) string {
    switch a {
        case d is Dog { return d.Describe() }
        default { return a.Describe() }
    }
}

func Sum(values []int32) int32 {
    var total = 0
    for var i = 0; i < values.Length; i = i + 1 {
        if values[i] > 0 {
            total = total + values[i]
        }
    }
    return total
}

func Main() {
    var values = []int32{1, -2, 3}
    var total = Sum(values)
    var doubled = func(x int32) int32 { return x * 2 }
    Console.WriteLine(total + doubled(4))
    Console.WriteLine(Categorize(-5))
    var dog = Dog { Name: ""Rex"", Bark: 3 }
    Console.WriteLine(Speak(dog))
}
";

    [Fact]
    public void EveryDispatchableBoundNode_HasASyntaxAnchor()
    {
        var program = Bind(DiverseSource);
        var unanchored = new List<string>();
        var collector = new AnchorAuditWalker(unanchored);

        foreach (var (function, body) in program.Functions)
        {
            collector.Visit(body);
        }

        // A program with no top-level statements keeps its empty synthetic
        // block unanchored; only audit it when it carries real statements.
        if (program.Statement.Statements.Length > 0)
        {
            collector.Visit(program.Statement);
        }

        Assert.True(
            unanchored.Count == 0,
            $"{unanchored.Count} bound node(s) lack a syntax anchor:\n{string.Join("\n", unanchored.Distinct().Take(25))}");
    }

    [Fact]
    public void BinaryExpression_IsAnchoredToItsOwnSyntax()
    {
        // Witness: before the dispatch-level stamping, BoundBinaryExpression
        // was constructed without syntax and this lookup returned null.
        var tree = SyntaxTree.Parse(SourceText.From(DiverseSource, "app.gs"));
        var compilation = new Compilation(tree);
        var model = compilation.GetSemanticModel(tree);
        var binary = FindNodes<BinaryExpressionSyntax>(tree.Root).First();

        var bound = model.GetBoundNode(binary);

        Assert.NotNull(bound);
        Assert.Same(binary, bound.Syntax);
    }

    private static BoundProgram Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"));
        var compilation = new Compilation(tree);
        var program = compilation.BoundProgram;
        var errors = tree.Diagnostics.Concat(compilation.GlobalScope.Diagnostics).Concat(program.Diagnostics).Where(d => d.IsError).ToList();
        Assert.True(errors.Count == 0, string.Join("\n", errors.Select(d => d.Message)));
        return program;
    }

    private static IEnumerable<T> FindNodes<T>(SyntaxNode root)
        where T : SyntaxNode
    {
        var pending = new Stack<SyntaxNode>();
        pending.Push(root);
        while (pending.Count > 0)
        {
            var node = pending.Pop();
            if (node is T match)
            {
                yield return match;
            }

            foreach (var child in node.GetChildren())
            {
                pending.Push(child);
            }
        }
    }

    private sealed class AnchorAuditWalker : BoundTreeWalker
    {
        private readonly List<string> unanchored;

        public AnchorAuditWalker(List<string> unanchored) => this.unanchored = unanchored;

        public override void VisitStatement(BoundStatement node)
        {
            Audit(node);
            base.VisitStatement(node);
        }

        public override void VisitExpression(BoundExpression node)
        {
            Audit(node);
            base.VisitExpression(node);
        }

        public override void VisitPattern(BoundPattern node)
        {
            Audit(node);
            base.VisitPattern(node);
        }

        private void Audit(BoundNode node)
        {
            if (node is not null && node.Syntax is null)
            {
                unanchored.Add(node.Kind.ToString());
            }
        }
    }
}
