// <copyright file="Issue669IfExpressionEmitTests.cs" company="GSharp">
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
/// Issue #669: end-to-end emit tests for if-expressions as value-producing
/// forms. Covers basic two-arm, else-if chains, nested if-expressions,
/// multi-statement blocks, if-expression as argument, and type inference.
/// </summary>
public class Issue669IfExpressionEmitTests
{
    [Fact]
    public void IfExpression_TrueArm_ReturnsCorrectValue()
    {
        const string Source = @"package IfExpr1
import System

var cond = true
var x = if cond { 11 } else { 22 }
Console.WriteLine(x)
";
        var output = CompileAndRun(Source, "IfExpr1");
        Assert.Contains("11", output);
    }

    [Fact]
    public void IfExpression_FalseArm_ReturnsCorrectValue()
    {
        const string Source = @"package IfExpr2
import System

var cond = false
var x = if cond { 11 } else { 22 }
Console.WriteLine(x)
";
        var output = CompileAndRun(Source, "IfExpr2");
        Assert.Contains("22", output);
    }

    [Fact]
    public void IfExpression_StringArms()
    {
        const string Source = @"package IfExprStr
import System

var pick = true
var label = if pick { ""yes"" } else { ""no"" }
Console.WriteLine(label)
";
        var output = CompileAndRun(Source, "IfExprStr");
        Assert.Contains("yes", output);
    }

    [Fact]
    public void IfExpression_ElseIfChain()
    {
        const string Source = @"package IfExprChain
import System

var score = 85
var grade = if score >= 90 { ""A"" } else if score >= 80 { ""B"" } else if score >= 70 { ""C"" } else { ""F"" }
Console.WriteLine(grade)
";
        var output = CompileAndRun(Source, "IfExprChain");
        Assert.Contains("B", output);
    }

    [Fact]
    public void IfExpression_ElseIfChain_LastArm()
    {
        const string Source = @"package IfExprChain2
import System

var score = 50
var grade = if score >= 90 { ""A"" } else if score >= 80 { ""B"" } else if score >= 70 { ""C"" } else { ""F"" }
Console.WriteLine(grade)
";
        var output = CompileAndRun(Source, "IfExprChain2");
        Assert.Contains("F", output);
    }

    [Fact]
    public void IfExpression_Nested()
    {
        const string Source = @"package IfExprNest
import System

var a = true
var b = false
var n = if a { if b { 1 } else { 2 } } else { 3 }
Console.WriteLine(n)
";
        var output = CompileAndRun(Source, "IfExprNest");
        Assert.Contains("2", output);
    }

    [Fact]
    public void IfExpression_MultiStatementBlock()
    {
        const string Source = @"package IfExprMulti
import System

var isAdmin = true
var title = if isAdmin {
    Console.Write("""")
    ""Admin""
} else { ""Home"" }
Console.WriteLine(title)
";
        var output = CompileAndRun(Source, "IfExprMulti");
        Assert.Contains("Admin", output);
    }

    [Fact]
    public void IfExpression_AsCallArgument()
    {
        const string Source = @"package IfExprArg
import System

var flag = true
Console.WriteLine(if flag { ""on"" } else { ""off"" })
";
        var output = CompileAndRun(Source, "IfExprArg");
        Assert.Contains("on", output);
    }

    [Fact]
    public void IfExpression_TypeInference()
    {
        const string Source = @"package IfExprInfer
import System

var x = 10
let result = if x > 5 { x * 2 } else { x + 1 }
Console.WriteLine(result)
";
        var output = CompileAndRun(Source, "IfExprInfer");
        Assert.Contains("20", output);
    }

    [Fact]
    public void IfExpression_MissingElse_ReportsGS0276()
    {
        const string Source = @"package IfExprNoElse

var cond = true
var x = if cond { 1 }
";
        var diags = CompileExpectingDiagnostics(Source);
        Assert.Contains(diags, d => d.Id == "GS0276");
    }

    [Fact]
    public void IfExpression_EmptyBlock_ReportsGS0277()
    {
        const string Source = @"package IfExprEmpty

var cond = true
var x = if cond { } else { 1 }
";
        var diags = CompileExpectingDiagnostics(Source);
        Assert.Contains(diags, d => d.Id == "GS0277");
    }

    [Fact]
    public void IfExpression_NoCommonType_ReportsGS0263()
    {
        const string Source = @"package IfExprBadType

var cond = true
var x = if cond { true } else { ""no"" }
";
        var diags = CompileExpectingDiagnostics(Source);
        Assert.Contains(diags, d => d.Id == "GS0263");
    }

    [Fact]
    public void Ternary_StillWorks_AfterIfExpression()
    {
        // Regression guard: ternary continues to work
        const string Source = @"package TernaryStill
import System

var pick = true
var x = pick ? 11 : 22
Console.WriteLine(x)
";
        var output = CompileAndRun(Source, "TernaryStill");
        Assert.Contains("11", output);
    }

    [Fact]
    public void IfExpression_OriginalReproFromIssue()
    {
        // The original repro from issue #669 (adapted to compile):
        // `let f = if filter != nil { filter!! } else { LibraryFilter() }`
        const string Source = @"package IfExprRepro
import System

func LibraryFilter() string {
    return ""default""
}

var filter string? = nil
let f = if filter != nil { filter!! } else { LibraryFilter() }
Console.WriteLine(f)
";
        var output = CompileAndRun(Source, "IfExprRepro");
        Assert.Contains("default", output);
    }

    [Fact]
    public void IfExpression_OriginalReproWithNonNilFilter()
    {
        const string Source = @"package IfExprRepro2
import System

func LibraryFilter() string {
    return ""default""
}

var filter string? = ""custom""
let f = if filter != nil { filter!! } else { LibraryFilter() }
Console.WriteLine(f)
";
        var output = CompileAndRun(Source, "IfExprRepro2");
        Assert.Contains("custom", output);
    }

    [Fact]
    public void IfStatement_StillWorks_Unchanged()
    {
        // Regression guard: if-statement unchanged
        const string Source = @"package IfStmt
import System

var x = 0
if true {
    x = 42
}
Console.WriteLine(x)
";
        var output = CompileAndRun(Source, "IfStmt");
        Assert.Contains("42", output);
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
