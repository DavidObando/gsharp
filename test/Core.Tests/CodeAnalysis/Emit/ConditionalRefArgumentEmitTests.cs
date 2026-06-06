// <copyright file="ConditionalRefArgumentEmitTests.cs" company="GSharp">
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
/// ADR-0061: end-to-end emit and binder tests for conditional ref-argument
/// expressions of the form <c>f(ref cond ? a : b)</c>. Exercises all four
/// ref-kinds (<c>ref</c>/<c>out</c>/<c>in</c> + bare <c>&amp;</c>), the
/// parenthesised <c>&amp;(cond ? a : b)</c> form, inner-modifier matching,
/// and the bind-time validation diagnostics (branch type mismatch,
/// inline-decl-in-branch, inner-modifier mismatch, conditional-outside-ref).
/// </summary>
public class ConditionalRefArgumentEmitTests
{
    [Fact]
    public void RefConditional_SelectsTrueBranch_WhenConditionIsTrue()
    {
        const string Source = @"package CondRefTrue
import System

func bump(ref counter int32) {
    counter = counter + 1
}

var a = 10
var b = 20
var useA = true
bump(ref useA ? a : b)
Console.WriteLine(a)
Console.WriteLine(b)
";
        var output = CompileAndRun(Source, "CondRefTrue");
        Assert.Contains("11", output);
        Assert.Contains("20", output);
    }

    [Fact]
    public void RefConditional_SelectsFalseBranch_WhenConditionIsFalse()
    {
        const string Source = @"package CondRefFalse
import System

func bump(ref counter int32) {
    counter = counter + 1
}

var a = 10
var b = 20
var useA = false
bump(ref useA ? a : b)
Console.WriteLine(a)
Console.WriteLine(b)
";
        var output = CompileAndRun(Source, "CondRefFalse");
        Assert.Contains("10", output);
        Assert.Contains("21", output);
    }

    [Fact]
    public void RefConditional_InnerRefOnBranches_MatchesOuterRef()
    {
        const string Source = @"package CondRefInner
import System

func bump(ref counter int32) {
    counter = counter + 5
}

var a = 0
var b = 0
var useA = true
bump(ref useA ? ref a : ref b)
useA = false
bump(ref useA ? ref a : ref b)
Console.WriteLine(a)
Console.WriteLine(b)
";
        var output = CompileAndRun(Source, "CondRefInner");
        Assert.Contains("5", output);
    }

    [Fact]
    public void OutConditional_AssignsSelectedBranch()
    {
        const string Source = @"package CondOut
import System

func setTo(out target int32, v int32) {
    target = v
}

var a = 0
var b = 0
var useA = false
setTo(out useA ? a : b, 42)
Console.WriteLine(a)
Console.WriteLine(b)
";
        var output = CompileAndRun(Source, "CondOut");
        Assert.Contains("0", output);
        Assert.Contains("42", output);
    }

    [Fact]
    public void InConditional_ReadsSelectedBranch()
    {
        const string Source = @"package CondIn
import System

func readVia(in src int32) int32 {
    return src + 1
}

var a = 100
var b = 200
var useA = false
Console.WriteLine(readVia(in useA ? a : b))
";
        var output = CompileAndRun(Source, "CondIn");
        Assert.Contains("201", output);
    }

    [Fact]
    public void BareAmpersand_ParenthesizedConditional_ProducesPointer()
    {
        const string Source = @"package CondAmpParen
import System

func bump(ref counter int32) {
    counter = counter + 7
}

var a = 0
var b = 0
var useA = true
bump(&(useA ? a : b))
useA = false
bump(&(useA ? a : b))
Console.WriteLine(a)
Console.WriteLine(b)
";
        var output = CompileAndRun(Source, "CondAmpParen");
        Assert.Contains("7", output);
    }

    [Fact]
    public void RefConditional_OverImportedBclMethod_Interlocked()
    {
        const string Source = @"package CondInterlocked
import System
import System.Threading

var a = 0
var b = 0
var useA = true
Interlocked.Increment(ref useA ? a : b)
Console.WriteLine(a)
Console.WriteLine(b)
";
        var output = CompileAndRun(Source, "CondInterlocked");
        Assert.Contains("1", output);
        Assert.Contains("0", output);
    }

    [Fact]
    public void RefConditional_BranchTypeMismatch_ReportsDiagnostic()
    {
        const string Source = @"package CondTypeMismatch

func bump(ref counter int32) {
    counter = counter + 1
}

var a int32 = 0
var b int64 = 0
bump(ref true ? a : b)
";
        var diags = CompileExpectingDiagnostics(Source);
        Assert.Contains(diags, d => d.Id == "GS0260");
    }

    [Fact]
    public void RefConditional_NonLvalueBranch_ReportsDiagnostic()
    {
        const string Source = @"package CondNonLvalue

func bump(ref counter int32) {
    counter = counter + 1
}

var a = 0
bump(ref true ? a : (a + 1))
";
        var diags = CompileExpectingDiagnostics(Source);
        Assert.Contains(diags, d => d.Id == "GS9006" || d.Id == "GS0260" || d.Id == "GS0244"
                                    || d.Message.Contains("Cannot take address", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void RefConditional_InnerModifierMismatch_ReportsDiagnostic()
    {
        const string Source = @"package CondInnerMismatch

func bump(ref counter int32) {
    counter = counter + 1
}

var a = 0
var b = 0
bump(ref true ? in a : ref b)
";
        var diags = CompileExpectingDiagnostics(Source);
        Assert.Contains(diags, d => d.Id == "GS0262");
    }

    [Fact]
    public void OutConditional_InlineDeclInBranch_RejectedByParser()
    {
        // ADR-0061 §6: the inline-declaration `out var/let/_` form is not
        // syntactically reachable inside a conditional branch — the inner
        // modifier consumer only accepts `ref|in|out <identifier>`, never
        // `out var <ident>`. We assert that the program is rejected (the
        // exact diagnostic may be a parser error or GS0261).
        const string Source = @"package CondInlineDecl

func produce(out v int32) {
    v = 1
}

var a = 0
produce(out true ? a : out var n)
";
        var diags = CompileExpectingDiagnostics(Source);
        Assert.NotEmpty(diags);
    }

    [Fact]
    public void ConditionalRefArgument_OutsideRefContext_ReportsDiagnostic()
    {
        const string Source = @"package CondOutsideRef
import System

var a = 0
var b = 0
var useA = true
var picked = (useA ? a : b)
Console.WriteLine(picked)
";
        var diags = CompileExpectingDiagnostics(Source);
        Assert.Contains(diags, d => d.Id == "GS0259");
    }

    [Fact]
    public void RefConditional_ReadOnlyTarget_RejectedForRef()
    {
        const string Source = @"package CondRefReadOnly

func bump(ref counter int32) {
    counter = counter + 1
}

let a = 5
var b = 0
bump(ref true ? a : b)
";
        var diags = CompileExpectingDiagnostics(Source);
        Assert.Contains(diags, d => d.Id == "GS9005"
                                    || d.Message.Contains("constant", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void InConditional_ReadOnlyTarget_Accepted()
    {
        const string Source = @"package CondInReadOnly
import System

func doubleIt(in v int32) int32 {
    return v + v
}

let a = 11
var b = 22
var useA = true
Console.WriteLine(doubleIt(in useA ? a : b))
";
        var output = CompileAndRun(Source, "CondInReadOnly");
        Assert.Contains("22", output);
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
