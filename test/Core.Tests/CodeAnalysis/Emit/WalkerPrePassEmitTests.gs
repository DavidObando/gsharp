// <copyright file="WalkerPrePassEmitTests.cs" company="GSharp">
// Copyright (c) GSharp. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Regression tests for issue #418 (P1-3). The walker pre-passes in
/// `ReflectionMetadataEmitter` previously used bespoke switches with
/// `default: return`, missing many (cref:BoundExpression) kinds.
/// A `BoundStructLiteralExpression` or `BoundAppendExpression`
/// nested inside any unhandled context (tuple literal, CLR call, etc.)
/// reached the emit site without a preallocated slot and crashed with
/// "no preallocated slot". These tests pin the fix by exercising several
/// previously-missed nesting contexts end-to-end.
open class WalkerPrePassEmitTests {
    @Fact
    func StructLiteral_Inside_TupleLiteral_Emits_Correctly() {
        // Tuple literal of primitive elements computed from struct field
        // accesses: forces the pre-pass walker to descend into the tuple's
        // child expressions (a context the old WalkForStructLiterals skipped).
        const Source = `package P
import System
data struct Point {
    var X int32
    var Y int32
}
func makeX() int32 {
    var p = Point{X: 11, Y: 22}
    return p.X
}
func makeY() int32 {
    var p = Point{X: 33, Y: 44}
    return p.Y
}
var t = (makeX(), makeY())
Console.WriteLine(t.Item1)
Console.WriteLine(t.Item2)
`
        let output = Run(Source, "Walker-StructViaTuple")
        Assert.Contains("11", output)
        Assert.Contains("44", output)
    }

    @Fact
    func StructLiteral_Inside_Conditional_Expression_Emits_Correctly() {
        // The nested struct literal sits inside an if-block on its right-hand
        // side, exercising deeper descent than the old walker reached.
        const Source = `package P
import System
data struct Point {
    var X int32
    var Y int32
}
var flag = true
var p Point
if flag {
    p = Point{X: 7, Y: 8}
} else {
    p = Point{X: 0, Y: 0}
}
Console.WriteLine(p.X)
Console.WriteLine(p.Y)
`
        let output = Run(Source, "Walker-StructInIf")
        Assert.Contains("7", output)
        Assert.Contains("8", output)
    }

    @Fact
    func StructLiteral_Inside_ArrayCreation_Emits_Correctly() {
        const Source = `package P
import System
data struct Point {
    var X int32
    var Y int32
}
var pts = []Point{Point{X: 1, Y: 2}, Point{X: 3, Y: 4}}
Console.WriteLine(pts[0].X)
Console.WriteLine(pts[1].Y)
`
        let output = Run(Source, "Walker-StructInArray")
        Assert.Contains("1", output)
        Assert.Contains("4", output)
    }

    @Fact
    func Append_Inside_TupleLiteral_Emits_Correctly() {
        // List.Add(...) calls run first, then indexed reads are captured in a
        // tuple — exercises descent into BoundTupleLiteralExpression children.
        // (ADR-0174 D13 retired the `append` built-in; `List[T].Add` is the
        // growable shape.)
        const Source = `package P
import System
import System.Collections.Generic
var xs = List[int32]()
xs.Add(1)
xs.Add(2)
var ys = List[int32]()
ys.Add(10)
xs.Add(3)
ys.Add(20)
var t = (xs[2], ys[1])
Console.WriteLine(t.Item1)
Console.WriteLine(t.Item2)
`
        let output = Run(Source, "Walker-AppendThenTuple")
        Assert.Contains("3", output)
        Assert.Contains("20", output)
    }

    @Fact
    func Append_Inside_IfStatement_Emits_Correctly() {
        const Source = `package P
import System
import System.Collections.Generic
var xs = List[int32]()
xs.Add(1)
xs.Add(2)
if xs.Count > 0 {
    xs.Add(99)
}
Console.WriteLine(xs.Count)
Console.WriteLine(xs[2])
`
        let output = Run(Source, "Walker-AppendInIf")
        Assert.Contains("3", output)
        Assert.Contains("99", output)
    }

    @Fact
    func StructDefault_Inside_TupleLiteral_Emits_Correctly() {
        // Issue #453: DefaultExpressionCollector previously derived from
        // BoundTreeRewriter; migration to BoundTreeWalker must keep descending
        // into tuple-literal children. A zero-initialized struct field returned
        // from a function exercises the BoundDefaultExpression slot path.
        const Source = `package P
import System
data struct Point {
    var X int32
    var Y int32
}
func makeZero() Point {
    var p Point
    return p
}
var t = (makeZero().X, makeZero().Y)
Console.WriteLine(t.Item1)
Console.WriteLine(t.Item2)
`
        let output = Run(Source, "Walker-DefaultInTuple")
        Assert.Contains("0", output)
    }

    @Fact
    func StructAssignment_Inside_ForRange_Emits_Correctly() {
        // Issue #453: AssignmentValueSpillCollector migrated from
        // BoundTreeRewriter to BoundTreeWalker; the recurse-by-default walker
        // must still descend into a for-range body when collecting property /
        // field assignments.
        const Source = `package P
import System
data struct Box {
    var Value int32
}
var b Box
var nums = [3]int32{0, 1, 2}
for i, v in nums {
    b.Value = v + i
}
Console.WriteLine(b.Value)
`
        let output = Run(Source, "Walker-AssignmentInForRange")
        Assert.Contains("4", output)
    }

    @Fact
    func Lambda_Nested_Inside_TupleLiteral_Compiles_Correctly() {
        // Issue #453: LambdaCollector migrated from BoundTreeRewriter to
        // BoundTreeWalker; this test exercises a function-literal expression
        // assigned to a single var (the binder doesn't infer mixed lambda
        // types in tuple positions). LambdaCollector still must recurse
        // into the body to register the lambda for emission.
        const Source = `package P
import System
var seven = func() int32 { return 7 }
var nine = func() int32 { return 9 }
Console.WriteLine(seven())
Console.WriteLine(nine())
`
        let output = Run(Source, "Walker-Lambdas")
        Assert.Contains("7", output)
        Assert.Contains("9", output)
    }

    @Fact
    func Default_Of_Struct_Inside_Lambda_Body_Emits_Correctly() {
        // Issue #453: covers DefaultExpressionCollector walking into the body
        // of a function literal. After migrating LambdaCollector +
        // DefaultExpressionCollector to BoundTreeWalker, the BoundDefaultExpression
        // for the zero-initialised struct inside the lambda must still have
        // a slot allocated.
        const Source = `package P
import System
data struct Pair {
    var A int32
    var B int32
}
var make = func() Pair {
    var p Pair
    return p
}
var r = make()
Console.WriteLine(r.A)
Console.WriteLine(r.B)
`
        let output = Run(Source, "Walker-DefaultInLambda")
        Assert.Contains("0", output)
    }

    shared {
        private func Run(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
