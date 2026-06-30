// <copyright file="Issue1516CoalesceAsTypeParamEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1516 — null-coalescing (<c>??</c>) directly over an <c>as</c>-cast to
/// a REFERENCE-typed type parameter emitted unverifiable IL
/// (<c>StackUnexpected</c>). <c>BoundAsExpression.Type</c> for a reference
/// target is the BARE type parameter <c>T</c> (not <c>T?</c>), so the
/// <c>??</c> LHS is a <c>TypeParameterSymbol</c> directly — which the Issue
/// #831 box-probe path (gated on <c>NullableTypeSymbol(TP)</c>) missed in both
/// the slot collector and the emit branch. Emission fell through to the bottom
/// <c>dup; brtrue</c> shape, which the verifier rejects for an opaque
/// <c>!!T</c> stack value (ECMA-335 III.1.8).
/// <para>
/// The fix generalizes the box-probe spill to also cover a bare
/// reference-typed type-parameter LHS (<c>TypeParameterSymbol</c> that is NOT
/// struct-constrained): the collector pre-allocates a <c>T</c>-typed scratch
/// slot and the emitter spills the LHS, probes via <c>box !!T; brfalse
/// fallback</c>, and reloads the slot (non-null) or evaluates the RHS
/// (fallback). Every facet failed ilverify on current main and passes after
/// the fix. Each uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed.
/// </para>
/// </summary>
public class Issue1516CoalesceAsTypeParamEmitTests
{
    [Fact]
    public void EndToEnd_AsClassConstrainedT_CoalesceThrow_MatchedPath_Runs()
    {
        const string source = """
            package i1516matchedthrow
            import System
            import System.IO

            open class Box {
                let name string
                init(name string) { this.name = name }
                prop Name string -> name
            }

            class FooBox : Box {
                init(name string) : base(name) {}
            }

            class Factory {
                shared {
                    func Make[T Box](src Box) T {
                        return src as T ?? throw InvalidDataException("nope")
                    }
                }
            }

            func Main() {
                var b Box = FooBox("x")
                System.Console.WriteLine(Factory.Make[FooBox](b).Name)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("x\n", output);
    }

    [Fact]
    public void EndToEnd_AsClassConstrainedT_CoalesceFallback_FallbackPath_Runs()
    {
        // The cast `src as T` FAILS (a BarBox is not a FooBox), so the
        // fallback expression must be taken and returned.
        const string source = """
            package i1516fallbacktaken
            import System

            open class Box {
                let name string
                init(name string) { this.name = name }
                prop Name string -> name
            }

            class FooBox : Box {
                init(name string) : base(name) {}
            }

            class BarBox : Box {
                init(name string) : base(name) {}
            }

            class Factory {
                shared {
                    func Make[T Box](src Box, fallback T) T {
                        return src as T ?? fallback
                    }
                }
            }

            func Main() {
                var b Box = BarBox("bar")
                var fb FooBox = FooBox("fallback")
                System.Console.WriteLine(Factory.Make[FooBox](b, fb).Name)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("fallback\n", output);
    }

    [Fact]
    public void EndToEnd_AsUnconstrainedT_Coalesce_BothPaths_Runs()
    {
        // Unconstrained `T` used as a reference: the matched path prints the
        // cast value ("hello"); the fallback path prints the fallback ("fb2")
        // because boxing an int32 cannot be cast to string.
        const string source = """
            package i1516unconstrained
            import System

            class Holder {
                shared {
                    func Get[T](src object, fallback T) T {
                        return src as T ?? fallback
                    }
                }
            }

            func Main() {
                var s object = "hello"
                System.Console.WriteLine(Holder.Get[string](s, "fb"))
                var n object = 5
                System.Console.WriteLine(Holder.Get[string](n, "fb2"))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\nfb2\n", output);
    }

    [Fact]
    public void EndToEnd_Control_NullableTypeParamCoalesce_NoRegression_Runs()
    {
        // Control: `maybe T? ?? fallback` over a NullableTypeSymbol(TP) LHS
        // (the Issue #831 path) must remain ilverify-clean and correct.
        const string source = """
            package i1516controlnullable
            import System

            open class Box {
                let name string
                init(name string) { this.name = name }
                prop Name string -> name
            }

            class Factory {
                shared {
                    func Coalesce[T Box](maybe T?, fallback T) T {
                        return maybe ?? fallback
                    }
                }
            }

            func Main() {
                var present Box = Box("present")
                var fb Box = Box("fb")
                System.Console.WriteLine(Factory.Coalesce[Box](present as Box, fb).Name)
                System.Console.WriteLine(Factory.Coalesce[Box](nil, fb).Name)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("present\nfb\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1516_exe_").FullName;
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
