// <copyright file="Issue1614FieldAssignmentReceiverOnceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1614: <c>EmitFieldAssignment</c>'s expression-receiver arm (the
/// shape produced by <c>BoundFieldAssignmentExpression.WithExpressionReceiver</c>
/// for <c>getObj().Field = v</c> / chained member assignment) emitted the
/// receiver TWICE — once for the <c>stfld</c>, once more afterwards to
/// <c>ldfld</c> the field back out as the expression result. When the
/// receiver is a side-effecting call, that call ran twice, and the second
/// run could even hand back a different object than the one written to.
/// Compound assignment (<c>getObj().Field += v</c>) routed through the same
/// node with the receiver already evaluated once for the read side, so the
/// bug tripled the call count.
///
/// The fix spills the assigned value into a pre-planned temp local (mirrors
/// the property-assignment fix for issue #418 P1-2): <c>receiver; value;
/// dup; stloc tmp; stfld; ldloc tmp</c>. The receiver is evaluated exactly
/// once for the simple-assignment shape, and the redundant post-store
/// evaluation is eliminated from the compound-assignment shape too.
/// </summary>
public class Issue1614FieldAssignmentReceiverOnceEmitTests
{
    [Fact]
    public void CallReceiverFieldAssignment_EvaluatesReceiverExactlyOnce()
    {
        var source = """
            package P
            import System

            class Box {
                var Count int32
            }

            public var calls = 0
            let shared = Box()

            func GetBox() Box {
                calls = calls + 1
                return shared
            }

            public var assignResult = GetBox().Count = 5
            public var finalCount = shared.Count
            public var callCount = calls
            """;

        var (assignResult, finalCount, callCount) = RunAndGetThreeIntResults(
            source, "assignResult", "finalCount", "callCount");

        Assert.Equal(5, assignResult);
        Assert.Equal(5, finalCount);
        Assert.Equal(1, callCount);
    }

    [Fact]
    public void CallReceiverFieldCompoundAssignment_DoesNotTripleEvaluateReceiver()
    {
        var source = """
            package P
            import System

            class Box {
                var Count int32
            }

            public var calls = 0
            let shared = Box()

            func GetBox() Box {
                calls = calls + 1
                return shared
            }

            shared.Count = 10
            GetBox().Count += 5
            public var finalCount = shared.Count
            public var callCount = calls
            """;

        var (finalCount, callCount) = RunAndGetTwoIntResults(source, "finalCount", "callCount");

        // Issue #1688: the compound-assignment receiver is spilled to a
        // temp and evaluated exactly ONCE, then reused for both the read
        // (current field value) and the write. Pre-#1688 this was two
        // evaluations (read + write); pre-#1614 it was three (plus a
        // spurious reload for the discarded statement-position result).
        Assert.Equal(15, finalCount);
        Assert.Equal(1, callCount);
    }

    [Fact]
    public void CallReceiverFieldCompoundAssignment_WritesBackToTheSameObjectItRead()
    {
        // The receiver is a call that mutates shared state and returns a
        // fresh object each invocation; the compound write must land on the
        // SAME instance the compound read observed (recorded via a global
        // set inside GetBox), not a second freshly-constructed instance.
        var source = """
            package P1688A
            import System

            class Box {
                var Count int32
            }

            public var calls = 0
            public var lastBox = Box()

            func GetBox() Box {
                calls = calls + 1
                var b = Box()
                b.Count = 10
                lastBox = b
                return b
            }

            GetBox().Count += 5
            public var finalCount = lastBox.Count
            public var callCount = calls
            """;

        var (finalCount, callCount) = RunAndGetTwoIntResults(source, "finalCount", "callCount");

        Assert.Equal(15, finalCount);
        Assert.Equal(1, callCount);
    }

    [Fact]
    public void CallReceiverPropertyCompoundAssignment_EvaluatesReceiverExactlyOnce()
    {
        var source = """
            package P1688B
            import System

            class Box {
                var backing int32
                prop Count int32 { get { return backing } set { backing = value } }
            }

            public var calls = 0
            let shared = Box()

            func GetBox() Box {
                calls = calls + 1
                return shared
            }

            shared.Count = 10
            GetBox().Count += 5
            public var finalCount = shared.Count
            public var callCount = calls
            """;

        var (finalCount, callCount) = RunAndGetTwoIntResults(source, "finalCount", "callCount");

        Assert.Equal(15, finalCount);
        Assert.Equal(1, callCount);
    }

    [Fact]
    public void LocalReceiverFieldCompoundAssignment_NeedsNoSpillAndStillWorks()
    {
        // Trivial (local-variable) receivers have no side effect to
        // preserve; the fix must not force a temp for them, and the
        // compound assignment must still produce the correct result.
        var source = """
            package P1688C
            import System

            class Box {
                var Count int32
            }

            let shared = Box()
            shared.Count = 10
            shared.Count += 5
            public var finalCount = shared.Count
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var finalCountField = program.GetField("finalCount", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });

        Assert.Equal(15, (int)finalCountField!.GetValue(null)!);
    }

    private static (int First, int Second) RunAndGetTwoIntResults(string source, string firstField, string secondField)
    {
        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var first = program.GetField(firstField, BindingFlags.Public | BindingFlags.Static);
        var second = program.GetField(secondField, BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
        return ((int)first!.GetValue(null)!, (int)second!.GetValue(null)!);
    }

    private static (int First, int Second, int Third) RunAndGetThreeIntResults(
        string source, string firstField, string secondField, string thirdField)
    {
        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var first = program.GetField(firstField, BindingFlags.Public | BindingFlags.Static);
        var second = program.GetField(secondField, BindingFlags.Public | BindingFlags.Static);
        var third = program.GetField(thirdField, BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
        return ((int)first!.GetValue(null)!, (int)second!.GetValue(null)!, (int)third!.GetValue(null)!);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1614_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
