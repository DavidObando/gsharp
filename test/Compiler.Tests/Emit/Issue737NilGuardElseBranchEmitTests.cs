// <copyright file="Issue737NilGuardElseBranchEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #737 — pre-existing if-else lowering bug exposed by ADR-0069
/// nullable-reference narrowing: when both arms of an <c>if/else</c> end
/// in an unconditional control transfer (e.g. each arm returns), the
/// lowerer emitted a dead <c>goto endLabel</c> after the then-arm and a
/// trailing <c>endLabel:</c> label whose IL offset landed past the final
/// <c>ret</c> of the method body. The CLR JIT rejected the assembly with
/// <c>System.InvalidProgramException</c>. The original repro surfaced
/// inside a nil-guard else-branch on a nullable reference because that is
/// the canonical "use the narrowed value" shape, but the underlying bug
/// is purely about the if-else terminator analysis in the lowerer and
/// applies to every reference / value / primitive type.
///
/// Each test compiles via in-process <c>gsc</c>, IL-verifies the emitted
/// PE (so the prior past-end <c>br</c> is caught here, not only at JIT
/// time), and runs the assembly under <c>dotnet exec</c>, asserting
/// captured stdout.
/// </summary>
public class Issue737NilGuardElseBranchEmitTests
{
    [Fact]
    public void IfElse_BothBranchesReturn_String_ElseBranchReadsNarrowed()
    {
        var source = """
            package Test
            import System

            func Length(s string?) int32 {
                if s == nil {
                    return -1
                } else {
                    return s.Length
                }
            }

            Console.WriteLine(Length("hello"))
            Console.WriteLine(Length(nil))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n-1\n", output);
    }

    [Fact]
    public void IfElse_PositiveGuard_ThenBranchReadsNarrowed()
    {
        var source = """
            package Test
            import System

            func Use(s string) int32 {
                return s.Length
            }

            func Length(s string?) int32 {
                if s != nil {
                    return Use(s)
                }
                return -1
            }

            Console.WriteLine(Length("hi"))
            Console.WriteLine(Length(nil))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n-1\n", output);
    }

    [Fact]
    public void IfElse_BothBranchesReturn_OrComposition_ElseReadsNarrowed()
    {
        // Issue #712 (PR #736) had to use the post-if-lift form for the
        // emit coverage of `||` nil-guard composition because this form
        // tripped the pre-existing #737 bug. Now that #737 is fixed, the
        // else-branch form is the cleaner shape and must work end-to-end.
        var source = """
            package Test
            import System

            func Length(s string?, force bool) int32 {
                if s == nil || force {
                    return -1
                } else {
                    return s.Length
                }
            }

            Console.WriteLine(Length("hello", false))
            Console.WriteLine(Length("hello", true))
            Console.WriteLine(Length(nil, false))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n-1\n-1\n", output);
    }

    [Fact]
    public void IfElse_BothBranchesReturn_ChainedAndGuard()
    {
        // Multiple-variable narrowing: `a != nil && b != nil` must narrow
        // both `a` and `b` in the then-arm even when both arms of the
        // outer if-else terminate.
        var source = """
            package Test
            import System

            func Both(a string?, b string?) int32 {
                if a != nil && b != nil {
                    return a.Length + b.Length
                } else {
                    return -1
                }
            }

            Console.WriteLine(Both("hi", "ya"))
            Console.WriteLine(Both("hi", nil))
            Console.WriteLine(Both(nil, "ya"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n-1\n-1\n", output);
    }

    [Fact]
    public void IfElse_BothBranchesReturn_UserClass_ElseReadsNarrowed()
    {
        var source = """
            package Test
            import System

            class Greeter {
                var Name string
                func Greet() string { return "hi " + Name }
            }

            func DescribeOrDefault(g Greeter?) string {
                if g == nil {
                    return "none"
                } else {
                    return g.Greet()
                }
            }

            Console.WriteLine(DescribeOrDefault(Greeter{Name: "Alice"}))
            Console.WriteLine(DescribeOrDefault(nil))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi Alice\nnone\n", output);
    }

    [Fact]
    public void IfElse_BothBranchesReturn_Interface_ElseReadsNarrowed()
    {
        // IDisposable is a CLR-imported interface; the narrowed read
        // observes it as a non-nullable reference and the in-else call
        // must compile to a plain `ldarg` + `callvirt` — no Nullable<T>
        // unwrap, no boxing.
        var source = """
            package Test
            import System

            class MyDisposable : IDisposable {
                func Dispose() {
                    Console.WriteLine("disposed")
                }
            }

            func Read(d IDisposable?) string {
                if d == nil {
                    return "none"
                } else {
                    d.Dispose()
                    return "ok"
                }
            }

            var d IDisposable = MyDisposable{}
            Console.WriteLine(Read(d))
            Console.WriteLine(Read(nil))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("disposed\nok\nnone\n", output);
    }

    [Fact]
    public void IfElse_BothBranchesReturn_NonNullableBaseline_NoNarrowing()
    {
        // The same shape on non-nullable values must also produce
        // verifiable IL — the bug was in the lowerer's if-else
        // terminator analysis, NOT in nullable-reference narrowing.
        var source = """
            package Test
            import System

            func Classify(n int32) int32 {
                if n > 0 {
                    return 1
                } else {
                    return -1
                }
            }

            Console.WriteLine(Classify(5))
            Console.WriteLine(Classify(-3))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n-1\n", output);
    }

    [Fact]
    public void IfElse_BothBranchesThrow_StillEmitsValidIl()
    {
        // `throw` is the other unconditional control transfer; both
        // branches throwing should not corrupt the trailing IL either.
        var source = """
            package Test
            import System

            func MustHave(s string?) {
                if s == nil {
                    throw System.InvalidOperationException("nil!")
                } else {
                    throw System.InvalidOperationException("got: " + s)
                }
            }

            try {
                MustHave("hi")
            } catch (e Exception) {
                Console.WriteLine(e.Message)
            }
            try {
                MustHave(nil)
            } catch (e Exception) {
                Console.WriteLine(e.Message)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("got: hi\nnil!\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue737_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

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

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
