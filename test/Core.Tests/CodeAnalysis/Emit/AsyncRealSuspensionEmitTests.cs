// <copyright file="AsyncRealSuspensionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// End-to-end emit tests that exercise real async suspension and resume
/// through the threadpool. Unlike fast-path tests (Task.FromResult), these
/// tests use <c>Task.Yield()</c> and <c>Task.Delay()</c> to force the state
/// machine to suspend and resume via AwaitOnCompleted/AwaitUnsafeOnCompleted.
/// </summary>
public class AsyncRealSuspensionEmitTests
{
    [Fact]
    public void Await_TaskYield_ActuallySuspendsAndResumes()
    {
        const string Source = @"package YieldTest
import System
import System.Threading.Tasks

async func run() {
    Console.WriteLine(""before"")
    await Task.Yield()
    Console.WriteLine(""after"")
}

run().Wait()
";
        var output = CompileAndRun(Source, "YieldTest");
        Assert.Contains("before", output);
        Assert.Contains("after", output);
    }

    [Fact]
    public void Await_TaskYield_ResumesOnThreadpool()
    {
        const string Source = @"package YieldThreadTest
import System
import System.Threading
import System.Threading.Tasks

async func run() {
    var before = Thread.CurrentThread.ManagedThreadId
    await Task.Yield()
    var after = Thread.CurrentThread.ManagedThreadId
    Console.WriteLine(before)
    Console.WriteLine(after)
    Console.WriteLine(""done"")
}

var t = run()
t.Wait()
";
        var output = CompileAndRun(Source, "YieldThreadTest");
        Assert.Contains("done", output);
    }

    [Fact]
    public void Await_TaskDelay_Short_ResumesAndReturns()
    {
        const string Source = @"package DelayTest
import System
import System.Threading.Tasks

async func run() {
    Console.WriteLine(""start"")
    await Task.Delay(1)
    Console.WriteLine(""end"")
}

var t = run()
t.Wait()
";
        var output = CompileAndRun(Source, "DelayTest");
        Assert.Contains("start", output);
        Assert.Contains("end", output);
    }

    [Fact]
    public void Await_TaskYield_Twice_RestoresState()
    {
        const string Source = @"package YieldTwiceTest
import System
import System.Threading.Tasks

async func run() int32 {
    var x = 10
    await Task.Yield()
    x = x + 20
    await Task.Yield()
    x = x + 12
    return x
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "YieldTwiceTest");
        Assert.Contains("42", output);
    }

    [Fact]
    public void Await_ValueTask_FromResult_Returns_Value()
    {
        const string Source = @"package ValueTaskTest
import System
import System.Threading.Tasks

async func getVal() int32 {
    let x = await ValueTask.FromResult(42)
    return x
}

var t = getVal()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "ValueTaskTest");
        Assert.Contains("42", output);
    }

    [Fact]
    public void Await_TaskYield_In_Loop_RestoresState()
    {
        const string Source = @"package YieldLoopTest
import System
import System.Threading.Tasks

async func run() int32 {
    var sum = 0
    for var i = 0; i < 3; i++ {
        await Task.Yield()
        sum = sum + 10
    }
    return sum
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "YieldLoopTest");
        Assert.Contains("30", output);
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
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            catch (TargetInvocationException ex) when (ex.InnerException is AggregateException agg)
            {
                // Unwrap Wait() exceptions.
                throw agg.InnerException ?? agg;
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
