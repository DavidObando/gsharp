// <copyright file="ByRefEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// ADR-0039: End-to-end emit tests for by-ref pointer operations.
/// Compile GSharp source to PE, load, invoke, verify stdout/behavior.
/// </summary>
public class ByRefEmitTests
{
    [Fact]
    public void IntTryParse_Success_Emits_And_Runs()
    {
        const string Source = @"package TryParseSuccess
import System

var result = 0
var ok = Int32.TryParse(""42"", &result)
if ok {
    Console.WriteLine(result)
} else {
    Console.WriteLine(""failed"")
}
";
        var output = CompileAndRun(Source, "TryParseSuccess");
        Assert.Contains("42", output);
    }

    [Fact]
    public void IntTryParse_Failure_Emits_And_Runs()
    {
        const string Source = @"package TryParseFailure
import System

var result = 99
var ok = Int32.TryParse(""nope"", &result)
if ok {
    Console.WriteLine(""should not happen"")
} else {
    Console.WriteLine(""correctly failed"")
}
";
        var output = CompileAndRun(Source, "TryParseFailure");
        Assert.Contains("correctly failed", output);
    }

    [Fact]
    public void AddressOf_Local_Emits_Ldloca()
    {
        // Verifies that taking the address of a local and passing it to
        // a ref parameter works end-to-end through ldloca.
        const string Source = @"package LdlocaTest
import System
import System.Threading

var counter = 0
Interlocked.CompareExchange(&counter, 1, 0)
Console.WriteLine(counter)
";
        var output = CompileAndRun(Source, "LdlocaTest");
        Assert.Contains("1", output);
    }

    // ADR-0056 (#344) low-hanging-fruit #3: a `[]int32` argument flowing into a
    // `ReadOnlySpan[int32]` parameter goes through the `op_Implicit` conversion at
    // the call site, end-to-end, just like it already does at local-init position.
    [Fact]
    public void SliceArgument_ToReadOnlySpanParameter_Emits_And_Runs()
    {
        const string Source = @"package SliceToSpanArg
import System

func sum(s ReadOnlySpan[int32]) int32 {
    return s.Length
}

var nums []int32 = []int32{10, 20, 30}
Console.WriteLine(sum(nums))
";
        var output = CompileAndRun(Source, "SliceToSpanArg");
        Assert.Contains("3", output);
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
