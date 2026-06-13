// <copyright file="Issue795DefaultExpressionEmitTests.cs" company="GSharp">
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
/// Issue #795 / ADR-0100: end-to-end emit tests that compile a G#
/// program using the new <c>default(T)</c> and bare <c>default</c>
/// expression forms, load the emitted assembly and run its entry point,
/// asserting on the captured stdout. These prove that the lowering pass
/// pre-allocates a slot for every value-type / type-parameter default
/// site and that the emitter produces verifiable IL
/// (<c>ldnull</c> for reference types; <c>ldloca; initobj T; ldloc</c>
/// for value types and unconstrained type parameters).
/// </summary>
public class Issue795DefaultExpressionEmitTests
{
    [Fact]
    public void Default_Int32_ReturnsZero()
    {
        const string Source = @"package main
import System
Console.WriteLine(default(int32))
";
        var lines = CompileAndRun(Source, "Issue795-Default-Int32");
        Assert.Equal("0", lines[0]);
    }

    [Fact]
    public void Default_String_ReturnsNull()
    {
        const string Source = @"package main
import System
let s string = default(string)
Console.WriteLine(s == nil)
";
        var lines = CompileAndRun(Source, "Issue795-Default-String");
        Assert.Equal("True", lines[0]);
    }

    [Fact]
    public void Default_Float64_ReturnsZero()
    {
        const string Source = @"package main
import System
Console.WriteLine(default(float64))
";
        var lines = CompileAndRun(Source, "Issue795-Default-Float");
        Assert.Equal("0", lines[0]);
    }

    [Fact]
    public void Default_Bool_ReturnsFalse()
    {
        const string Source = @"package main
import System
Console.WriteLine(default(bool))
";
        var lines = CompileAndRun(Source, "Issue795-Default-Bool");
        Assert.Equal("False", lines[0]);
    }

    [Fact]
    public void BareDefault_InTypedLet_Works()
    {
        const string Source = @"package main
import System
let x int32 = default
Console.WriteLine(x)
";
        var lines = CompileAndRun(Source, "Issue795-BareDefault-Let");
        Assert.Equal("0", lines[0]);
    }

    [Fact]
    public void BareDefault_InReturn_Works()
    {
        const string Source = @"package main
import System
func zero() int32 {
    return default
}
Console.WriteLine(zero())
";
        var lines = CompileAndRun(Source, "Issue795-BareDefault-Return");
        Assert.Equal("0", lines[0]);
    }

    [Fact]
    public void GenericDefault_OfUnconstrainedT_ForValueType_ReturnsZero()
    {
        // The interesting case from the issue: default(T) for an
        // unconstrained type parameter MUST emit `ldloca; initobj T;
        // ldloc` so the value-type case lights up at runtime with a
        // zero-initialised value.
        const string Source = @"package main
import System
func MakeZero[T]() T {
    return default(T)
}
Console.WriteLine(MakeZero[int32]())
";
        var lines = CompileAndRun(Source, "Issue795-GenericDefault-Value");
        Assert.Equal("0", lines[0]);
    }

    [Fact]
    public void GenericDefault_OfUnconstrainedT_ForReferenceType_ReturnsNull()
    {
        const string Source = @"package main
import System
func MakeZero[T]() T {
    return default(T)
}
let s = MakeZero[string]()
Console.WriteLine(s == nil)
";
        var lines = CompileAndRun(Source, "Issue795-GenericDefault-Ref");
        Assert.Equal("True", lines[0]);
    }

    [Fact]
    public void Default_NullableInt_ReturnsNull()
    {
        const string Source = @"package main
import System
let x int32? = default(int32?)
Console.WriteLine(x == nil)
";
        var lines = CompileAndRun(Source, "Issue795-Default-NullableInt");
        Assert.Equal("True", lines[0]);
    }

    [Fact]
    public void BareDefault_InCallArgument_Works()
    {
        const string Source = @"package main
import System
func echo(x int32) int32 {
    return x
}
Console.WriteLine(echo(default))
";
        var lines = CompileAndRun(Source, "Issue795-BareDefault-CallArg");
        Assert.Equal("0", lines[0]);
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
