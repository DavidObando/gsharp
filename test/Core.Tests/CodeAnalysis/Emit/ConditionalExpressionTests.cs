// <copyright file="ConditionalExpressionTests.cs" company="GSharp">
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
/// ADR-0062: end-to-end emit and binder tests for the generalized two-arm
/// conditional (ternary) expression <c>cond ? a : b</c> in value context.
/// Byref/lvalue ref-arg ternaries continue to be covered by
/// <see cref="ConditionalRefArgumentEmitTests"/>.
/// </summary>
public class ConditionalExpressionTests
{
    [Fact]
    public void Ternary_ValueContext_TrueArmSelected()
    {
        const string Source = @"package CondTern1
import System

var pick = true
var x = pick ? 11 : 22
Console.WriteLine(x)
";
        var output = CompileAndRun(Source, "CondTern1");
        Assert.Contains("11", output);
    }

    [Fact]
    public void Ternary_ValueContext_FalseArmSelected()
    {
        const string Source = @"package CondTern2
import System

var pick = false
var x = pick ? 11 : 22
Console.WriteLine(x)
";
        var output = CompileAndRun(Source, "CondTern2");
        Assert.Contains("22", output);
    }

    [Fact]
    public void Ternary_StringArms()
    {
        const string Source = @"package CondTernStr
import System

var pick = true
Console.WriteLine(pick ? ""yes"" : ""no"")
";
        var output = CompileAndRun(Source, "CondTernStr");
        Assert.Contains("yes", output);
    }

    [Fact]
    public void Ternary_NumericTieBreak_PicksWiderType()
    {
        // int32 + int64 => int64 via the numeric tie-break.
        const string Source = @"package CondTernWiden
import System

var pick = true
var a int32 = 1
var b int64 = 2
var c = pick ? a : b
Console.WriteLine(c)
";
        var output = CompileAndRun(Source, "CondTernWiden");
        Assert.Contains("1", output);
    }

    [Fact]
    public void Ternary_RightAssociative_NestedFalseBranch()
    {
        // `a ? b : c ? d : e` parses as `a ? b : (c ? d : e)`.
        const string Source = @"package CondTernNest
import System

var a = false
var c = false
var v = a ? 1 : (c ? 2 : 3)
Console.WriteLine(v)
";
        var output = CompileAndRun(Source, "CondTernNest");
        Assert.Contains("3", output);
    }

    [Fact]
    public void Ternary_AsCallArgument()
    {
        const string Source = @"package CondTernArg
import System

var pick = true
Console.WriteLine(pick ? 10 : 20)
";
        var output = CompileAndRun(Source, "CondTernArg");
        Assert.Contains("10", output);
    }

    [Fact]
    public void Ternary_NoCommonType_ReportsGS0263()
    {
        // bool and string have no common type.
        const string Source = @"package CondTernNoCommon

var pick = true
var v = pick ? true : ""no""
";
        var diags = CompileExpectingDiagnostics(Source);
        Assert.Contains(diags, d => d.Id == "GS0263");
    }

    [Fact]
    public void Ternary_NonBoolCondition_Reports()
    {
        const string Source = @"package CondTernBadCond

var v = 1 ? 2 : 3
";
        var diags = CompileExpectingDiagnostics(Source);
        Assert.NotEmpty(diags);
    }

    [Fact]
    public void Ternary_InRefArgContext_StillUsesAddressPath()
    {
        // ADR-0062 §3: the generalized ternary in a ref-arg payload is
        // bound to the conditional-address path, preserving ADR-0061.
        const string Source = @"package CondTernRef
import System

func bump(ref c int32) {
    c = c + 1
}

var a = 0
var b = 0
var pick = true
bump(ref pick ? a : b)
Console.WriteLine(a)
Console.WriteLine(b)
";
        var output = CompileAndRun(Source, "CondTernRef");
        Assert.Contains("1", output);
        Assert.Contains("0", output);
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

    private static System.Collections.Generic.IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> CompileExpectingDiagnostics(string source)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.False(result.Success, "compilation was expected to fail: " + string.Join("; ", result.Diagnostics.Select(d => d.Id + ":" + d.Message)));
        return result.Diagnostics;
    }
}
