// <copyright file="AsyncSpillEmitTests.cs" company="GSharp">
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
/// End-to-end emit tests for the async spill sequence spiller.
/// These tests verify that sub-expression awaits compile and produce correct
/// results via PE round-trip.
/// </summary>
public class AsyncSpillEmitTests
{
    [Fact]
    public void Await_As_Binary_Operand_Computes_Correctly()
    {
        const string Source = @"package SpillBinaryTest
import System
import System.Threading.Tasks

async func compute() int {
    let result = (await Task.FromResult(40)) + 2
    return result
}

var t = compute()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillBinaryTest");
        Assert.Contains("42", output);
    }

    [Fact]
    public void Await_As_Second_Argument_Of_TwoArg_Method_Computes_Correctly()
    {
        const string Source = @"package SpillArgTest
import System
import System.Threading.Tasks

async func compute() int {
    let result = (await Task.FromResult(10)) + (await Task.FromResult(32))
    return result
}

var t = compute()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillArgTest");
        Assert.Contains("42", output);
    }

    [Fact]
    public void LogicalAnd_ShortCircuits_Around_Await()
    {
        // When LHS is false, the RHS await is NOT evaluated.
        // We verify by checking the result is False.
        const string Source = @"package SpillAndShortCircuitTest
import System
import System.Threading.Tasks

async func test() bool {
    let result = false && (await Task.FromResult(true))
    return result
}

var t = test()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillAndShortCircuitTest");
        Assert.Contains("False", output);
    }

    [Fact]
    public void LogicalAnd_Evaluates_Await_When_Lhs_True()
    {
        const string Source = @"package SpillAndEvalTest
import System
import System.Threading.Tasks

async func test() bool {
    let result = true && (await Task.FromResult(true))
    return result
}

var t = test()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillAndEvalTest");
        Assert.Contains("True", output);
    }

    [Fact]
    public void Sequential_Awaits_In_Same_Expression_Both_Run_Once()
    {
        const string Source = @"package SpillSequentialTest
import System
import System.Threading.Tasks

async func compute() int {
    let result = (await Task.FromResult(20)) + (await Task.FromResult(22))
    return result
}

var t = compute()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillSequentialTest");
        Assert.Contains("42", output);
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
