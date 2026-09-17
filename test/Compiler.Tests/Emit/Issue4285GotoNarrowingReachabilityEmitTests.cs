// <copyright file="Issue4285GotoNarrowingReachabilityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4285 (PR A of the ADR-0183 sequence) — emit-level regression
/// coverage for the goto-bypasses-nil-guard narrowing defect. Before the
/// fix, a nil-guard whose then-branch does <c>goto Skip</c> (landing right
/// after the guard) let the binder lift the guard's "non-nil" narrowing past
/// `Skip:` with zero diagnostics — so the emitted program read the
/// (possibly nil) field WITHOUT any null check and threw an unattributed
/// <see cref="NullReferenceException"/> at the first genuinely-nil call.
/// After the fix, the same source requires an explicit <c>!!</c> at the
/// dereference; once added, the compiled program runs exactly like any
/// other narrowed read: correctly, and with no exception, whenever the
/// guard's condition genuinely held at that point.
/// </summary>
public class Issue4285GotoNarrowingReachabilityEmitTests
{
    private const string AnimalHierarchy = """
        package Test
        import System

        open class Animal {
            var Name string
            open func Describe() string { return Name }
        }

        class Dog : Animal {
            override func Describe() string { return Name + " (dog)" }
        }

        """;

    [Fact]
    public void GotoBypassingGuard_WithExplicitForceUnwrap_RunsCorrectlyWithNoException()
    {
        // Same shape as the filed issue's repro (nil-guard whose then-branch
        // is `goto Skip`, with `Skip:` immediately after the if), but using
        // a nullable FIELD OF A USER TYPE so the fix's diagnostic actually
        // fires without `!!` (see the doc comment on
        // Issue4285GotoNarrowingReachabilityTests for why the issue's
        // literal `string?`/`ToUpper()` shape does not, for an unrelated,
        // pre-existing reason). With the fix, the narrowing lift no longer
        // survives the goto, so `b.Pet!!.Describe()` is required — and,
        // called with a genuinely non-nil `Pet`, runs to completion with no
        // exception, proving the fixed compiler still produces correct code
        // for the legitimate case.
        var source = AnimalHierarchy + """
            class Box {
                prop Pet Animal? { get; init; }
            }

            func Run(b Box) {
                if b.Pet == nil {
                    goto Skip
                }
                Skip:
                Console.WriteLine(b.Pet!!.Describe())
            }

            Run(Box() { Pet = Dog{Name: "Rex"} })
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"Rex (dog){Environment.NewLine}", output);
    }

    [Fact]
    public void GotoUnrelatedToNarrowing_LoopUnrollingStyle_RunsCorrectly()
    {
        // Negative-control emit coverage: an ordinary goto/label loop with
        // no narrowing anywhere nearby must keep compiling and running
        // exactly as before the fix.
        var source = """
            package Test
            import System

            func Sum() int32 {
                var total = 0
                var i = 0
            Loop:
                if i >= 5 {
                    goto Done
                }
                total = total + i
                i = i + 1
                goto Loop
            Done:
                return total
            }

            Console.WriteLine(Sum())
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"10{Environment.NewLine}", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue4285_").FullName;
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
            Assert.DoesNotContain("NullReferenceException", stderr, StringComparison.Ordinal);

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
