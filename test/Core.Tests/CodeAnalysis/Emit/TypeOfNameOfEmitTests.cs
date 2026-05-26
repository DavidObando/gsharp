// <copyright file="TypeOfNameOfEmitTests.cs" company="GSharp">
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
/// Issue #143: emit tests for <c>typeof(T)</c> and <c>nameof(expr)</c>.
/// Compiles a tiny GSharp program, loads the produced PE, invokes the entry
/// point, and validates that the CLR-visible <see cref="Type"/> /
/// <see cref="string"/> match expectations.
/// </summary>
public class TypeOfNameOfEmitTests
{
    [Fact]
    public void TypeOf_Int_Emits_SystemInt32()
    {
        var output = CompileAndRun(@"
package TypeOfIntTest
import System
var t = typeof(int)
Console.WriteLine(t.FullName)
", nameof(TypeOf_Int_Emits_SystemInt32));
        Assert.Contains("System.Int32", output);
    }

    [Fact]
    public void TypeOf_String_Emits_SystemString()
    {
        var output = CompileAndRun(@"
package TypeOfStringTest
import System
var t = typeof(string)
Console.WriteLine(t.FullName)
", nameof(TypeOf_String_Emits_SystemString));
        Assert.Contains("System.String", output);
    }

    [Fact]
    public void TypeOf_NullableInt_Emits_SystemNullable()
    {
        var output = CompileAndRun(@"
package TypeOfNullableTest
import System
var t = typeof(int?)
Console.WriteLine(t.FullName)
", nameof(TypeOf_NullableInt_Emits_SystemNullable));
        Assert.Contains("System.Nullable", output);
        Assert.Contains("System.Int32", output);
    }

    [Fact]
    public void TypeOf_SliceOfInt_Emits_IntArray()
    {
        var output = CompileAndRun(@"
package TypeOfSliceTest
import System
var t = typeof([]int)
Console.WriteLine(t.FullName)
", nameof(TypeOf_SliceOfInt_Emits_IntArray));
        Assert.Contains("System.Int32[]", output);
    }

    [Fact]
    public void NameOf_Local_Emits_Identifier_String()
    {
        var output = CompileAndRun(@"
package NameOfLocalTest
import System
var counter = 7
var n = nameof(counter)
Console.WriteLine(n)
", nameof(NameOf_Local_Emits_Identifier_String));
        Assert.Contains("counter", output);
    }

    [Fact]
    public void NameOf_Member_Access_Emits_Rightmost_Name()
    {
        var output = CompileAndRun(@"
package NameOfMemberTest
import System
var n = nameof(Console.WriteLine)
Console.WriteLine(n)
", nameof(NameOf_Member_Access_Emits_Rightmost_Name));
        Assert.Contains("WriteLine", output);
    }

    private static EmitResult Compile(string source, Stream peStream)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Emit(peStream);
    }

    private static string CompileAndRun(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
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
