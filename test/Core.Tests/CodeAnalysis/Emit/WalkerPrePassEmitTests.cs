// <copyright file="WalkerPrePassEmitTests.cs" company="GSharp">
// Copyright (c) GSharp. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Regression tests for issue #418 (P1-3). The walker pre-passes in
/// <c>ReflectionMetadataEmitter</c> previously used bespoke switches with
/// <c>default: return</c>, missing many <see cref="BoundExpression"/> kinds.
/// A <c>BoundStructLiteralExpression</c> or <c>BoundAppendExpression</c>
/// nested inside any unhandled context (tuple literal, CLR call, etc.)
/// reached the emit site without a preallocated slot and crashed with
/// "no preallocated slot". These tests pin the fix by exercising several
/// previously-missed nesting contexts end-to-end.
/// </summary>
public class WalkerPrePassEmitTests
{
    [Fact]
    public void StructLiteral_Inside_TupleLiteral_Emits_Correctly()
    {
        // Tuple literal of primitive elements computed from struct field
        // accesses: forces the pre-pass walker to descend into the tuple's
        // child expressions (a context the old WalkForStructLiterals skipped).
        const string Source = @"package P
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
";
        var output = Run(Source, "Walker-StructViaTuple");
        Assert.Contains("11", output);
        Assert.Contains("44", output);
    }

    [Fact]
    public void StructLiteral_Inside_Conditional_Expression_Emits_Correctly()
    {
        // The nested struct literal sits inside an if-block on its right-hand
        // side, exercising deeper descent than the old walker reached.
        const string Source = @"package P
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
";
        var output = Run(Source, "Walker-StructInIf");
        Assert.Contains("7", output);
        Assert.Contains("8", output);
    }

    [Fact]
    public void StructLiteral_Inside_ArrayCreation_Emits_Correctly()
    {
        const string Source = @"package P
import System
data struct Point {
    var X int32
    var Y int32
}
var pts = []Point{Point{X: 1, Y: 2}, Point{X: 3, Y: 4}}
Console.WriteLine(pts[0].X)
Console.WriteLine(pts[1].Y)
";
        var output = Run(Source, "Walker-StructInArray");
        Assert.Contains("1", output);
        Assert.Contains("4", output);
    }

    [Fact]
    public void Append_Inside_TupleLiteral_Emits_Correctly()
    {
        // append(...) results assigned to locals first, then captured in a
        // tuple — exercises descent into BoundTupleLiteralExpression children.
        const string Source = @"package P
import System
var xs = []int32{1, 2}
var ys = []int32{10}
xs = append(xs, 3)
ys = append(ys, 20)
var t = (xs[2], ys[1])
Console.WriteLine(t.Item1)
Console.WriteLine(t.Item2)
";
        var output = Run(Source, "Walker-AppendThenTuple");
        Assert.Contains("3", output);
        Assert.Contains("20", output);
    }

    [Fact]
    public void Append_Inside_IfStatement_Emits_Correctly()
    {
        const string Source = @"package P
import System
var xs = []int32{1, 2}
if len(xs) > 0 {
    xs = append(xs, 99)
}
Console.WriteLine(len(xs))
Console.WriteLine(xs[2])
";
        var output = Run(Source, "Walker-AppendInIf");
        Assert.Contains("3", output);
        Assert.Contains("99", output);
    }

    [Fact]
    public void StructDefault_Inside_TupleLiteral_Emits_Correctly()
    {
        // Issue #453: DefaultExpressionCollector previously derived from
        // BoundTreeRewriter; migration to BoundTreeWalker must keep descending
        // into tuple-literal children. A zero-initialized struct field returned
        // from a function exercises the BoundDefaultExpression slot path.
        const string Source = @"package P
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
";
        var output = Run(Source, "Walker-DefaultInTuple");
        Assert.Contains("0", output);
    }

    [Fact]
    public void StructAssignment_Inside_ForRange_Emits_Correctly()
    {
        // Issue #453: AssignmentValueSpillCollector migrated from
        // BoundTreeRewriter to BoundTreeWalker; the recurse-by-default walker
        // must still descend into a for-range body when collecting property /
        // field assignments.
        const string Source = @"package P
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
";
        var output = Run(Source, "Walker-AssignmentInForRange");
        Assert.Contains("4", output);
    }

    [Fact]
    public void Lambda_Nested_Inside_TupleLiteral_Compiles_Correctly()
    {
        // Issue #453: LambdaCollector migrated from BoundTreeRewriter to
        // BoundTreeWalker; this test exercises a function-literal expression
        // assigned to a single var (the binder doesn't infer mixed lambda
        // types in tuple positions). LambdaCollector still must recurse
        // into the body to register the lambda for emission.
        const string Source = @"package P
import System
var seven = func() int32 { return 7 }
var nine = func() int32 { return 9 }
Console.WriteLine(seven())
Console.WriteLine(nine())
";
        var output = Run(Source, "Walker-Lambdas");
        Assert.Contains("7", output);
        Assert.Contains("9", output);
    }

    [Fact]
    public void Default_Of_Struct_Inside_Lambda_Body_Emits_Correctly()
    {
        // Issue #453: covers DefaultExpressionCollector walking into the body
        // of a function literal. After migrating LambdaCollector +
        // DefaultExpressionCollector to BoundTreeWalker, the BoundDefaultExpression
        // for the zero-initialised struct inside the lambda must still have
        // a slot allocated.
        const string Source = @"package P
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
";
        var output = Run(Source, "Walker-DefaultInLambda");
        Assert.Contains("0", output);
    }

    private static string Run(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
