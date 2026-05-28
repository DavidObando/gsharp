// <copyright file="AsyncExceptionEmitTests.cs" company="GSharp">
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
/// End-to-end PE round-trip tests for the async exception handler rewriter.
/// Verifies that try/catch/finally with await compile and produce correct results.
/// </summary>
public class AsyncExceptionEmitTests
{
    [Fact]
    public void AsyncFunction_With_TryFinally_NoAwait_Runs()
    {
        const string Source = @"package AsyncExhNoAwait
import System
import System.Threading.Tasks

async func run() int32 {
    var result = 0
    try {
        result = 42
    } finally {
        result = result + 1
    }
    return result
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "AsyncExhNoAwait");
        Assert.Contains("43", output);
    }

    [Fact]
    public void AsyncFunction_With_AwaitInFinally_RunsFinallyAfterTry()
    {
        const string Source = @"package AsyncExhAwaitFinally
import System
import System.Threading.Tasks

async func run() int32 {
    var result = 0
    try {
        result = 10
    } finally {
        let extra = await Task.FromResult(32)
        result = result + extra
    }
    return result
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "AsyncExhAwaitFinally");
        Assert.Contains("42", output);
    }

    [Fact]
    public void AsyncFunction_With_TryCatch_AwaitInCatch_HandlesException()
    {
        const string Source = @"package AsyncExhAwaitCatch
import System
import System.Threading.Tasks

async func run() int32 {
    var result = 0
    try {
        var n = Int32.Parse(""bad"")
        result = n
    } catch (e Exception) {
        let fallback = await Task.FromResult(42)
        result = fallback
    }
    return result
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "AsyncExhAwaitCatch");
        Assert.Contains("42", output);
    }

    [Fact]
    public void AsyncFunction_With_TryFinally_AwaitInFinally_PropagatesException()
    {
        // Verifies that an exception from the try body propagates through
        // the rewritten finally (Pattern B) after the finally body executes.
        // Note: We avoid nesting inside another try/catch because the state
        // machine emitter does not yet support await inside nested try blocks
        // (the suspension br illegally crosses try boundaries).
        const string Source = @"package AsyncExhPropagates
import System
import System.Threading.Tasks

async func run() int32 {
    var result = 0
    try {
        var n = Int32.Parse(""bad"")
        result = n
    } finally {
        let extra = await Task.FromResult(1)
        result = result + extra
    }
    return result
}

var t = run()
try {
    t.Wait()
} catch (e Exception) {
}
Console.WriteLine(t.IsFaulted)
";
        var output = CompileAndRun(Source, "AsyncExhPropagates");
        Assert.Contains("True", output);
    }

    [Fact]
    public void AsyncFunction_NoException_AwaitInFinally_DoesNotThrow()
    {
        const string Source = @"package AsyncExhNoThrow
import System
import System.Threading.Tasks

async func run() int32 {
    var result = 10
    try {
        result = result + 20
    } finally {
        let bonus = await Task.FromResult(12)
        result = result + bonus
    }
    return result
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "AsyncExhNoThrow");
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
            catch (TargetInvocationException tie)
            {
                Console.SetOut(stdout);
                throw new Exception(
                    $"Entry point threw: {tie.InnerException?.GetType().Name}: {tie.InnerException?.Message}",
                    tie.InnerException);
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
