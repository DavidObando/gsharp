// <copyright file="Issue2026GenericAsyncTaskWrapEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2026: calling a generic <c>async func</c> from inside another
/// generic function must observe the call's result type as <c>Task[U]</c> (the
/// substituted return type, Task-wrapped) — not the raw substituted return
/// type <c>U</c> — so <c>await</c> on the result is legal. Before this fix,
/// <c>gsc</c> reported GS0133 ("cannot be awaited") for this shape.
/// </summary>
/// <remarks>
/// A full compile-AND-RUN round trip of the exact issue repro is currently
/// blocked by a separate, pre-existing GS0190 diagnostic ("Could not
/// synthesize the state machine for this async function") — generic
/// <c>async func</c>s cannot yet fully lower to a runnable state machine
/// because their observable return type is an open method type parameter,
/// which the async state-machine builder resolution (which needs a real CLR
/// <c>System.Type</c> to resolve <c>AsyncTaskMethodBuilder&lt;T&gt;</c>) does
/// not yet support. That gap is tracked separately in
/// https://github.com/DavidObando/gsharp/issues/2030 and is unrelated to this
/// issue's binder-level return-type-substitution bug. This test therefore
/// pins the GS0133 regression fix at the full-compiler level (via
/// <c>gsc</c>, not just the binder unit tests in Core.Tests) and documents
/// the current, separate GS0190 blocker rather than silently skipping
/// coverage.
/// </remarks>
public class Issue2026GenericAsyncTaskWrapEmitTests
{
    [Fact]
    public void GenericAsyncFunctionCall_InsideAnotherGeneric_NeverReportsGS0133()
    {
        var source = """
            package P
            async func Foo[U](x U) U {
                return x
            }
            async func Outer[U](seed U) U {
                var r = Foo(seed)
                return await r
            }
            var t = Outer("hi")
            t.Wait()
            Console.WriteLine(t.Result)
            """;

        var (_, stdout, stderr) = CompileRaw(source);

        // The bug this issue reports: the type-check must never regress back
        // to GS0133 for this call shape.
        Assert.DoesNotContain("GS0133", stdout + stderr);

        // Currently blocked by the separate, pre-existing GS0190 emit-layer
        // gap (see remarks above) — tracked separately, not fixed here.
        Assert.Contains("GS0190", stdout + stderr);
    }

    [Fact]
    public void NonGenericAsyncFunctionCall_InsideGenericCaller_CompilesWithoutGS0133_Regression()
    {
        // Regression: the non-generic async call-site Task-wrap path (already
        // working before this fix) must keep type-checking without GS0133,
        // even when the caller itself is generic. (A full compile-AND-RUN
        // round trip of a generic async CALLER is separately blocked by the
        // pre-existing emit-layer gap described in the class remarks above —
        // hoisting a generic-typed parameter/local into the async state
        // machine is not yet fully supported — so this test only asserts the
        // type-check outcome, matching the scope of this issue's fix.)
        var source = """
            package P
            async func Answer() int32 {
                return 42
            }
            async func Outer[U](seed U) int32 {
                var r = Answer()
                return await r
            }
            var t = Outer("hi")
            """;

        var (_, stdout, stderr) = CompileRaw(source);
        Assert.DoesNotContain("GS0133", stdout + stderr);
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2026_").FullName;
        try
        {
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

            return (compileExit, compileOut.ToString(), compileErr.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
