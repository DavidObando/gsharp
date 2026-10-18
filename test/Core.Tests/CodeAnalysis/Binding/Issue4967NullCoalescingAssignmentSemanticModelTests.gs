// <copyright file="Issue4967NullCoalescingAssignmentSemanticModelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Linq
import Xunit

/// Issue #4967 (review of #4980): the semantic model resolves both syntax
/// nodes of a `??=` statement — the expression statement maps to the lowered
/// statement and the `??=` expression to a typed bound expression — and
/// resolves a value-position `??=` to its result type.
open class Issue4967NullCoalescingAssignmentSemanticModelTests {
    @Fact
    func StatementAndExpressionNodes_BothResolve() {
        let tree = SyntaxTree.Parse(SourceText.From(Source, "app.gs"))
        let compilation = Compilation(tree)
        Assert.DoesNotContain(compilation.BoundProgram.Diagnostics, (d Diagnostic) -> d.IsError)
        let model = compilation.GetSemanticModel(tree)
        let nodes = tree.Root.DescendantNodes().OfType[NullCoalescingAssignmentExpressionSyntax]().ToArray()
        Assert.Equal(4, nodes.Length)
        let targetTypes = []string{"string?", "string?", "string?", "int32?"}
        for var i = 0; i < nodes.Length; i++ {
            Assert.NotNull(model.GetTypeInfo(nodes[i]).Type)
            let targetType = Assert.IsAssignableFrom[TypeSymbol](model.GetTypeInfo(nodes[i].Target).Type)
            Assert.Equal(targetTypes[i], SymbolDisplay.ToTypeDisplayString(targetType))
        }
        // Statement position (a local target, and a member target whose
        // receiver is captured): the statement maps to a lowered statement,
        // the expression to the bound write, typed as the stored `T?`.
        for index in[]int32{0, 2} {
            let statement = Assert.IsType[ExpressionStatementSyntax](nodes[index].Parent)
            Assert.IsAssignableFrom[BoundStatement](model.GetBoundNode(statement))
            Assert.IsAssignableFrom[BoundExpression](model.GetBoundNode(nodes[index]))
        }
        // Value position: the `??=` has its result type.
        Assert.Equal("string", model.GetTypeInfo(nodes[1]).Type!!.Name)
        Assert.Equal(TypeSymbol.Int32, model.GetTypeInfo(nodes[3]).Type)
    }

    @Theory
    @InlineData(`let _ = (Make().F ??= "v")`, "GS0499")
    @InlineData(`let s = S{}; let _ = (s.F ??= "v")`, "GS0127")
    @InlineData(`let o = Outer{}; o.Inner.F ??= "v"`, "GS0499")
    func StructReceiver_MustBeWritableStorage(body string, diagnosticId string) {
        let source = `package P
struct S {
    var F string?
}
struct Outer {
    var Inner S
}
func Make() S -> S{}
func Test() {
` + body + `
}`
        let tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"))
        let error = Assert.Single(Compilation(tree).BoundProgram.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(diagnosticId, error.Id)
        Assert.Equal(source.IndexOf("??=", StringComparison.Ordinal), error.Location.Span.Start)
        Assert.Equal(3, error.Location.Span.Length)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func OpaqueRefReceiver_CannotRemainLiveAcrossAwait(valuePosition bool) {
        let source = `package P
import System.Threading.Tasks
struct S {
    var F string?
}
func pick(a []S) ref S {
    return ref a[0]
}
async func Test(a []S) {
    ASSIGN
}`.Replace(
            "ASSIGN",
            (
                if valuePosition {
                    "let _ = ("
                } else {
                    ""
                }
            ) +
                `pick(a).F ??= {
        await Task.Yield()
        "v"
    }` +
                (
                if valuePosition {
                    ")"
                } else {
                    ""
                }
            )
        )
        let tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"))
        let error = Assert.Single(Compilation(tree).BoundProgram.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0258", error.Id)
        Assert.Equal(source.IndexOf("pick(a).F ??=", StringComparison.Ordinal), error.Location.Span.Start)
    }

    shared {
        private const Source string = `package P
class Box {
    var Name string?
}
func G(b Box) Box -> b
func F() int32 {
    var x string? = nil
    x ??= "v"
    let r = (x ??= "w")
    let b = Box{}
    G(b).Name ??= "z"
    var n int32? = nil
    return (n ??= 1) + r.Length
}`
    }
}
