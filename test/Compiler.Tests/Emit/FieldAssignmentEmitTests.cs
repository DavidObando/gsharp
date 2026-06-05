// <copyright file="FieldAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #420 (P3-4) regression tests. <c>EmitFieldAssignment</c> emits the
/// receiver twice — once for the <c>stfld</c>, once again after the store to
/// reload the field for the expression result. The reload only matches the
/// freshly-stored value as long as evaluating the value expression cannot
/// reassign the receiver variable. These tests pin down the normal-case
/// behavior (post-store reload returns the just-written value for struct and
/// class receivers) so any regression in the receiver-reload sequence is
/// caught immediately.
/// </summary>
public class FieldAssignmentEmitTests
{
    [Fact]
    public void StructFieldAssignment_ResultIs_AssignedValue()
    {
        // The assignment expression is used as the initializer for `result`,
        // so its value must equal the freshly-stored 42 — which is what the
        // post-store ldfld in EmitFieldAssignment guarantees.
        var source = """
            package P
            import System

            type Point struct {
                X int32
                Y int32
            }

            var p = Point{X: 1, Y: 2}
            public var result = (p.X = 42)
            """;

        Assert.Equal(42, RunAndGetIntResult(source));
    }

    [Fact]
    public void StructFieldAssignment_LeavesReceiverFieldUpdated()
    {
        // Verifies the stfld actually writes through the receiver address —
        // reading p.X after the assignment must yield the stored value.
        var source = """
            package P
            import System

            type Point struct {
                X int32
                Y int32
            }

            var p = Point{X: 1, Y: 2}
            p.X = 99
            public var result = p.X
            """;

        Assert.Equal(99, RunAndGetIntResult(source));
    }

    [Fact]
    public void ClassFieldAssignment_ResultIs_AssignedValue()
    {
        // Class receiver path: receiver reference is loaded twice. The
        // post-store ldfld must observe the just-written value.
        var source = """
            package P
            import System

            type Box class {
                Value int32
            }

            var b = Box{Value: 1}
            public var result = (b.Value = 7)
            """;

        Assert.Equal(7, RunAndGetIntResult(source));
    }

    [Fact]
    public void ClassFieldAssignment_LeavesReceiverFieldUpdated()
    {
        var source = """
            package P
            import System

            type Box class {
                Value int32
            }

            var b = Box{Value: 1}
            b.Value = 123
            public var result = b.Value
            """;

        Assert.Equal(123, RunAndGetIntResult(source));
    }

    [Fact]
    public void StructFieldAssignment_ValueExpressionReadsReceiver()
    {
        // Reading the receiver inside the value expression is fine and must
        // be supported — only *mutating* the receiver in the value side is
        // the unsafe shape the binder doesn't produce. This guards the
        // assertion in EmitFieldAssignment from being overly aggressive.
        var source = """
            package P
            import System

            type Point struct {
                X int32
                Y int32
            }

            var p = Point{X: 10, Y: 0}
            p.X = p.X + 5
            public var result = p.X
            """;

        Assert.Equal(15, RunAndGetIntResult(source));
    }

    private static int RunAndGetIntResult(string source)
    {
        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField(
            "result",
            BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, null);
        return (int)resultField!.GetValue(null)!;
    }

    private static Assembly CompileToAssembly(string source, string target)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_field_assign_emit_").FullName;
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
                "/target:" + target,
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
        IlVerifier.Verify(outPath);

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
