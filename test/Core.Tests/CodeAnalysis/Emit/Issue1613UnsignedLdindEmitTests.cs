// <copyright file="Issue1613UnsignedLdindEmitTests.cs" company="GSharp">
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
/// Issue #1613: <c>EmitLoadIndirect</c> used <c>ldind.i1</c>/<c>ldind.i2</c> for
/// unsigned pointees (uint8/uint16/char/bool), sign-extending values with the
/// high bit set. A ref/out param or ref-aliasing local dereference of such a
/// value produced a negative int32 instead of the correct unsigned widening.
/// Mirrors the already-correct <c>EmitLoadElement</c> fix from issue #520.
/// </summary>
public class Issue1613UnsignedLdindEmitTests
{
    [Fact]
    public void RefUInt8Parameter_HighBitSet_ReadsAsUnsigned()
    {
        const string Source = @"package Issue1613RefUInt8
import System

func checkByte(ref b uint8) {
    if b == 200 {
        Console.WriteLine(""ok"")
    } else {
        Console.WriteLine(""bad"")
    }
}

var v uint8 = 200
checkByte(&v)
";
        var output = CompileAndRun(Source, "Issue1613RefUInt8");
        Assert.Contains("ok", output);
    }

    [Fact]
    public void RefUInt16Parameter_HighBitSet_ReadsAsUnsigned()
    {
        const string Source = @"package Issue1613RefUInt16
import System

func checkUShort(ref u uint16) {
    if u == 40000 {
        Console.WriteLine(""ok"")
    } else {
        Console.WriteLine(""bad"")
    }
}

var v uint16 = 40000
checkUShort(&v)
";
        var output = CompileAndRun(Source, "Issue1613RefUInt16");
        Assert.Contains("ok", output);
    }

    [Fact]
    public void OutUInt8Parameter_HighBitSet_FlowsBackAsUnsigned()
    {
        const string Source = @"package Issue1613OutUInt8
import System

func produce(out b uint8) {
    b = 200
}

var r uint8 = 0
produce(&r)
Console.WriteLine(r)
";
        var output = CompileAndRun(Source, "Issue1613OutUInt8");
        Assert.Contains("200", output);
        Assert.DoesNotContain("-56", output);
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
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
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
