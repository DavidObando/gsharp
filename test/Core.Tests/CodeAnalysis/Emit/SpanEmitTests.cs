// <copyright file="SpanEmitTests.cs" company="GSharp">
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
/// ADR-0056 §1/§2: end-to-end emit tests for span element access. A span
/// indexer returns <c>ref readonly T</c> / <c>ref T</c>; reading
/// auto-dereferences (get_Item + ldobj/ldind), and a <c>Span[T]</c> write stores
/// through the returned managed pointer (get_Item + stobj/stind). Source is
/// compiled to a PE, loaded, invoked, and its stdout verified.
/// </summary>
public class SpanEmitTests
{
    [Fact]
    public void ReadOnlySpanElement_Read_Emits_And_Runs()
    {
        const string Source = @"package SpanReadEmit
import System

func sum(values []int32) int32 {
    var s ReadOnlySpan[int32] = values
    var total = 0
    var i = 0
    for i < s.Length {
        total = total + s[i]
        i = i + 1
    }
    return total
}

Console.WriteLine(sum([]int32{10, 20, 30}))
";
        var output = CompileAndRun(Source, "SpanReadEmit");
        Assert.Equal("60", output.Trim());
    }

    [Fact]
    public void SpanElement_Write_Emits_And_Runs()
    {
        const string Source = @"package SpanWriteEmit
import System

func writeBack(values []int32) int32 {
    var s Span[int32] = values
    s[0] = 100
    s[2] = 300
    return s[0] + s[1] + s[2]
}

Console.WriteLine(writeBack([]int32{1, 2, 3}))
";
        var output = CompileAndRun(Source, "SpanWriteEmit");
        Assert.Equal("402", output.Trim());
    }

    [Fact]
    public void SpanElement_WriteThenRead_RoundTrips()
    {
        const string Source = @"package SpanRoundTrip
import System

func roundTrip(values []int32) int32 {
    var s Span[int32] = values
    s[1] = 7
    return s[1]
}

Console.WriteLine(roundTrip([]int32{1, 2, 3}))
";
        var output = CompileAndRun(Source, "SpanRoundTrip");
        Assert.Equal("7", output.Trim());
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
