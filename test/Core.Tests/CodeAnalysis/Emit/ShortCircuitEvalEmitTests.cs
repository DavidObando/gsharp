// <copyright file="ShortCircuitEvalEmitTests.cs" company="GSharp">
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
/// Regression tests for issue #419 (P0-1): the logical operators `&amp;&amp;`
/// and `||` must short-circuit — the right operand must NOT be evaluated when
/// the left operand already determines the result.
/// </summary>
public class ShortCircuitEvalEmitTests
{
    [Fact]
    public void LogicalAnd_DoesNotEvaluateRight_WhenLeftIsFalse()
    {
        const string Source = @"package ShortAndFalse
import System
var counter = 0
func sideEffect() bool {
    counter = counter + 1
    return true
}
var r = false && sideEffect()
Console.WriteLine(counter)
Console.WriteLine(r)
";
        var lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "ShortCircuit-AndFalse"));
        Assert.Equal("0", lines[0]);
        Assert.Equal("False", lines[1]);
    }

    [Fact]
    public void LogicalOr_DoesNotEvaluateRight_WhenLeftIsTrue()
    {
        const string Source = @"package ShortOrTrue
import System
var counter = 0
func sideEffect() bool {
    counter = counter + 1
    return false
}
var r = true || sideEffect()
Console.WriteLine(counter)
Console.WriteLine(r)
";
        var lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "ShortCircuit-OrTrue"));
        Assert.Equal("0", lines[0]);
        Assert.Equal("True", lines[1]);
    }

    [Fact]
    public void LogicalAnd_EvaluatesRight_WhenLeftIsTrue()
    {
        const string Source = @"package ShortAndTrue
import System
var counter = 0
func sideEffect() bool {
    counter = counter + 1
    return true
}
var r = true && sideEffect()
Console.WriteLine(counter)
Console.WriteLine(r)
";
        var lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "ShortCircuit-AndTrue"));
        Assert.Equal("1", lines[0]);
        Assert.Equal("True", lines[1]);
    }

    [Fact]
    public void LogicalOr_EvaluatesRight_WhenLeftIsFalse()
    {
        const string Source = @"package ShortOrFalse
import System
var counter = 0
func sideEffect() bool {
    counter = counter + 1
    return true
}
var r = false || sideEffect()
Console.WriteLine(counter)
Console.WriteLine(r)
";
        var lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "ShortCircuit-OrFalse"));
        Assert.Equal("1", lines[0]);
        Assert.Equal("True", lines[1]);
    }

    [Fact]
    public void LogicalAnd_ChainsShortCircuit_StopsAtFirstFalse()
    {
        const string Source = @"package ShortAndChain
import System
var aCount = 0
var bCount = 0
var cCount = 0
func a() bool {
    aCount = aCount + 1
    return true
}
func b() bool {
    bCount = bCount + 1
    return false
}
func c() bool {
    cCount = cCount + 1
    return true
}
var r = a() && b() && c()
Console.WriteLine(aCount)
Console.WriteLine(bCount)
Console.WriteLine(cCount)
Console.WriteLine(r)
";
        var lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "ShortCircuit-AndChain"));
        Assert.Equal("1", lines[0]);
        Assert.Equal("1", lines[1]);
        Assert.Equal("0", lines[2]);
        Assert.Equal("False", lines[3]);
    }

    [Fact]
    public void LogicalOr_ChainsShortCircuit_StopsAtFirstTrue()
    {
        const string Source = @"package ShortOrChain
import System
var aCount = 0
var bCount = 0
var cCount = 0
func a() bool {
    aCount = aCount + 1
    return false
}
func b() bool {
    bCount = bCount + 1
    return true
}
func c() bool {
    cCount = cCount + 1
    return false
}
var r = a() || b() || c()
Console.WriteLine(aCount)
Console.WriteLine(bCount)
Console.WriteLine(cCount)
Console.WriteLine(r)
";
        var lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "ShortCircuit-OrChain"));
        Assert.Equal("1", lines[0]);
        Assert.Equal("1", lines[1]);
        Assert.Equal("0", lines[2]);
        Assert.Equal("True", lines[3]);
    }

    private static string[] SplitLines(string output) =>
        output.Replace("\r\n", "\n").TrimEnd('\n').Split('\n');

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
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
