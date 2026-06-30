// <copyright file="Issue1480ConditionalTargetTypingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1480 — a conditional (<c>?:</c>/<c>if</c>-expression) or null-coalescing
/// (<c>??</c>) whose arms are sibling types sharing only a common BASE CLASS while
/// each implements a required INTERFACE was emitted as the common base value with NO
/// cast where the interface was expected. The CLR verifier merges the two arm classes
/// to their common base (never to an interface), producing unverifiable IL
/// (<c>StackUnexpected [found ref 'Base'][expected ref 'IShape']</c>) and a runtime
/// <c>InvalidProgramException</c>. The fix emits a <c>castclass</c> to the interface
/// result type on each value branch of conditionals and <c>??</c>, and threads the
/// contextual target type into <c>??</c> binding across all target-typed contexts.
/// Each facet uses a UNIQUE package + type names so the emitted assemblies do not
/// collide.
/// </summary>
public class Issue1480ConditionalTargetTypingEmitTests
{
    [Fact]
    public void FacetA_ExpressionBodiedConditionalToInterface_VerifiesAndRuns()
    {
        var source = """
            package Issue1480A
            import System
            interface IShapeA { prop Tag int { get } }
            open class BaseA { }
            class Aa : BaseA, IShapeA { prop Tag int -> 1 }
            class Ba : BaseA, IShapeA { prop Tag int -> 2 }

            func PickExpr(cond bool, a Aa, b Ba) IShapeA -> cond ? a : b
            func Main() {
                Console.WriteLine(PickExpr(true, Aa(), Ba()).Tag)
                Console.WriteLine(PickExpr(false, Aa(), Ba()).Tag)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n2\n", output);
    }

    [Fact]
    public void FacetB_ReturnConditionalToInterface_VerifiesAndRuns()
    {
        var source = """
            package Issue1480B
            import System
            interface IShapeB { prop Tag int { get } }
            open class BaseB { }
            class Ab : BaseB, IShapeB { prop Tag int -> 10 }
            class Bb : BaseB, IShapeB { prop Tag int -> 20 }

            func PickRet(cond bool, a Ab, b Bb) IShapeB { return cond ? a : b }
            func Main() {
                Console.WriteLine(PickRet(true, Ab(), Bb()).Tag)
                Console.WriteLine(PickRet(false, Ab(), Bb()).Tag)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n20\n", output);
    }

    [Fact]
    public void FacetC_TypedLocalConditionalToInterface_VerifiesAndRuns()
    {
        var source = """
            package Issue1480C
            import System
            interface IShapeC { prop Tag int { get } }
            open class BaseC { }
            class Ac : BaseC, IShapeC { prop Tag int -> 3 }
            class Bc : BaseC, IShapeC { prop Tag int -> 4 }

            func PickLocal(cond bool, a Ac, b Bc) IShapeC {
                let x IShapeC = cond ? a : b
                return x
            }
            func Main() {
                Console.WriteLine(PickLocal(true, Ac(), Bc()).Tag)
                Console.WriteLine(PickLocal(false, Ac(), Bc()).Tag)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n4\n", output);
    }

    [Fact]
    public void FacetD_NullCoalesceToInterface_VerifiesAndRuns()
    {
        // Mirrors the corpus StblBox::get_COBox shape: a nullable concrete class
        // implementing the interface, coalesced with a conversion-call cast of a
        // sibling concrete class to the interface.
        var source = """
            package Issue1480D
            import System
            interface IShapeD { prop Tag int { get } }
            open class BaseD { }
            class Ad : BaseD, IShapeD { prop Tag int -> 5 }
            class Bd : BaseD, IShapeD { prop Tag int -> 6 }

            func PickCoalesce(a Ad?, b Bd) IShapeD -> a ?? IShapeD(b)
            func Main() {
                Console.WriteLine(PickCoalesce(Ad(), Bd()).Tag)
                Console.WriteLine(PickCoalesce(nil, Bd()).Tag)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n6\n", output);
    }

    [Fact]
    public void FacetE_ConditionalToCommonBaseClass_VerifiesAndRuns()
    {
        // Arms unify to a common BASE CLASS target (not an interface): no cast is
        // required, the verifier merge already yields a subtype of the base.
        var source = """
            package Issue1480E
            import System
            open class BaseE { func Name() string -> "base" }
            class Ae : BaseE { func Name() string -> "a" }
            class Be : BaseE { func Name() string -> "b" }

            func PickBase(cond bool, a Ae, b Be) BaseE -> cond ? a : b
            func Main() {
                Console.WriteLine(PickBase(true, Ae(), Be()).Name())
                Console.WriteLine(PickBase(false, Ae(), Be()).Name())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("base\nbase\n", output);
    }

    [Fact]
    public void FacetF_ConditionalWithoutTargetUsesBestCommonType_VerifiesAndRuns()
    {
        // Regression: with NO contextual target type the conditional still binds to
        // the best-common-type (the shared base class) and a base method is callable.
        var source = """
            package Issue1480F
            import System
            open class BaseF { func Name() string -> "base" }
            class Af : BaseF, IShapeF { prop Tag int -> 7 }
            class Bf : BaseF, IShapeF { prop Tag int -> 8 }
            interface IShapeF { prop Tag int { get } }

            func NoTarget(cond bool, a Af, b Bf) string {
                let y = cond ? a : b
                return y.Name()
            }
            func Main() {
                Console.WriteLine(NoTarget(true, Af(), Bf()))
                Console.WriteLine(NoTarget(false, Af(), Bf()))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("base\nbase\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1480_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
