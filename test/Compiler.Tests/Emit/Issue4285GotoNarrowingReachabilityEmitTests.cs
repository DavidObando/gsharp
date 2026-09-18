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
/// coverage for the goto-bypasses-nil-guard narrowing defect, through the
/// full CLI compile pipeline (<see cref="Program.Main"/>), not just the
/// binder in isolation. Before the fix, a nil-guard whose then-branch does
/// <c>goto Skip</c> (landing right after the guard) let the binder lift the
/// guard's "non-nil" narrowing past `Skip:` with zero diagnostics — so the
/// emitted program read the (possibly nil) field WITHOUT any null check and
/// threw an unattributed <see cref="NullReferenceException"/> at the first
/// genuinely-nil call. After the fix, gsc rejects that same source outright
/// (an explicit <c>!!</c> is required at the dereference); once added, the
/// compiled program runs correctly, with no exception, whenever the guard's
/// condition genuinely held at that point.
/// <para>
/// Known, separate, out-of-scope gap (tracked as issue #4287): the exact
/// literal repro filed against #4285 (<c>this.name string?</c> /
/// <c>this.name.ToUpper()</c>) still compiles with zero diagnostics and
/// still throws at runtime after this fix — because calling an
/// imported/CLR instance method through a nullable receiver is never
/// null-checked by gsc at all, independent of narrowing or `goto`
/// (verified: it reproduces identically with no `goto` and no narrowing
/// involved whatsoever). These tests therefore use a nullable field of a
/// USER-DEFINED type instead, which IS null-checked, so the tests actually
/// exercise the narrowing-lift mechanism #4285 is about.
/// </para>
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
    public void GotoBypassingGuard_WithoutForceUnwrap_FailsToCompile()
    {
        // The actual regression test for the fix, through the full compiler
        // pipeline (not just the binder): the exact vulnerable shape from
        // the filed issue (nil-guard whose then-branch is `goto Skip`, with
        // `Skip:` immediately after the if, then a dereference with NO
        // `!!`), using a nullable FIELD OF A USER TYPE so the diagnostic
        // fires at all (see the doc comment on
        // Issue4285GotoNarrowingReachabilityTests for why the issue's
        // literal `string?`/`ToUpper()` shape does not — a separate,
        // pre-existing gap tracked as issue #4287, not fixed by this PR).
        // Before the fix, this compiled with exit code 0 and the emitted
        // program threw NullReferenceException at runtime. After the fix,
        // the narrowing lift no longer survives the goto, so gsc itself
        // must reject the missing `!!` — proving the defense engages
        // through the full CLI compile path, not just the binder in
        // isolation.
        var source = AnimalHierarchy + """
            class Box {
                prop Pet Animal? { get; init; }
            }

            func Run(b Box) {
                if b.Pet == nil {
                    goto Skip
                }
                Skip:
                Console.WriteLine(b.Pet.Describe())
            }

            Run(Box() { Pet = Dog{Name: "Rex"} })
            """;

        var diagnostics = CompileExpectingFailure(source);
        Assert.Contains("may be nil", diagnostics);
    }

    [Fact]
    public void GotoBypassingGuard_WithExplicitForceUnwrap_RunsCorrectlyWithNoException()
    {
        // Companion positive case: once the required `!!` from the test
        // above is added, the fixed compiler still produces correct code
        // for the legitimate case — a genuinely non-nil `Pet` runs to
        // completion with no exception. This alone does NOT distinguish
        // fixed from unfixed behavior (an explicit `!!` over a non-nil value
        // compiles and runs identically either way) — see the test above
        // for the actual regression coverage.
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

    /// <summary>
    /// Compiles <paramref name="source"/> through the full CLI pipeline
    /// (<see cref="Program.Main"/>) and asserts compilation FAILS, returning
    /// the combined stdout+stderr diagnostic text for assertion. Companion
    /// to <see cref="CompileAndRun"/>, which asserts success.
    /// </summary>
    private static string CompileExpectingFailure(string source)
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
                compileExit != 0,
                $"gsc unexpectedly succeeded:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            return compileOut.ToString() + compileErr.ToString();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
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
