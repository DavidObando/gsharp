// <copyright file="Issue1279ArrayIndexTypesEmitTests.cs" company="GSharp">
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
/// Issue #1279: array/slice element access accepts any integer-typed index.
/// The narrower types convert to int32 and the wider integer types
/// (uint32/int64/uint64/nint/nuint) convert to native int — both valid CIL
/// ldelem/stelem index operands. These tests verify the correct element is
/// read and written at runtime for every supported index type.
/// </summary>
public class Issue1279ArrayIndexTypesEmitTests
{
    [Theory]
    [InlineData("int8")]
    [InlineData("uint8")]
    [InlineData("int16")]
    [InlineData("uint16")]
    [InlineData("char")]
    [InlineData("int32")]
    [InlineData("uint32")]
    [InlineData("int64")]
    [InlineData("uint64")]
    [InlineData("nint")]
    [InlineData("nuint")]
    public void ArrayRead_WithIntegerIndex_ReadsCorrectElement(string indexType)
    {
        // a[2] == 30, indexed via a value of `indexType`.
        var source = $@"package main
import System
var a = []int32{{10, 20, 30, 40}}
var i = {indexType}(2)
Console.WriteLine(a[i])
";
        var lines = CompileAndRun(source, "Issue1279-Read-" + indexType);
        Assert.Equal("30", lines[0]);
    }

    [Theory]
    [InlineData("int8")]
    [InlineData("uint8")]
    [InlineData("int16")]
    [InlineData("uint16")]
    [InlineData("char")]
    [InlineData("int32")]
    [InlineData("uint32")]
    [InlineData("int64")]
    [InlineData("uint64")]
    [InlineData("nint")]
    [InlineData("nuint")]
    public void ArrayWrite_WithIntegerIndex_WritesCorrectElement(string indexType)
    {
        // a[3] = 99 via a `indexType` index, then read it back.
        var source = $@"package main
import System
var a = []int32{{0, 0, 0, 0}}
var i = {indexType}(3)
a[i] = 99
Console.WriteLine(a[3])
";
        var lines = CompileAndRun(source, "Issue1279-Write-" + indexType);
        Assert.Equal("99", lines[0]);
    }

    [Fact]
    public void ArrayCompoundAssignment_WithWideIndex_Works()
    {
        var source = @"package main
import System
var a = []int32{1, 2, 3, 4}
var i = int64(1)
a[i] += 40
Console.WriteLine(a[1])
";
        var lines = CompileAndRun(source, "Issue1279-Compound");
        Assert.Equal("42", lines[0]);
    }

    private static string[] CompileAndRun(string source, string contextName)
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

            return captured.ToString().Replace("\r\n", "\n").TrimEnd('\n').Split('\n');
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
