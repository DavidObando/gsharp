// <copyright file="PropertyAssignmentSpillEmitTests.cs" company="GSharp">
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
/// Regression tests for issue #418 (P1-2): a property-assignment expression
/// must evaluate its RHS exactly once and must not invoke the getter
/// afterwards to recover the expression result. The pre-fix emitter pushed
/// the receiver, called the setter, then re-pushed the receiver and called
/// the getter — doubling any side effect inside a custom getter and re-loading
/// the receiver. The fix spills the assigned value into a temp and yields it
/// directly via <c>dup; stloc; setter; ldloc</c>.
/// </summary>
public class PropertyAssignmentSpillEmitTests
{
    [Fact]
    public void UserComputedProperty_Assignment_DoesNotInvokeGetter()
    {
        // The assignment `b.Value = 7` is used as a statement. The setter
        // must run once; the getter must NOT run at all (the expression
        // result is the assigned value, not a read-back through the getter).
        const string Source = @"package P1_2_NoGetter
import System

var getterCalls = 0
var setterCalls = 0

class Box {
    prop raw int32
    prop Value int32 {
        get {
            getterCalls = getterCalls + 1
            return this.raw
        }
        set(v) {
            setterCalls = setterCalls + 1
            this.raw = v
        }
    }
}

var b = Box{}
b.Value = 7
Console.WriteLine(getterCalls)
Console.WriteLine(setterCalls)
Console.WriteLine(b.raw)
";
        var lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "P1_2-NoGetter"));
        Assert.Equal("0", lines[0]);
        Assert.Equal("1", lines[1]);
        Assert.Equal("7", lines[2]);
    }

    [Fact]
    public void UserComputedProperty_AssignmentExpression_YieldsAssignedValue_WithoutGetter()
    {
        // The assignment is consumed by Console.WriteLine, so the expression
        // result is observable. It must equal the assigned value AND the
        // getter must not run.
        const string Source = @"package P1_2_ExprValue
import System

var getterCalls = 0

class Box {
    prop raw int32
    prop Value int32 {
        get {
            getterCalls = getterCalls + 1
            return this.raw
        }
        set(v) { this.raw = v }
    }
}

var b = Box{}
Console.WriteLine(b.Value = 42)
Console.WriteLine(getterCalls)
Console.WriteLine(b.raw)
";
        var lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "P1_2-ExprValue"));
        Assert.Equal("42", lines[0]);
        Assert.Equal("0", lines[1]);
        Assert.Equal("42", lines[2]);
    }

    [Fact]
    public void UserComputedProperty_AssignmentExpression_RhsEvaluatedOnce()
    {
        // The RHS value expression must evaluate exactly once even though
        // the assignment is consumed as an expression.
        const string Source = @"package P1_2_RhsOnce
import System

var rhsCalls = 0

class Box {
    prop raw int32
    prop Value int32 {
        get { return this.raw }
        set(v) { this.raw = v }
    }
}

var b = Box{}

func nextValue() int32 {
    rhsCalls = rhsCalls + 1
    return 99
}

Console.WriteLine(b.Value = nextValue())
Console.WriteLine(rhsCalls)
Console.WriteLine(b.raw)
";
        var lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "P1_2-RhsOnce"));
        Assert.Equal("99", lines[0]);
        Assert.Equal("1", lines[1]);
        Assert.Equal("99", lines[2]);
    }

    [Fact]
    public void ClrInstanceProperty_AssignmentExpression_YieldsAssignedValue()
    {
        // CLR property setter (StringBuilder.Capacity) via the
        // EmitClrPropertyAssignment path. Verifies the expression result is
        // the assigned value, not a read-back through the getter.
        const string Source = @"package P1_2_ClrExpr
import System
import System.Text

var sb = StringBuilder()
Console.WriteLine(sb.Capacity = 128)
Console.WriteLine(sb.Capacity >= 128)
";
        var lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "P1_2-ClrExpr"));
        Assert.Equal("128", lines[0]);
        Assert.Equal("True", lines[1]);
    }

    [Fact]
    public void ClrInstanceProperty_AssignmentStatement_StoresValue()
    {
        // Plain statement-form CLR property assignment must still work after
        // the dup/stloc/ldloc rewrite.
        const string Source = @"package P1_2_ClrStmt
import System
import System.Text

var sb = StringBuilder()
sb.Capacity = 256
Console.WriteLine(sb.Capacity >= 256)
";
        var lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "P1_2-ClrStmt"));
        Assert.Equal("True", lines[0]);
    }

    [Fact]
    public void UserComputedProperty_NestedAssignments_EachYieldAssignedValue()
    {
        // Two distinct property-assignment expressions in the same body each
        // need their own value-spill slot. Verifies the pre-allocator handles
        // multiple assignments correctly.
        const string Source = @"package P1_2_NestedAssn
import System

var getterCalls = 0

class Box {
    prop raw int32
    prop Value int32 {
        get {
            getterCalls = getterCalls + 1
            return this.raw
        }
        set(v) { this.raw = v }
    }
}

var a = Box{}
var b = Box{}
Console.WriteLine(a.Value = 10)
Console.WriteLine(b.Value = 20)
Console.WriteLine(getterCalls)
Console.WriteLine(a.raw)
Console.WriteLine(b.raw)
";
        var lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "P1_2-NestedAssn"));
        Assert.Equal("10", lines[0]);
        Assert.Equal("20", lines[1]);
        Assert.Equal("0", lines[2]);
        Assert.Equal("10", lines[3]);
        Assert.Equal("20", lines[4]);
    }

    private static string[] SplitLines(string output) =>
        output.Replace("\r\n", "\n").TrimEnd('\n').Split('\n');

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
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
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
