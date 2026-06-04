// <copyright file="IndexAssignmentSideEffectTests.cs" company="GSharp">
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
/// Issue #418 (P1-1): the index expression of an indexed assignment used to be
/// emitted twice — once for the store and once for the read-back that becomes
/// the assignment's result. Any observable side effect (e.g. a function call)
/// fired twice. These tests cover the array, map, and CLR-indexer (List[T])
/// paths so all three emit sites stay fixed.
/// </summary>
public class IndexAssignmentSideEffectTests
{
    [Fact]
    public void Array_Index_Expression_Evaluated_Once()
    {
        const string Source = @"package main
import System
var calls = 0
func next() int32 {
    calls = calls + 1
    return 0
}
var a = []int32{0, 0}
a[next()] = 7
Console.WriteLine(calls)
Console.WriteLine(a[0])
Console.WriteLine(a[1])
";
        var lines = CompileAndRun(Source, "IndexAssignmentSideEffectTests-Array");
        Assert.Equal("1", lines[0]);
        Assert.Equal("7", lines[1]);
        Assert.Equal("0", lines[2]);
    }

    [Fact]
    public void Array_Index_Assignment_Expression_Result_Is_Assigned_Value()
    {
        // The result of the assignment expression should still be the assigned
        // value even though we no longer re-read it from the array.
        const string Source = @"package main
import System
var a = []int32{0, 0, 0}
var v = (a[1] = 42)
Console.WriteLine(v)
Console.WriteLine(a[1])
";
        var lines = CompileAndRun(Source, "IndexAssignmentSideEffectTests-ArrayResult");
        Assert.Equal("42", lines[0]);
        Assert.Equal("42", lines[1]);
    }

    [Fact]
    public void Map_Index_Expression_Evaluated_Once()
    {
        const string Source = @"package main
import System
var calls = 0
func key() string {
    calls = calls + 1
    return ""k""
}
var m = map[string]int32{}
m[key()] = 7
Console.WriteLine(calls)
Console.WriteLine(m[""k""])
";
        var lines = CompileAndRun(Source, "IndexAssignmentSideEffectTests-Map");
        Assert.Equal("1", lines[0]);
        Assert.Equal("7", lines[1]);
    }

    [Fact]
    public void Map_Index_Assignment_Expression_Result_Is_Assigned_Value()
    {
        const string Source = @"package main
import System
var m = map[string]int32{}
var v = (m[""x""] = 99)
Console.WriteLine(v)
Console.WriteLine(m[""x""])
";
        var lines = CompileAndRun(Source, "IndexAssignmentSideEffectTests-MapResult");
        Assert.Equal("99", lines[0]);
        Assert.Equal("99", lines[1]);
    }

    [Fact]
    public void Clr_Indexer_Argument_Evaluated_Once()
    {
        // List[T].set_Item is the BoundClrIndexAssignmentExpression path.
        const string Source = @"package main
import System
import System.Collections.Generic
var calls = 0
func at() int32 {
    calls = calls + 1
    return 0
}
var list = List[int32]()
list.Add(0)
list.Add(0)
list[at()] = 5
Console.WriteLine(calls)
Console.WriteLine(list[0])
";
        var lines = CompileAndRun(Source, "IndexAssignmentSideEffectTests-Clr");
        Assert.Equal("1", lines[0]);
        Assert.Equal("5", lines[1]);
    }

    [Fact]
    public void Clr_Indexer_Assignment_Expression_Result_Is_Assigned_Value()
    {
        const string Source = @"package main
import System
import System.Collections.Generic
var list = List[int32]()
list.Add(0)
var v = (list[0] = 11)
Console.WriteLine(v)
Console.WriteLine(list[0])
";
        var lines = CompileAndRun(Source, "IndexAssignmentSideEffectTests-ClrResult");
        Assert.Equal("11", lines[0]);
        Assert.Equal("11", lines[1]);
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
                entry!.Invoke(null, parameters: null);
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
