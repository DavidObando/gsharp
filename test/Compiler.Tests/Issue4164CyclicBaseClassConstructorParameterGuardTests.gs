// <copyright file="Issue4164CyclicBaseClassConstructorParameterGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System
import System.Diagnostics
import System.IO
import System.Threading
import Xunit

/// Issue #4164: several independent places in the binder walked the
/// symbol-level `StructSymbol.BaseClass` chain with no cycle guard. A
/// genuine base-class cycle (`class B : C` / `class C : B`) is
/// normally caught by the post-bind cycle detector (#973) before anything
/// else walks the chain — but declaration binding runs several such walks
/// EARLIER, on every struct, before that detector runs once at the end for
/// all of them:
/// - `BoundScope.TryLookupNestedTypeAliasIncludingInherited()`
/// (`for (var c = container.BaseClass; c != null; c = c.BaseClass)`), reached while binding an EXPLICIT
/// `init(...)` constructor parameter whose type is a same-compilation, non-primitive class:
/// `DeclarationBinder.BindSingleConstructorDeclaration` → `Binder.BindTypeClause` → ... →
/// `Binder.LookupType` → `BinderContext.TryLookupSourceType` →
/// `BoundScope.TryLookupLexicalNestedTypeAlias` → here. Confirmed via a live `dotnet-stack report` on
/// the hanging process — the same stack frame repeats across samples taken seconds apart. This loop
/// does not allocate per iteration, so it is a CPU spin (measured ~80 MB RSS, unbounded wall-clock
/// time) rather than unbounded memory growth.
/// - `TypeMemberModel.GetHierarchy(StructSymbol)` and
/// `ExternalClrOverrideResolver.GetStructHierarchy(StructSymbol)` — two more private copies of the same
/// unguarded walk, each building a `List<StructSymbol>` — reached while binding an `override prop` or
/// `override event` member's base-member lookup (`DeclarationBinder.BindStructProperties` /
/// `BindStructEvents` → `TypeMemberModel.TryGetProperty` / `TryGetEvent`). Unlike the BoundScope site,
/// THIS shape reproduces #4162's original failure mode: measured ~13 GB RSS in 6 seconds on an unfixed
/// build (confirmed via `dotnet-stack report` showing `List<T>.AddWithResize` directly under
/// `TypeMemberModel.GetHierarchy`).
/// - `DeclarationBinder.BuildBaseTypeArgumentSubstitution(StructSymbol)`
/// (`for (var b = derived?.BaseClass; b != null; b = b.BaseClass)`), reached unconditionally while
/// binding an `override func` member (`BindStructInstanceMethods`). Confirmed via
/// `dotnet-stack report`; a CPU spin like the BoundScope site (no growing collection).
/// Two more unguarded walks were found and fixed the same way, though no
/// isolated repro was built for either (both are reachable only from the
/// already-traced entry points above): `AccessibilityChecker.
/// IsAccessibleFromType()` and `BinderContext.
/// ImportedTypeOverridesSourceType()`.
///
/// All five sites are fixed the same way #4162 fixed the original
/// `StructSymbol.GetHierarchy()`: every one of them now goes through
/// that single, already-guarded, `internal` walk — including
/// `TryLookupNestedTypeAliasIncludingInherited()` itself, whose own
/// fix started as a hand-rolled `visited`-set guard and was then
/// consolidated onto `GetHierarchy()` too, for consistency — instead of
/// keeping independent unguarded (or independently-guarded) copies that
/// could drift out of sync with a future fix again.
///
/// Runs OUT-OF-PROCESS (rather than in-process via `Program.Main`),
/// polling the child's working set and killing it well below any real danger
/// threshold, IN ADDITION to a wall-clock timeout — a timeout alone is not
/// enough, per the same reasoning #4162's own test documents: an unguarded
/// regression CAN grow RSS fast enough to OOM-kill the CI runner itself
/// before a wall-clock timeout would ever fire (measured for the
/// `TypeMemberModel`/`ExternalClrOverrideResolver` shape above),
/// even though the BoundScope/BuildBaseTypeArgumentSubstitution shapes
/// happen to hang without growing memory. Either guard failing makes the
/// test fail cleanly instead of hanging or OOM-killing the shared runner.
open class Issue4164CyclicBaseClassConstructorParameterGuardTests {
    @Fact
    func ExplicitConstructorParameterTypedAsSameCompilationClass_OnCyclicHierarchy_DoesNotHangOrOom() {
        // B and C form a genuine two-type inheritance cycle (rejected with
        // GS0381 by the post-bind cycle detector). B's explicit
        // `init(value Widget)` constructor parameter names an ordinary,
        // acyclic same-compilation class — irrelevant to the cycle itself —
        // which is what drives declaration-time binding into
        // TryLookupNestedTypeAliasIncludingInherited() walking B/C's cyclic
        // BaseClass chain before the cycle detector has run.
        const source = `package Probe

class Widget {
    let Y int32
}

open class B : C {
    init(value Widget) {
    }
}

open class C : B {
    let W int32
}`
        let (exitCode, combined) = RunSourceOutOfProcess(source)
        Assert.True(exitCode != 0, (`expected gsc to reject this source but it succeeded:
` + "$combined"))
        // The cycle itself must still be rejected exactly as before.
        Assert.Contains("GS0381", combined)
    }

