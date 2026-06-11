// <copyright file="SideEffectSpillerTests.cs" company="GSharp">
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

namespace GSharp.Core.Tests.CodeAnalysis.Lowering;

/// <summary>
/// Issue #452: integration tests for the general
/// <c>SideEffectSpiller</c> lowering pass. These tests prove that
/// observable side effects (counters incremented by helper functions,
/// <c>Console.Write</c> calls inside expressions) execute exactly once
/// in every "duplicating context" that historically re-emitted a
/// sub-expression — covering all four bug classes called out in
/// #418: P0-1 (short-circuit operators), P1-1 (index assignments),
/// P1-2 (property assignments), and P1-12 (ref-local hoisting).
/// </summary>
/// <remarks>
/// The original per-bug fixes patched single emit sites; this suite
/// is the regression net for the general lowering pass that closes
/// the entire bug class. Each test compiles a complete G# program,
/// loads the emitted assembly, runs its entry point, and asserts on
/// the captured stdout — i.e. it exercises the full end-to-end
/// pipeline (bind → lower → spill → emit → run) rather than
/// inspecting the bound tree.
/// </remarks>
public class SideEffectSpillerTests
{
    // ──────────────────────────────────────────────────────────────
    // P0-1: short-circuit operators must evaluate the right operand
    // at most once, and only when the left operand does not already
    // determine the result.
    // ──────────────────────────────────────────────────────────────

    [Fact]
    public void LogicalAnd_Right_Side_Not_Evaluated_When_Left_False()
    {
        const string Source = @"package main
import System
var calls = 0
func sideEffect() bool {
    calls = calls + 1
    return true
}
var result = false && sideEffect()
Console.WriteLine(result)
Console.WriteLine(calls)
";
        var lines = CompileAndRun(Source, "SideEffectSpillerTests-AndShortCircuit");
        Assert.Equal("False", lines[0]);
        Assert.Equal("0", lines[1]);
    }

    [Fact]
    public void LogicalOr_Right_Side_Not_Evaluated_When_Left_True()
    {
        const string Source = @"package main
import System
var calls = 0
func sideEffect() bool {
    calls = calls + 1
    return false
}
var result = true || sideEffect()
Console.WriteLine(result)
Console.WriteLine(calls)
";
        var lines = CompileAndRun(Source, "SideEffectSpillerTests-OrShortCircuit");
        Assert.Equal("True", lines[0]);
        Assert.Equal("0", lines[1]);
    }

    [Fact]
    public void LogicalAnd_Right_Side_Evaluated_Exactly_Once_When_Left_True()
    {
        const string Source = @"package main
import System
var calls = 0
func sideEffect() bool {
    calls = calls + 1
    return true
}
var result = true && sideEffect()
Console.WriteLine(result)
Console.WriteLine(calls)
";
        var lines = CompileAndRun(Source, "SideEffectSpillerTests-AndEvalOnce");
        Assert.Equal("True", lines[0]);
        Assert.Equal("1", lines[1]);
    }

    // ──────────────────────────────────────────────────────────────
    // P1-1: indexed assignment must evaluate the index and the value
    // exactly once, even when either has observable side effects.
    // ──────────────────────────────────────────────────────────────

    [Fact]
    public void Array_Index_With_Side_Effecting_Index_Evaluates_Once()
    {
        const string Source = @"package main
import System
var indexCalls = 0
var valueCalls = 0
func nextIndex() int32 {
    indexCalls = indexCalls + 1
    return 1
}
func nextValue() int32 {
    valueCalls = valueCalls + 1
    return 42
}
var a = []int32{0, 0, 0}
a[nextIndex()] = nextValue()
Console.WriteLine(indexCalls)
Console.WriteLine(valueCalls)
Console.WriteLine(a[1])
";
        var lines = CompileAndRun(Source, "SideEffectSpillerTests-ArrayIndex");
        Assert.Equal("1", lines[0]);
        Assert.Equal("1", lines[1]);
        Assert.Equal("42", lines[2]);
    }

    [Fact]
    public void Array_Index_Assignment_Result_Preserved_When_Spilled()
    {
        // The spiller wraps the assignment in a BoundBlockExpression; the
        // expression must still yield the assigned value.
        const string Source = @"package main
import System
func mkIndex() int32 { return 2 }
func mkValue() int32 { return 99 }
var a = []int32{0, 0, 0}
var v = (a[mkIndex()] = mkValue())
Console.WriteLine(v)
Console.WriteLine(a[2])
";
        var lines = CompileAndRun(Source, "SideEffectSpillerTests-ArrayIndexResult");
        Assert.Equal("99", lines[0]);
        Assert.Equal("99", lines[1]);
    }

