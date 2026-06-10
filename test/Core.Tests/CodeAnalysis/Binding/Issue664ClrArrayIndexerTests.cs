// <copyright file="Issue664ClrArrayIndexerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #664 — CLR <c>T[]</c> arrays (e.g. the result of <c>string.Split</c>,
/// <c>.ToArray()</c>, or any imported method returning a CLR array) must be
/// indexable with <c>arr[i]</c> for both read and write.
/// </summary>
public class Issue664ClrArrayIndexerTests
{
    [Fact]
    public void ReadIndex_StringArray_FromSplit_Compiles()
    {
        var source = @"
package P
import System

let parts = ""a,b,c"".Split("","")
let first = parts[0]
";
        AssertCompilesWithoutErrors(source);
    }

    [Fact]
    public void ReadIndex_IntArray_FromLinq_Compiles()
    {
        var source = @"
package P
import System
import System.Linq

let arr = Enumerable.ToArray[int32](Enumerable.Range(0, 5))
let v = arr[2]
";
        AssertCompilesWithoutErrors(source);
    }

    [Fact]
    public void ReadIndex_ObjectArray_Compiles()
    {
        var source = @"
package P
import System

let arr = Environment.GetCommandLineArgs()
let first = arr[0]
";
        AssertCompilesWithoutErrors(source);
    }

    [Fact]
    public void WriteIndex_StringArray_Compiles()
    {
        var source = @"
package P
import System

var parts = ""a,b,c"".Split("","")
parts[0] = ""z""
";
        AssertCompilesWithoutErrors(source);
    }

    [Fact]
    public void WriteIndex_IntArray_Compiles()
    {
        var source = @"
package P
import System
import System.Linq

var arr = Enumerable.ToArray[int32](Enumerable.Range(0, 5))
arr[0] = 99
";
        AssertCompilesWithoutErrors(source);
    }

    [Fact]
    public void GSharpSlice_StillIndexable()
    {
        var source = @"
package P

var xs = []int32{1, 2, 3}
let v = xs[0]
xs[1] = 42
";
        AssertCompilesWithoutErrors(source);
    }

    [Fact]
    public void List_StillIndexable()
    {
        var source = @"
package P
import System.Collections.Generic

var list = List[int32]()
list.Add(10)
let v = list[0]
";
        AssertCompilesWithoutErrors(source);
    }

    [Fact]
    public void NonIndexableType_StillProducesGS0116()
    {
        var source = @"
package P
import System.IO

var s = Stream.Null
let v = s[0]
";
        var diagnostics = EmitDiagnostics(source);
        Assert.Contains(diagnostics, d => d.IsError && d.Message.Contains("not indexable"));
    }

    private static void AssertCompilesWithoutErrors(string source)
    {
        var diagnostics = EmitDiagnostics(source, out var success);
        Assert.True(
            success,
            "Emit failed:\n" + string.Join("\n", diagnostics.Select(d => d.ToString())));
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    private static IReadOnlyList<Diagnostic> EmitDiagnostics(string source)
        => EmitDiagnostics(source, out _);

    private static IReadOnlyList<Diagnostic> EmitDiagnostics(string source, out bool success)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        success = result.Success;
        return result.Diagnostics;
    }
}
