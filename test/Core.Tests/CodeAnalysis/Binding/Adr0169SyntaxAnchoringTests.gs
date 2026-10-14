// <copyright file="Adr0169SyntaxAnchoringTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0169: the binder guarantees a non-null (cref:BoundNode.Syntax)
/// anchor on every statement, expression, and pattern reachable from
/// (cref:BoundProgram) — precise anchors from the bind dispatchers,
/// inherited anchors (nearest ancestor) for nodes synthesized during binding
/// or per-member lowering.
open class Adr0169SyntaxAnchoringTests {
    @Fact
    func EveryDispatchableBoundNode_HasASyntaxAnchor() {
        let program = Bind(DiverseSource)
        let unanchored = List[string]()
        let collector = AnchorAuditWalker(unanchored)
        for (function, body) in program.Functions {
            collector.Visit(body)
        }
        // A program with no top-level statements keeps its empty synthetic
        // block unanchored; only audit it when it carries real statements.
        if program.Statement.Statements.Length > 0 {
            collector.Visit(program.Statement)
        }
        Assert.True(unanchored.Count == 0, ("${unanchored.Count}" + ` bound node(s) lack a syntax anchor:
` + "${string.Join("\n", unanchored.Distinct().Take(25))}"))
    }

    @Fact
    func BinaryExpression_IsAnchoredToItsOwnSyntax() {
        // Witness: before the dispatch-level stamping, BoundBinaryExpression
        // was constructed without syntax and this lookup returned null.
        let tree = SyntaxTree.Parse(SourceText.From(DiverseSource, "app.gs"))
        let compilation = Compilation(tree)
        let model = compilation.GetSemanticModel(tree)
        let binary = FindNodes[BinaryExpressionSyntax](tree.Root).First()
        let bound BoundNode? = model.GetBoundNode(binary)
        Assert.NotNull(bound)
        Assert.Same(binary, bound!!.Syntax)
    }

    private class AnchorAuditWalker : BoundTreeWalker {
        private let unanchored List[string]

        init(unanchored List[string]) {
            this.unanchored = unanchored
        }

        override func VisitStatement(node BoundStatement) {
            Audit(node)
            base.VisitStatement(node)
        }

        override func VisitExpression(node BoundExpression) {
            Audit(node)
            base.VisitExpression(node)
        }

        override func VisitPattern(node BoundPattern) {
            Audit(node)
            base.VisitPattern(node)
        }

        private func Audit(node BoundNode?) {
            if node != nil && node.Syntax == nil {
                unanchored.Add(node.Kind.ToString())
            }
        }
    }

    shared {
        private const DiverseSource string = `package App
import System

open class Animal {
    var Name string

    open func Describe() string {
        return "animal ${Name}"
    }
}

class Dog : Animal {
    var Bark int32

    override func Describe() string {
        return "dog ${Name} barks ${Bark}"
    }
}

func Categorize(n int32) string {
    switch n {
        case 0 { return "zero" }
        case < 0 { return "negative" }
        default { return "positive" }
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
    var dog = Dog { Name: "Rex", Bark: 3 }
    Console.WriteLine(Speak(dog))
}
`

        private func Bind(source string) BoundProgram {
            let tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"))
            let compilation = Compilation(tree)
            let program = compilation.BoundProgram
            let errors = tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(program.Diagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToList()
            Assert.True(errors.Count == 0, string.Join("\n", errors.Select((d Diagnostic) -> d.Message)))
            return program
        }

        private func FindNodes[T SyntaxNode](root SyntaxNode) sequence[T] {
            let pending = Stack[SyntaxNode]()
            pending.Push(root)
            while pending.Count > 0 {
                let node = pending.Pop()
                if node is T match {
                    yield match
                }
                for child in node.GetChildren() {
                    pending.Push(child)
                }
            }
        }
    }
}
