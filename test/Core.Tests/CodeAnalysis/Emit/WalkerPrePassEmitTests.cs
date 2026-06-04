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
type Point data struct {
    X int32
    Y int32
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
type Point data struct {
    X int32
    Y int32
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
type Point data struct {
    X int32
    Y int32
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
                entry!.Invoke(null, parameters: null);
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
