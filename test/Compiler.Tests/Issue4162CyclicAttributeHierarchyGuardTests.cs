// <copyright file="Issue4162CyclicAttributeHierarchyGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4162: <c>StructSymbol.GetHierarchy()</c> walked the symbol-level
/// <c>BaseClass</c> chain with no cycle guard. A genuine base-class cycle
/// (<c>class B : C</c> / <c>class C : B</c>) is normally caught by the
/// post-bind cycle detector (#973) before anything else walks the chain —
/// but <c>GetHierarchy()</c> is also reachable EARLIER, during declaration
/// binding, via <c>StructSymbol.DerivesFromSystemAttribute()</c> →
/// <c>DeclarationBinder.IsAttributeType()</c>, whenever an annotation names
/// a type that is itself part of an unresolved cycle. Without a guard, that
/// walk never terminates: the backing list grows without bound
/// (<c>B → C → B → C → ...</c>) until the process OOMs.
///
/// This was misdiagnosed at first as an in-process xUnit test-harness memory
/// leak (#4161, accumulation across many <c>Program.Main</c> calls in the
/// same process) because the only place it manifested was CI's
/// <c>compiler-issue7-9</c> shard, in
/// <c>Issue949SelfTypeArgumentInBaseClauseEmitTests</c> — the repo's only
/// existing tests compiling a genuinely cyclic, annotation-free class
/// hierarchy — under an in-flight, unmerged PR (#4154) whose new
/// declaration-time attribute check called
/// <c>DerivesFromSystemAttribute()</c> unconditionally for every class. A
/// 6000-iteration in-process repro on <c>main</c> (which lacks that new
/// unconditional call) showed no leak, which is what led to finding the
/// actual trigger: an annotation naming a cyclic type, reproducible with a
/// single external <c>gsc.dll</c> invocation on <c>main</c> itself.
///
/// Runs OUT-OF-PROCESS with a hard timeout (rather than in-process via
/// <c>Program.Main</c>) specifically so that if this guard ever regresses,
/// the test fails cleanly at the timeout instead of hanging or OOM-killing
/// the shared xUnit test-runner process — the same failure mode this issue
/// is about.
/// </summary>
public class Issue4162CyclicAttributeHierarchyGuardTests
{
    [Fact]
    public void AnnotationNamingCyclicType_DoesNotHangOrOom()
    {
        // B and C form a genuine two-type inheritance cycle (rejected with
        // GS0381 by the post-bind cycle detector). D's `@B` annotation names
        // B — a cyclic type — which is what drives declaration-time binding
        // into DerivesFromSystemAttribute() -> GetHierarchy() before the
        // cycle detector has run.
        const string source = """
            package Probe

            open class B : C {
                let V int32
            }

            open class C : B {
                let W int32
            }

            @B
            open class D {
                let X int32
            }
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_issue4162_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var (exitCode, combined) = RunGscOutOfProcess(srcPath, outPath);

            Assert.True(exitCode != 0, $"expected gsc to reject this source but it succeeded:\n{combined}");

            // The cycle itself must still be rejected exactly as before.
            Assert.Contains("GS0381", combined);

            // The annotation naming the (now-truncated) cyclic type must
            // still get a clean diagnostic rather than a crash.
            Assert.Contains("GS0200", combined);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    // Not itself a test method, so xUnit1031 (no blocking task operations in
    // [Fact] methods) does not apply: the blocking Task.Wait/GetResult below
    // only runs after WaitForExit has already confirmed the process exited,
    // mirroring IlVerifier.RunProcess's deadlock-safe concurrent-pipe-drain
    // pattern.
    private static (int ExitCode, string Combined) RunGscOutOfProcess(string srcPath, string outPath)
    {
        var gscPath = Path.Combine(AppContext.BaseDirectory, "gsc.dll");
        Assert.True(File.Exists(gscPath), $"gsc.dll not found at '{gscPath}'");

        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add(gscPath);
        psi.ArgumentList.Add("/out:" + outPath);
        psi.ArgumentList.Add("/target:library");
        psi.ArgumentList.Add("/targetframework:net10.0");
        psi.ArgumentList.Add(srcPath);

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start gsc.dll");

        var stdoutTask = proc.StandardOutput.ReadToEndAsync();
        var stderrTask = proc.StandardError.ReadToEndAsync();

        // A generous but bounded timeout: a correctly-guarded compile of this
        // trivial source finishes in well under a second. 30s is ample
        // headroom for a loaded CI runner while still failing fast (rather
        // than hanging the shard) if the guard regresses.
        const int timeoutMs = 30_000;
        if (!proc.WaitForExit(timeoutMs))
        {
            proc.Kill(entireProcessTree: true);
            proc.WaitForExit(5_000);
            throw new TimeoutException(
                $"gsc.dll did not exit within {timeoutMs} ms compiling an annotation naming a " +
                "cyclic-inheritance type — StructSymbol.GetHierarchy()'s cycle guard has regressed.");
        }

        var stdout = stdoutTask.GetAwaiter().GetResult();
        var stderr = stderrTask.GetAwaiter().GetResult();
        return (proc.ExitCode, stdout + stderr);
    }
}
