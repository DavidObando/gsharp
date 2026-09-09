// <copyright file="Issue4162CyclicAttributeHierarchyGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
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
/// Runs OUT-OF-PROCESS (rather than in-process via <c>Program.Main</c>),
/// polling the child's working set and killing it well below any real danger
/// threshold, IN ADDITION to a wall-clock timeout — a timeout alone is not
/// enough, since the pre-fix reproduction for this issue reached ~18 GB RSS
/// in 10 seconds, fast enough for an unguarded regression to OOM-kill the CI
/// runner itself before a 30s timeout would ever fire. Either guard failing
/// makes the test fail cleanly instead of hanging or OOM-killing the shared
/// runner — the same failure mode this issue is about.
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

        // A wall-clock timeout alone is not enough: the pre-fix reproduction
        // for this issue reached ~18 GB RSS in 10 seconds, so an unguarded
        // regression can OOM-kill the CI runner itself long before any
        // timeout fires — exactly the failure mode #4161 tracked. Poll the
        // child's working set and kill it well before it could threaten the
        // runner, in addition to the overall wall-clock ceiling below.
        const int pollIntervalMs = 100;
        const long memoryCeilingBytes = 512L * 1024 * 1024; // 512 MB.
        const int timeoutMs = 30_000;
        var elapsedMs = 0;
        while (!proc.WaitForExit(0))
        {
            proc.Refresh();
            long workingSet;
            try
            {
                workingSet = proc.WorkingSet64;
            }
            catch (InvalidOperationException)
            {
                // The process exited between WaitForExit(0) and the refresh.
                break;
            }

            if (workingSet > memoryCeilingBytes)
            {
                KillAndDrain(proc);
                throw new InvalidOperationException(
                    $"gsc.dll's working set exceeded {memoryCeilingBytes / (1024 * 1024)} MB " +
                    $"({workingSet / (1024 * 1024)} MB) compiling an annotation naming a " +
                    "cyclic-inheritance type — StructSymbol.GetHierarchy()'s cycle guard has regressed. " +
                    "Killed early to avoid OOM-killing the CI runner itself.");
            }

            if (elapsedMs >= timeoutMs)
            {
                KillAndDrain(proc);
                throw new TimeoutException(
                    $"gsc.dll did not exit within {timeoutMs} ms compiling an annotation naming a " +
                    "cyclic-inheritance type — StructSymbol.GetHierarchy()'s cycle guard has regressed.");
            }

            Thread.Sleep(pollIntervalMs);
            elapsedMs += pollIntervalMs;
        }

        var stdout = stdoutTask.GetAwaiter().GetResult();
        var stderr = stderrTask.GetAwaiter().GetResult();
        return (proc.ExitCode, stdout + stderr);
    }

    private static void KillAndDrain(Process proc)
    {
        try
        {
            proc.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // Already exited.
        }

        proc.WaitForExit(5_000);
    }
}