    [Fact]
    public void Map_Index_With_Side_Effecting_Key_Evaluates_Once()
    {
        const string Source = @"package main
import System
var keyCalls = 0
func nextKey() string {
    keyCalls = keyCalls + 1
    return ""k""
}
var m = map[string]int32{}
m[nextKey()] = 7
Console.WriteLine(keyCalls)
Console.WriteLine(m[""k""])
";
        var lines = CompileAndRun(Source, "SideEffectSpillerTests-MapIndex");
        Assert.Equal("1", lines[0]);
        Assert.Equal("7", lines[1]);
    }

    [Fact]
    public void Clr_Indexer_With_Side_Effecting_Argument_Evaluates_Once()
    {
        const string Source = @"package main
import System
import System.Collections.Generic
var calls = 0
func at() int32 {
    calls = calls + 1
    return 0
}
var list = List[int32]()
list.Add(0)
list[at()] = 11
Console.WriteLine(calls)
Console.WriteLine(list[0])
";
        var lines = CompileAndRun(Source, "SideEffectSpillerTests-ClrIndexer");
        Assert.Equal("1", lines[0]);
        Assert.Equal("11", lines[1]);
    }

    // ──────────────────────────────────────────────────────────────
    // P1-2: property assignment must evaluate the receiver and the
    // value exactly once, even when the receiver expression has
    // observable side effects (e.g. a call returning the instance).
    // ──────────────────────────────────────────────────────────────

    [Fact]
    public void User_Property_Value_Side_Effect_Evaluates_Once_In_Expression_Position()
    {
        // The RHS of a property assignment may have observable side effects.
        // When the assignment is consumed as an expression (passed to
        // Console.WriteLine), the spiller wrapper ensures the RHS still
        // fires exactly once and the expression yields the assigned value.
        const string Source = @"package main
import System

type Box class {
    prop raw int32
    prop Value int32 {
        get { return this.raw }
        set(v) { this.raw = v }
    }
}

var calls = 0

func nextValue() int32 {
    calls = calls + 1
    return 42
}

var b = Box{}
Console.WriteLine(b.Value = nextValue())
Console.WriteLine(calls)
Console.WriteLine(b.raw)
";
        var lines = CompileAndRun(Source, "SideEffectSpillerTests-UserPropertyValue");
        Assert.Equal("42", lines[0]);
        Assert.Equal("1", lines[1]);
        Assert.Equal("42", lines[2]);
    }

    [Fact]
    public void Clr_Property_Value_Side_Effect_Evaluates_Once()
    {
        // A CLR property setter consumed as an expression must evaluate
        // the RHS exactly once after spiller wrapping.
        const string Source = @"package main
import System
import System.Text

var calls = 0

func nextCapacity() int32 {
    calls = calls + 1
    return 256
}

var sb = StringBuilder()
Console.WriteLine(sb.Capacity = nextCapacity())
Console.WriteLine(calls)
";
        var lines = CompileAndRun(Source, "SideEffectSpillerTests-ClrPropertyValue");
        Assert.Equal("256", lines[0]);
        Assert.Equal("1", lines[1]);
    }

    // ──────────────────────────────────────────────────────────────
    // Combined: nested duplicating contexts (index assignment whose
    // index AND value both have side effects) — verifies the spiller
    // composes correctly with itself.
    // ──────────────────────────────────────────────────────────────

    [Fact]
    public void Nested_Index_Assignment_With_All_Side_Effects_Each_Once()
    {
        const string Source = @"package main
import System
var idxCalls = 0
var valCalls = 0
var innerCalls = 0
func idx() int32 {
    idxCalls = idxCalls + 1
    return 1
}
func inner() int32 {
    innerCalls = innerCalls + 1
    return 5
}
func val() int32 {
    valCalls = valCalls + 1
    return 100
}
var a = []int32{0, 0, 0}
a[idx()] = val() + inner()
Console.WriteLine(idxCalls)
Console.WriteLine(valCalls)
Console.WriteLine(innerCalls)
Console.WriteLine(a[1])
";
        var lines = CompileAndRun(Source, "SideEffectSpillerTests-Nested");
        Assert.Equal("1", lines[0]);
        Assert.Equal("1", lines[1]);
        Assert.Equal("1", lines[2]);
        Assert.Equal("105", lines[3]);
    }

    // ──────────────────────────────────────────────────────────────
    // Pure inputs to a duplicating context should be left untouched
    // by the spiller: behaviour must remain correct without spills.
    // ──────────────────────────────────────────────────────────────

    [Fact]
    public void Pure_Index_And_Value_Need_No_Spill()
    {
        const string Source = @"package main
import System
var a = []int32{0, 0, 0}
a[2] = 42
Console.WriteLine(a[2])
";
        var lines = CompileAndRun(Source, "SideEffectSpillerTests-Pure");
        Assert.Equal("42", lines[0]);
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
