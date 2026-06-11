// <copyright file="AsyncRefLocalEmitTests.cs" company="GSharp">
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
/// End-to-end PE round-trip tests for ref locals in async state machines.
/// Verifies that ref locals across await boundaries compile and produce correct results.
/// </summary>
public class AsyncRefLocalEmitTests
{
    [Fact]
    public void RefLocal_To_Local_Across_Await_ReadsCurrentValue()
    {
        // Declares a ref local pointing to a local, awaits, then writes to the
        // original local and reads through the (conceptual) ref local.
        const string Source = @"package AsyncRefLocal1
import System
import System.Threading.Tasks

async func run() int32 {
    var x = 10
    var slot = &x
    let added = await Task.FromResult(32)
    x = added + 10
    return *slot
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "AsyncRefLocal1");
        Assert.Contains("42", output);
    }

    [Fact]
    public void RefLocal_To_ArrayElement_Across_Await_RoundTrips()
    {
        // Declares a ref local pointing to an array element, awaits, then
        // reads through the ref local to verify the element value.
        const string Source = @"package AsyncRefArr
import System
import System.Threading.Tasks

async func run() int32 {
    var arr = [3]int32{10, 20, 30}
    var i = 1
    var slot = &arr[i]
    let delta = await Task.FromResult(22)
    return *slot + delta
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "AsyncRefArr");
        Assert.Contains("42", output);
    }

    [Fact]
    public void RefLocal_Used_Only_Before_Await_DoesNotRequireHoisting()
    {
        // The ref local is only used before the await — still must produce valid IL.
        const string Source = @"package AsyncRefBeforeAwait
import System
import System.Threading.Tasks

async func run() int32 {
    var x = 40
    var slot = &x
    var before = *slot
    let extra = await Task.FromResult(2)
    return before + extra
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "AsyncRefBeforeAwait");
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
