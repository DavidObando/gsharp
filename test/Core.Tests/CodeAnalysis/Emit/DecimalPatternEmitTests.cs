// <copyright file="DecimalPatternEmitTests.cs" company="GSharp">
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
/// Regression coverage for issue #421 (P2-3): constant patterns over the
/// <c>decimal</c> struct type must not emit <c>Ceq</c> (undefined on struct
/// operands per ECMA-335 §III.4). The emitter must route through
/// <c>decimal.op_Equality</c> so the produced IL is verifiable and the
/// runtime actually executes the comparison.
/// </summary>
public class DecimalPatternEmitTests
{
    [Fact]
    public void Switch_DecimalConstantPattern_Matches()
    {
        const string Source = @"package DecPatMatch
import System
let v = 1.5m
let x = switch v { case 1.5m -> ""hit"" default -> ""miss"" }
Console.WriteLine(x)
";
        var output = CompileLoadInvokeCaptureStdout(Source, nameof(Switch_DecimalConstantPattern_Matches));
        Assert.Contains("hit", output);
    }

    [Fact]
    public void Switch_DecimalConstantPattern_DoesNotMatch_FallsThroughToDefault()
    {
        const string Source = @"package DecPatMiss
import System
let v = 2.5m
let x = switch v { case 1.5m -> ""hit"" default -> ""miss"" }
Console.WriteLine(x)
";
        var output = CompileLoadInvokeCaptureStdout(Source, nameof(Switch_DecimalConstantPattern_DoesNotMatch_FallsThroughToDefault));
        Assert.Contains("miss", output);
    }

    [Fact]
    public void Switch_DecimalConstantPattern_PicksCorrectArmAmongMany()
    {
        const string Source = @"package DecPatMulti
import System
let v = 3.25m
let x = switch v {
    case 1.0m -> ""one""
    case 2.0m -> ""two""
    case 3.25m -> ""three-quarter""
    default -> ""other""
}
Console.WriteLine(x)
";
        var output = CompileLoadInvokeCaptureStdout(Source, nameof(Switch_DecimalConstantPattern_PicksCorrectArmAmongMany));
        Assert.Contains("three-quarter", output);
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
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
