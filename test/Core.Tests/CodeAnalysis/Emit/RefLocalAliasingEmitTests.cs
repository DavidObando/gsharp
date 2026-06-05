// <copyright file="RefLocalAliasingEmitTests.cs" company="GSharp">
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
/// Issue #491 (ADR-0060 follow-up): end-to-end emit tests for ref-aliasing locals
/// declared with <c>let ref</c> / <c>var ref</c>. The IL slot for a ref-aliasing
/// local is a managed pointer <c>T&amp;</c>: reads emit <c>ldloc; ldind.*</c>, writes
/// emit <c>ldloc; value; stind.*</c>, and <c>&amp;m</c> emits <c>ldloc</c> (the slot
/// is already the alias).
/// </summary>
public class RefLocalAliasingEmitTests
{
    [Fact]
    public void LetRef_WriteThroughAlias_UpdatesUnderlyingVariable()
    {
        const string Source = @"package LetRefArr
import System

func tweak() {
    var arr = []int32{10, 20, 30}
    let ref m = arr[1]
    m = 99
    Console.WriteLine(arr[1])
}

tweak()
";
        var output = CompileAndRun(Source, "LetRefArr");
        Assert.Contains("99", output);
    }

    [Fact]
    public void LetRef_AliasPassedAsRefArg_BumpsUnderlying()
    {
        const string Source = @"package LetRefPass
import System

func bump(ref slot int32) {
    slot = slot + 1
}

func tweak() {
    var n int32 = 41
    let ref m = n
    bump(&m)
    Console.WriteLine(n)
}

tweak()
";
        var output = CompileAndRun(Source, "LetRefPass");
        Assert.Contains("42", output);
    }

    [Fact]
    public void VarRef_AliasStructField_WritesThroughAlias()
    {
        const string Source = @"package VarRefField
import System

type Counter struct {
    Value int32
}

func tweak() {
    var c Counter = Counter{Value: 5}
    var ref v = c.Value
    v = v + 100
    Console.WriteLine(c.Value)
}

tweak()
";
        var output = CompileAndRun(Source, "VarRefField");
        Assert.Contains("105", output);
    }

    [Fact]
    public void LetRef_ReadThroughAliasAndAssignmentExpression_ReturnsValue()
    {
        // Issue #491: the spill-collector / value-spill path produces correct
        // assignment-as-expression results for ref locals (parity with ref params).
        const string Source = @"package LetRefAssignExpr
import System

func tweak() {
    var n int32 = 0
    let ref m = n
    let r = (m = 17)
    Console.WriteLine(r)
    Console.WriteLine(n)
}

tweak()
";
        var output = CompileAndRun(Source, "LetRefAssignExpr");
        Assert.Contains("17", output);
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