    @Fact
    func PrimitiveExplicitConstructorParameter_OnCyclicHierarchy_StillRejectsQuickly() {
        // Control from the issue's own isolation: swapping the same-
        // compilation class parameter for a primitive one was never affected
        // (TryLookupNestedTypeAliasIncludingInherited only runs for a
        // SOURCE-TYPE name lookup, never for a primitive). Kept here as a
        // fast, always-green sibling so a future change to this area has a
        // passing companion right next to the guarded repro.
        const source = `package Probe

open class B : C {
    init(value int32) {
    }
}

open class C : B {
    let W int32
}`
        let (exitCode, combined) = RunSourceOutOfProcess(source)
        Assert.True(exitCode != 0, (`expected gsc to reject this source but it succeeded:
` + "$combined"))
        Assert.Contains("GS0381", combined)
    }

    @Fact
    func OverridePropertyOnCyclicHierarchy_DoesNotHangOrOom() {
        // A second, independently reachable unguarded BaseClass walk found
        // during this issue's audit: TypeMemberModel.GetHierarchy(), reached
        // from TryGetProperty() while binding B's `override prop P`, before
        // the cycle detector has run. Unlike the BoundScope repro above,
        // this shape DOES grow memory (a List<StructSymbol> that never stops
        // appending) — measured ~13 GB RSS in 6 seconds on an unfixed build,
        // the same failure mode as #4162 itself.
        const source = `package Probe

open class B : C {
    override prop P int32 {
        get { return 0 }
    }
}

open class C : B {
    open prop P int32 {
        get { return 0 }
    }
}`
        let (exitCode, combined) = RunSourceOutOfProcess(source)
        Assert.True(exitCode != 0, (`expected gsc to reject this source but it succeeded:
` + "$combined"))
        Assert.Contains("GS0381", combined)
    }

    @Fact
    func OverrideEventOnCyclicHierarchy_DoesNotHangOrOom() {
        // Same TypeMemberModel.GetHierarchy() shape as the property repro
        // above, reached instead from TryGetEvent() while binding B's
        // `override event Changed`.
        const source = `package Probe

open class B : C {
    override event Changed func()
}

open class C : B {
    open event Changed func()
}`
        let (exitCode, combined) = RunSourceOutOfProcess(source)
        Assert.True(exitCode != 0, (`expected gsc to reject this source but it succeeded:
` + "$combined"))
        Assert.Contains("GS0381", combined)
    }

    @Fact
    func OverrideMethodOnCyclicHierarchy_DoesNotHangOrOom() {
        // A third independently reachable unguarded BaseClass walk found
        // during this issue's audit: DeclarationBinder.BuildBaseTypeArgumentSubstitution(),
        // reached unconditionally from BindStructInstanceMethods() while
        // binding B's `override func Foo`, before the cycle detector has
        // run. Like the BoundScope repro, this loop does not allocate per
        // iteration (a CPU spin, not memory growth).
        const source = `package Probe

open class B : C {
    override func Foo() {
    }
}

open class C : B {
    let W int32
}`
        let (exitCode, combined) = RunSourceOutOfProcess(source)
        Assert.True(exitCode != 0, (`expected gsc to reject this source but it succeeded:
` + "$combined"))
        Assert.Contains("GS0381", combined)
    }

    shared {
        // Not itself a test method, so xUnit1031 (no blocking task operations in
        // [Fact] methods) does not apply: the blocking Task.Wait/GetResult below
        // only runs after WaitForExit has already confirmed the process exited,
        // mirroring IlVerifier.RunProcess's deadlock-safe concurrent-pipe-drain
        // pattern (also used by Issue4162CyclicAttributeHierarchyGuardTests).
        private func RunSourceOutOfProcess(source string)(ExitCode int32, Combined string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue4164_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                return RunGscOutOfProcess(srcPath, outPath)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

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
            // A wall-clock timeout alone is not enough: an unguarded regression
            // in this call path can grow RSS fast enough to OOM-kill the CI
            // runner itself long before any timeout fires — the same failure
            // mode #4162's own test guards against. Poll the child's working set
            // and kill it well before it could threaten the runner, in addition
            // to the overall wall-clock ceiling below.
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
                            "(${workingSet / int64((1024 * 1024))} MB) compiling an explicit init(...) constructor " +
                            "parameter typed as a same-compilation class on a cyclic base-class hierarchy — " +
                            "BoundScope.TryLookupNestedTypeAliasIncludingInherited()'s cycle guard has regressed. " +
                            "Killed early to avoid OOM-killing the CI runner itself."
                    )
                }
                if elapsedMs >= timeoutMs {
                    KillAndDrain(proc)
                    throw TimeoutException(
                        "gsc.dll did not exit within $timeoutMs ms compiling an explicit init(...) " +
                            "constructor parameter typed as a same-compilation class on a cyclic base-class " +
                            "hierarchy — BoundScope.TryLookupNestedTypeAliasIncludingInherited()'s cycle guard " +
                            "has regressed."
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
