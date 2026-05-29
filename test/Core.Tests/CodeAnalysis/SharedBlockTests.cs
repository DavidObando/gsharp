// <copyright file="SharedBlockTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// ADR-0053 Phase E — comprehensive tests for the <c>shared { … }</c> block feature
/// covering parser, binder, evaluator, and emit round-trip scenarios.
/// </summary>
public class SharedBlockTests
{
    // ─────────────────────────────────────────────────────────────────────────
    // 1. Parser tests
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void SharedBlock_Parses_InClass()
    {
        var source = @"
type Counter class {
    shared {
        count int32
    }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void SharedBlock_Parses_InStruct()
    {
        var source = @"
type Counter struct {
    shared {
        count int32
    }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void SharedBlock_Parses_WithMethods()
    {
        var source = @"
type Factory struct {
    shared {
        func create() int32 {
            return 42
        }
    }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void SharedBlock_DuplicateSharedBlock_ReportsDiagnostic()
    {
        var source = @"
type Counter struct {
    shared {
        x int32
    }
    shared {
        y int32
    }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
        Assert.Contains(tree.Diagnostics, d => d.Message.Contains("shared"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Binder tests
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void SharedBlock_StaticFieldAccess_Binds()
    {
        var source = @"
type Counter struct {
    shared {
        count int32
    }
}

var x = Counter.count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void SharedBlock_StaticMethodCall_Binds()
    {
        var source = @"
type Factory struct {
    shared {
        func create() int32 {
            return 42
        }
    }
}

var x = Factory.create()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void SharedBlock_StaticField_AssignmentBinds()
    {
        var source = @"
type Counter struct {
    shared {
        count int32
    }
}

Counter.count = 5
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Evaluator (interpreter) tests
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void SharedBlock_StaticField_ReadWrite()
    {
        var source = @"
type Counter struct {
    shared {
        count int32
    }
}

Counter.count = 42
var result = Counter.count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void SharedBlock_StaticMethod_ReturnsValue()
    {
        var source = @"
type Factory struct {
    shared {
        func create() int32 {
            return 99
        }
    }
}

var result = Factory.create()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void SharedBlock_StaticField_SharedAcrossInstances()
    {
        var source = @"
type Counter struct {
    shared {
        count int32
    }
}

Counter.count = 10
Counter.count = Counter.count + 5
var result = Counter.count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(15, result.Value);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Emit (compiled) tests
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void SharedBlock_StaticField_Emit_RoundTrip()
    {
        var source = @"package SharedFieldEmit
import System

type Counter struct {
    shared {
        count int32
    }
}

Counter.count = 77
Console.WriteLine(Counter.count)
";
        var output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-StaticField");
        Assert.Contains("77", output);
    }

    [Fact]
    public void SharedBlock_StaticMethod_Emit_RoundTrip()
    {
        var source = @"package SharedMethodEmit
import System

type Factory struct {
    shared {
        func create() int32 {
            return 123
        }
    }
}

Console.WriteLine(Factory.create())
";
        var output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-StaticMethod");
        Assert.Contains("123", output);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static EmitResult Compile(string source, Stream peStream)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Emit(peStream);
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
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
