// <copyright file="TupleEqualityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3501 / ADR-0171: emit coverage for tuple equality (<c>==</c> /
/// <c>!=</c>). Each test's printed trace is the ADR-0154 witness: the
/// short-circuit and single-evaluation tests fail against an implementation
/// that re-evaluates operands or compares eagerly, and the user-operator test
/// fails against a <c>ValueTuple.Equals</c> dispatch.
/// </summary>
public class TupleEqualityEmitTests
{
    [Fact]
    public void TupleEquality_BasicOutcomes()
    {
        var source = """
            package P
            import System

            let a = (1, "x")
            let b = (1, "x")
            let c = (2, "x")
            Console.WriteLine(a == b)
            Console.WriteLine(a == c)
            Console.WriteLine(a != b)
            Console.WriteLine(a != c)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"True{Environment.NewLine}False{Environment.NewLine}False{Environment.NewLine}True{Environment.NewLine}", output);
    }

    [Fact]
    public void TupleEquality_ShortCircuit_FirstMismatchSkipsLaterElementOperator()
    {
        // Loud's user operator prints on every invocation. With the first
        // elements unequal (1 vs 2), `&&` short-circuits and the Loud
        // comparison must never run — "loud==" appears exactly once, from the
        // control comparison where the first elements match.
        var source = """
            package P
            import System

            struct Loud {
                var V int32
            }

            func (a Loud) operator ==(b Loud) bool {
                Console.WriteLine("loud==")
                return a.V == b.V
            }

            func (a Loud) operator !=(b Loud) bool {
                Console.WriteLine("loud!=")
                return a.V != b.V
            }

            let p = (1, Loud{V: 5})
            let q = (2, Loud{V: 5})
            let r = (1, Loud{V: 5})
            Console.WriteLine(p == q)
            Console.WriteLine(p == r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"False{Environment.NewLine}loud=={Environment.NewLine}True{Environment.NewLine}", output);
    }

    [Fact]
    public void TupleEquality_OperandsEvaluatedExactlyOnce()
    {
        var source = """
            package P
            import System

            func mk(tag string) (int32, int32) {
                Console.WriteLine("eval $tag")
                return (1, 2)
            }

            Console.WriteLine(mk("L") == mk("R"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"eval L{Environment.NewLine}eval R{Environment.NewLine}True{Environment.NewLine}", output);
    }

    [Fact]
    public void TupleEquality_NullableElement_NilAndValueCases()
    {
        var source = """
            package P
            import System

            var none (int32?, string) = (nil, "x")
            var some (int32?, string) = (7, "x")
            var none2 (int32?, string) = (nil, "x")
            Console.WriteLine(none == some)
            Console.WriteLine(none == none2)
            Console.WriteLine(some == (7, "x"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"False{Environment.NewLine}True{Environment.NewLine}True{Environment.NewLine}", output);
    }

    [Fact]
    public void TupleEquality_SymbolicTuple_StructElementCompares()
    {
        // A tuple whose element is a same-compilation struct has no cached
        // CLR type at bind time (symbolic tuple) — the desugared block plus
        // bool fold must emit through the symbolic element-access path.
        var source = """
            package P
            import System

            struct Pt {
                var X int32
            }

            func (a Pt) operator ==(b Pt) bool {
                return a.X == b.X
            }

            func (a Pt) operator !=(b Pt) bool {
                return a.X != b.X
            }

            let p = (Pt{X: 1}, 2)
            let q = (Pt{X: 1}, 2)
            let r = (Pt{X: 9}, 2)
            Console.WriteLine(p == q)
            Console.WriteLine(p != r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"True{Environment.NewLine}True{Environment.NewLine}", output);
    }

    [Fact]
    public void TupleEquality_AwaitInRightOperand_SpillsAcrossSuspension()
    {
        var source = """
            package P
            import System
            import System.Threading.Tasks

            async func fetch() (int32, int32) {
                await Task.Delay(1)
                return (3, 4)
            }

            async func check() {
                let expected = (3, 4)
                Console.WriteLine(expected == await fetch())
            }

            check().Wait()
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"True{Environment.NewLine}", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_tupeq_emit_").FullName;
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

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi);
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
