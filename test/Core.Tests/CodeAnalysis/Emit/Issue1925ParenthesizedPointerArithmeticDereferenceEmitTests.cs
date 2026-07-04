// <copyright file="Issue1925ParenthesizedPointerArithmeticDereferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
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
/// Issue #1925: dereferencing a parenthesized pointer-arithmetic expression
/// (<c>*(p + i)</c>) misbound. The root cause lived in
/// <c>BindDereferenceExpression</c>'s <c>*T(expr)</c>-cast recognition (issue
/// #1014): it fired on ANY operand that bound to a <c>BoundConversionExpression</c>,
/// not just the actual <c>* IDENT ( expr )</c> cast syntax. Pointer arithmetic
/// (<c>p + i</c>) lowers to a <c>BoundConversionExpression</c> back to the
/// pointer type (see <c>LowerPointerOffset</c>), so <c>*(p + i)</c> tripped the
/// same branch and was rewrapped as a cast to a pointer-to-pointer, producing
/// <c>**int32</c> instead of <c>int32</c> — surfacing as
/// <c>GS0129: Binary operator '+=' is not defined for types 'int32' and
/// '**int32'</c> in <c>sum += *(p + i)</c>. Separately, the parser had no
/// support at all for a compound assignment (<c>+=</c>, <c>-=</c>, <c>*=</c>, …)
/// whose target is a pointer dereference (<c>*(p + i) += 1</c>); this test also
/// covers the new <c>IndirectCompoundAssignmentExpressionSyntax</c> desugaring
/// added to close that gap for ANY compound operator.
/// </summary>
public class Issue1925ParenthesizedPointerArithmeticDereferenceEmitTests
{
    [Fact]
    public void DereferenceOfParenthesizedPointerArithmetic_AsCompoundAssignmentRhs_ReadsPointeeValue()
    {
        // The exact repro from the grid app G12 fixture comment: `sum += *(p + i)`
        // used to fail GS0129 with the RHS misbound as `**int32`.
        const string Source = @"package Issue1925Sum
import System

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    var i int32 = 0
    var sum int32 = 0
    for i = 0; i < arr.Length; i += 1 {
        sum += *(p + i)
    }
    Console.WriteLine(sum)
}

run()
";
        var output = CompileAndRun(Source, "Issue1925Sum");
        Assert.Contains("26", output);
    }

    [Fact]
    public void DereferenceOfParenthesizedPointerArithmetic_AsPlainRead_YieldsPointeeType()
    {
        const string Source = @"package Issue1925Read
import System

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    let x int32 = *(p + 2)
    Console.WriteLine(x)
}

run()
";
        var output = CompileAndRun(Source, "Issue1925Read");
        Assert.Contains("7", output);
    }

    [Fact]
    public void DereferenceOfParenthesizedPointerArithmetic_AsPlainAssignmentTarget_WritesThroughPointer()
    {
        const string Source = @"package Issue1925PlainAssign
import System

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    *(p + 0) = 42
    Console.WriteLine(arr[0])
}

run()
";
        var output = CompileAndRun(Source, "Issue1925PlainAssign");
        Assert.Contains("42", output);
    }

    [Fact]
    public void DereferenceOfParenthesizedPointerArithmetic_AsCompoundAssignmentTarget_PlusEquals_WritesThroughPointer()
    {
        // The `*(p + i) += 1` shape named directly in the issue title/body.
        const string Source = @"package Issue1925PlusEquals
import System

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    var i int32 = 1
    *(p + i) += 100
    Console.WriteLine(arr[1])
}

run()
";
        var output = CompileAndRun(Source, "Issue1925PlusEquals");
        Assert.Contains("105", output);
    }

    [Fact]
    public void DereferenceOfParenthesizedPointerArithmetic_AsCompoundAssignmentTarget_MinusEquals_WritesThroughPointer()
    {
        const string Source = @"package Issue1925MinusEquals
import System

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    *(p + 2) -= 2
    Console.WriteLine(arr[2])
}

run()
";
        var output = CompileAndRun(Source, "Issue1925MinusEquals");
        Assert.Contains("5", output);
    }

    [Fact]
    public void DereferenceOfParenthesizedPointerArithmetic_AsCompoundAssignmentTarget_TimesEquals_WritesThroughPointer()
    {
        // Any compound operator must work generally, not just `+=`/`-=`.
        const string Source = @"package Issue1925TimesEquals
import System

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    *(p + 3) *= 3
    Console.WriteLine(arr[3])
}

run()
";
        var output = CompileAndRun(Source, "Issue1925TimesEquals");
        Assert.Contains("33", output);
    }

    [Fact]
    public void DereferenceOfParenthesizedPointerArithmetic_CompoundAssignmentTarget_EvaluatesPointerExpressionOnce()
    {
        // The pointer expression (here `p + next()`) must be evaluated exactly
        // once by the compound-assignment desugaring, mirroring the
        // single-evaluation guarantee `CompoundIndexAssignmentExpressionSyntax`
        // gives an indexer receiver.
        const string Source = @"package Issue1925SingleEval
import System

var callCount int32 = 0

func next() int32 {
    callCount += 1
    return 1
}

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    *(p + next()) += 100
    Console.WriteLine(arr[1])
    Console.WriteLine(callCount)
}

run()
";
        var output = CompileAndRun(Source, "Issue1925SingleEval");
        var lines = output.Split(new[] { Environment.NewLine, "\n" }, StringSplitOptions.RemoveEmptyEntries);
        Assert.Contains("105", lines);
        Assert.Contains("1", lines);
    }

    private static string CompileAndRun(string source, string contextName)
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
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
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
