// <copyright file="Issue4162CyclicAttributeHierarchyGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System
import System.Diagnostics
import System.IO
import System.Threading
import Xunit

/// Issue #4162: `StructSymbol.GetHierarchy()` walked the symbol-level
/// `BaseClass` chain with no cycle guard. A genuine base-class cycle
/// (`class B : C` / `class C : B`) is normally caught by the
/// post-bind cycle detector (#973) before anything else walks the chain —
/// but `GetHierarchy()` is also reachable EARLIER, during declaration
/// binding, via `StructSymbol.DerivesFromSystemAttribute()` →
/// `DeclarationBinder.IsAttributeType()`, whenever an annotation names
/// a type that is itself part of an unresolved cycle. Without a guard, that
/// walk never terminates: the backing list grows without bound
/// (`B → C → B → C → ...`) until the process OOMs.
///
/// This was misdiagnosed at first as an in-process xUnit test-harness memory
/// leak (#4161, accumulation across many `Program.Main` calls in the
/// same process) because the only place it manifested was CI's
/// `compiler-issue7-9` shard, in
/// `Issue949SelfTypeArgumentInBaseClauseEmitTests` — the repo's only
/// existing tests compiling a genuinely cyclic, annotation-free class
/// hierarchy — under an in-flight, unmerged PR (#4154) whose new
/// declaration-time attribute check called
/// `DerivesFromSystemAttribute()` unconditionally for every class. A
/// 6000-iteration in-process repro on `main` (which lacks that new
/// unconditional call) showed no leak, which is what led to finding the
/// actual trigger: an annotation naming a cyclic type, reproducible with a
/// single external `gsc.dll` invocation on `main` itself.
///
/// Runs OUT-OF-PROCESS (rather than in-process via `Program.Main`),
/// polling the child's working set and killing it well below any real danger
/// threshold, IN ADDITION to a wall-clock timeout — a timeout alone is not
/// enough, since the pre-fix reproduction for this issue reached ~18 GB RSS
/// in 10 seconds, fast enough for an unguarded regression to OOM-kill the CI
/// runner itself before a 30s timeout would ever fire. Either guard failing
/// makes the test fail cleanly instead of hanging or OOM-killing the shared
/// runner — the same failure mode this issue is about.
open class Issue4162CyclicAttributeHierarchyGuardTests {
    @Fact
    func AnnotationNamingCyclicType_DoesNotHangOrOom() {
        // B and C form a genuine two-type inheritance cycle (rejected with
        // GS0381 by the post-bind cycle detector). D's `@B` annotation names
        // B — a cyclic type — which is what drives declaration-time binding
        // into DerivesFromSystemAttribute() -> GetHierarchy() before the
        // cycle detector has run.
        const source = `package Probe

open class B : C {
    let V int32
}

open class C : B {
    let W int32
}

@B
open class D {
    let X int32
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_issue4162_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let (exitCode, combined) = RunGscOutOfProcess(srcPath, outPath)
            Assert.True(exitCode != 0, (`expected gsc to reject this source but it succeeded:
` + "$combined"))
            // The cycle itself must still be rejected exactly as before.
            Assert.Contains("GS0381", combined)
            // The annotation naming the (now-truncated) cyclic type must
            // still get a clean diagnostic rather than a crash.
            Assert.Contains("GS0200", combined)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    shared {
        // Not itself a test method, so xUnit1031 (no blocking task operations in
        // [Fact] methods) does not apply: the blocking Task.Wait/GetResult below
        // only runs after WaitForExit has already confirmed the process exited,
        // mirroring IlVerifier.RunProcess's deadlock-safe concurrent-pipe-drain
        // pattern.
        private func RunGscOutOfProcess(srcPath string, outPath string)(ExitCode int32, Combined string) {
            let gscPath = Path.Combine(AppContext.BaseDirectory, "gsc.dll")
            Assert.True(File.Exists(gscPath), "gsc.dll not found at '$gscPath'")
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            psi.ArgumentList.Add(gscPath)
            psi.ArgumentList.Add("/out:" + outPath)
            psi.ArgumentList.Add("/target:library")
            psi.ArgumentList.Add("/targetframework:net10.0")
            psi.ArgumentList.Add(srcPath)
            using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start gsc.dll")
            let stdoutTask = proc.StandardOutput.ReadToEndAsync()
            let stderrTask = proc.StandardError.ReadToEndAsync()
            // A wall-clock timeout alone is not enough: the pre-fix reproduction
            // for this issue reached ~18 GB RSS in 10 seconds, so an unguarded
            // regression can OOM-kill the CI runner itself long before any
            // timeout fires — exactly the failure mode #4161 tracked. Poll the
            // child's working set and kill it well before it could threaten the
            // runner, in addition to the overall wall-clock ceiling below.
            const pollIntervalMs = 100
            const memoryCeilingBytes = 512L * int64(1024) * int64(1024) // 512 MB.
            const timeoutMs = 30_000
            var elapsedMs = 0
            while !proc.WaitForExit(0) {
                proc.Refresh()
                var workingSet int64
                try {
                    workingSet = proc.WorkingSet64
                } catch (InvalidOperationException) {
                    // The process exited between WaitForExit(0) and the refresh.
                    break
                }
                if workingSet > memoryCeilingBytes {
                    KillAndDrain(proc)
                    throw InvalidOperationException(
                        "gsc.dll's working set exceeded ${memoryCeilingBytes / int64((1024 * 1024))} MB " +
                            "(${workingSet / int64((1024 * 1024))} MB) compiling an annotation naming a " +
                            "cyclic-inheritance type — StructSymbol.GetHierarchy()'s cycle guard has regressed. " +
                            "Killed early to avoid OOM-killing the CI runner itself."
                    )
                }
                if elapsedMs >= timeoutMs {
                    KillAndDrain(proc)
                    throw TimeoutException(
                        "gsc.dll did not exit within $timeoutMs ms compiling an annotation naming a " +
                            "cyclic-inheritance type — StructSymbol.GetHierarchy()'s cycle guard has regressed."
                    )
                }
                Thread.Sleep(pollIntervalMs)
                elapsedMs += pollIntervalMs
            }
            let stdout = stdoutTask.GetAwaiter().GetResult()
            let stderr = stderrTask.GetAwaiter().GetResult()
            return (proc.ExitCode, stdout + stderr)
        }

        private func KillAndDrain(proc Process) {
            try {
                proc.Kill(entireProcessTree: true)
            } catch (InvalidOperationException) {
                // Already exited.

            }
            proc.WaitForExit(5_000)
        }
    }
}
