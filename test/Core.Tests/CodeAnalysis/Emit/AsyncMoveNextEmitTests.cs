// <copyright file="AsyncMoveNextEmitTests.cs" company="GSharp">
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
/// End-to-end emit tests for the async MoveNext per-await dispatch pipeline.
/// Each test compiles a GSharp source containing one or more `await` expressions
/// at statement top-level, loads the resulting PE, runs it, and asserts the
/// captured stdout. Awaits that resolve synchronously exercise the fast path
/// (no real suspension); `Task.Yield` exercises the suspend/resume path through
/// AwaitOnCompleted.
/// </summary>
public class AsyncMoveNextEmitTests
{
    [Fact]
    public void Await_CompletedTask_AsStatement_Runs()
    {
        const string Source = @"package AwaitCompletedTest
import System
import System.Threading.Tasks

async func doIt() {
    await Task.CompletedTask
    Console.WriteLine(""after"")
}

doIt().Wait()
Console.WriteLine(""done"")
";
        var output = CompileAndRun(Source, "AwaitCompletedTest");
        Assert.Contains("after", output);
        Assert.Contains("done", output);
    }

    [Fact]
    public void Await_TaskFromResult_ReturnValue_Funnels_Through_SetResult()
    {
        const string Source = @"package AwaitFromResultTest
import System
import System.Threading.Tasks

async func getVal() int32 {
    let x = await Task.FromResult(42)
    return x
}

var t = getVal()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "AwaitFromResultTest");
        Assert.Contains("42", output);
    }

    [Fact]
    public void Await_TwoSequentialAwaits_BothRun()
    {
        const string Source = @"package TwoAwaitsTest
import System
import System.Threading.Tasks

async func doIt() int32 {
    let a = await Task.FromResult(10)
    let b = await Task.FromResult(32)
    return a + b
}

var t = doIt()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "TwoAwaitsTest");
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
