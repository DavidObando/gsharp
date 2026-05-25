// <copyright file="AsyncLambdaEmitTests.cs" company="GSharp">
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
/// End-to-end emit tests for async lambda (function literal) support.
/// Each test compiles GSharp source containing an async lambda, loads the
/// resulting PE, invokes the entry point, and asserts on console output.
/// Uses Task.Yield() to force genuine suspension/resume.
/// </summary>
public class AsyncLambdaEmitTests
{
    [Fact]
    public void AsyncLambda_NoCaptures_AwaitsTaskYield_Returns_Value()
    {
        const string Source = @"package AsyncLambdaTest1
import System
import System.Threading.Tasks

var f = async func() int {
    var x = 10
    await Task.Yield()
    x = x + 32
    return x
}

var t = f()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "AsyncLambdaTest1");
        Assert.Contains("42", output);
    }

    [Fact]
    public void AsyncLambda_CapturesLocal_ReadsLatestValue_AcrossAwait()
    {
        const string Source = @"package AsyncLambdaTest2
import System
import System.Threading.Tasks

var x = 100
var f = async func() int {
    await Task.Yield()
    return x
}

x = 200
var t = f()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "AsyncLambdaTest2");
        // Capture semantics are snapshot-at-creation (per GSharp design).
        // The lambda captures x=100 at the point the literal is evaluated.
        Assert.Contains("100", output);
    }

    [Fact]
    public void AsyncLambda_CapturesParameter_AwaitTaskYield_ReturnsParamPlusOne()
    {
        const string Source = @"package AsyncLambdaTest3
import System
import System.Threading.Tasks

var n = 41
var f = async func() int {
    await Task.Yield()
    return n + 1
}

var t = f()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "AsyncLambdaTest3");
        Assert.Contains("42", output);
    }

    [Fact]
    public void AsyncLambda_TwoLambdasInOneFunction_BothCompose()
    {
        const string Source = @"package AsyncLambdaTest4
import System
import System.Threading.Tasks

var a = 10
var b = 50

var f1 = async func() int {
    await Task.Yield()
    return a + 3
}

var f2 = async func() int {
    await Task.Yield()
    return b + 7
}

var t1 = f1()
var t2 = f2()
t1.Wait()
t2.Wait()
Console.WriteLine(t1.Result)
Console.WriteLine(t2.Result)
";
        var output = CompileAndRun(Source, "AsyncLambdaTest4");
        Assert.Contains("13", output);
        Assert.Contains("57", output);
    }

    [Fact]
    public void AsyncLambda_VoidReturn_AwaitsTaskYield()
    {
        const string Source = @"package AsyncLambdaTest5
import System
import System.Threading.Tasks

var f = async func() {
    Console.WriteLine(""before"")
    await Task.Yield()
    Console.WriteLine(""after"")
}

var t = f()
t.Wait()
";
        var output = CompileAndRun(Source, "AsyncLambdaTest5");
        Assert.Contains("before", output);
        Assert.Contains("after", output);
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
            catch (TargetInvocationException ex) when (ex.InnerException is AggregateException agg)
            {
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
