// <copyright file="Issue4164CyclicBaseClassConstructorParameterGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4164: several independent places in the binder walked the
/// symbol-level <c>StructSymbol.BaseClass</c> chain with no cycle guard. A
/// genuine base-class cycle (<c>class B : C</c> / <c>class C : B</c>) is
/// normally caught by the post-bind cycle detector (#973) before anything
/// else walks the chain — but declaration binding runs several such walks
/// EARLIER, on every struct, before that detector runs once at the end for
/// all of them:
/// <list type="bullet">
/// <item><description>
/// <c>BoundScope.TryLookupNestedTypeAliasIncludingInherited()</c>
/// (<c>for (var c = container.BaseClass; c != null; c = c.BaseClass)</c>),
/// reached while binding an EXPLICIT <c>init(...)</c> constructor parameter
/// whose type is a same-compilation, non-primitive class:
/// <c>DeclarationBinder.BindSingleConstructorDeclaration</c> →
/// <c>Binder.BindTypeClause</c> → ... → <c>Binder.LookupType</c> →
/// <c>BinderContext.TryLookupSourceType</c> →
/// <c>BoundScope.TryLookupLexicalNestedTypeAlias</c> → here. Confirmed via a
/// live <c>dotnet-stack report</c> on the hanging process — the same stack
/// frame repeats across samples taken seconds apart. This loop does not
/// allocate per iteration, so it is a CPU spin (measured ~80 MB RSS,
/// unbounded wall-clock time) rather than unbounded memory growth.
/// </description></item>
/// <item><description>
/// <c>TypeMemberModel.GetHierarchy(StructSymbol)</c> and
/// <c>ExternalClrOverrideResolver.GetStructHierarchy(StructSymbol)</c> — two
/// more private copies of the same unguarded walk, each building a
/// <c>List&lt;StructSymbol&gt;</c> — reached while binding an <c>override
/// prop</c> or <c>override event</c> member's base-member lookup
/// (<c>DeclarationBinder.BindStructProperties</c> /
/// <c>BindStructEvents</c> → <c>TypeMemberModel.TryGetProperty</c> /
/// <c>TryGetEvent</c>). Unlike the BoundScope site, THIS shape reproduces
/// #4162's original failure mode: measured ~13 GB RSS in 6 seconds on an
/// unfixed build (confirmed via <c>dotnet-stack report</c> showing
/// <c>List&lt;T&gt;.AddWithResize</c> directly under
/// <c>TypeMemberModel.GetHierarchy</c>).
/// </description></item>
/// <item><description>
/// <c>DeclarationBinder.BuildBaseTypeArgumentSubstitution(StructSymbol)</c>
/// (<c>for (var b = derived?.BaseClass; b != null; b = b.BaseClass)</c>),
/// reached unconditionally while binding an <c>override func</c> member
/// (<c>BindStructInstanceMethods</c>). Confirmed via <c>dotnet-stack
/// report</c>; a CPU spin like the BoundScope site (no growing collection).
/// </description></item>
/// </list>
/// All three shapes are fixed the same way #4162 fixed the original
/// <c>StructSymbol.GetHierarchy()</c>: they now go through that single,
/// already-guarded, <c>internal</c> walk (or, for the two remaining inline
/// loops that could not be trivially expressed as a hierarchy consumer,
/// a matching visited-set guard) instead of keeping independent unguarded
/// copies that could drift out of sync with a future fix.
///
/// Runs OUT-OF-PROCESS (rather than in-process via <c>Program.Main</c>),
/// polling the child's working set and killing it well below any real danger
/// threshold, IN ADDITION to a wall-clock timeout — a timeout alone is not
/// enough, per the same reasoning #4162's own test documents: an unguarded
/// regression CAN grow RSS fast enough to OOM-kill the CI runner itself
/// before a wall-clock timeout would ever fire (measured for the
/// <c>TypeMemberModel</c>/<c>ExternalClrOverrideResolver</c> shape above),
/// even though the BoundScope/BuildBaseTypeArgumentSubstitution shapes
/// happen to hang without growing memory. Either guard failing makes the
/// test fail cleanly instead of hanging or OOM-killing the shared runner.
/// </summary>
public class Issue4164CyclicBaseClassConstructorParameterGuardTests
{
    [Fact]
    public void ExplicitConstructorParameterTypedAsSameCompilationClass_OnCyclicHierarchy_DoesNotHangOrOom()
    {
        // B and C form a genuine two-type inheritance cycle (rejected with
        // GS0381 by the post-bind cycle detector). B's explicit
        // `init(value Widget)` constructor parameter names an ordinary,
        // acyclic same-compilation class — irrelevant to the cycle itself —
        // which is what drives declaration-time binding into
        // TryLookupNestedTypeAliasIncludingInherited() walking B/C's cyclic
        // BaseClass chain before the cycle detector has run.
        const string source = """
            package Probe

            class Widget {
                let Y int32
            }

            open class B : C {
                init(value Widget) {
                }
            }

            open class C : B {
                let W int32
            }
            """;

        var (exitCode, combined) = RunSourceOutOfProcess(source);

        Assert.True(exitCode != 0, $"expected gsc to reject this source but it succeeded:\n{combined}");

        // The cycle itself must still be rejected exactly as before.
        Assert.Contains("GS0381", combined);
    }

    [Fact]
    public void PrimitiveExplicitConstructorParameter_OnCyclicHierarchy_StillRejectsQuickly()
    {
        // Control from the issue's own isolation: swapping the same-
        // compilation class parameter for a primitive one was never affected
        // (TryLookupNestedTypeAliasIncludingInherited only runs for a
        // SOURCE-TYPE name lookup, never for a primitive). Kept here as a
        // fast, always-green sibling so a future change to this area has a
        // passing companion right next to the guarded repro.
        const string source = """
            package Probe

            open class B : C {
                init(value int32) {
                }
            }

            open class C : B {
                let W int32
            }
            """;

        var (exitCode, combined) = RunSourceOutOfProcess(source);

        Assert.True(exitCode != 0, $"expected gsc to reject this source but it succeeded:\n{combined}");
        Assert.Contains("GS0381", combined);
    }

    [Fact]
    public void OverridePropertyOnCyclicHierarchy_DoesNotHangOrOom()
    {
        // A second, independently reachable unguarded BaseClass walk found
        // during this issue's audit: TypeMemberModel.GetHierarchy(), reached
        // from TryGetProperty() while binding B's `override prop P`, before
        // the cycle detector has run. Unlike the BoundScope repro above,
        // this shape DOES grow memory (a List<StructSymbol> that never stops
        // appending) — measured ~13 GB RSS in 6 seconds on an unfixed build,
        // the same failure mode as #4162 itself.
        const string source = """
            package Probe

            open class B : C {
                override prop P int32 {
                    get { return 0 }
                }
            }

            open class C : B {
                open prop P int32 {
                    get { return 0 }
                }
            }
            """;

        var (exitCode, combined) = RunSourceOutOfProcess(source);

        Assert.True(exitCode != 0, $"expected gsc to reject this source but it succeeded:\n{combined}");
        Assert.Contains("GS0381", combined);
    }

    [Fact]
    public void OverrideEventOnCyclicHierarchy_DoesNotHangOrOom()
    {
        // Same TypeMemberModel.GetHierarchy() shape as the property repro
        // above, reached instead from TryGetEvent() while binding B's
        // `override event Changed`.
        const string source = """
            package Probe

            open class B : C {
                override event Changed func()
            }

            open class C : B {
                open event Changed func()
            }
            """;

        var (exitCode, combined) = RunSourceOutOfProcess(source);

        Assert.True(exitCode != 0, $"expected gsc to reject this source but it succeeded:\n{combined}");
        Assert.Contains("GS0381", combined);
    }

    [Fact]
    public void OverrideMethodOnCyclicHierarchy_DoesNotHangOrOom()
    {
        // A third independently reachable unguarded BaseClass walk found
        // during this issue's audit: DeclarationBinder.BuildBaseTypeArgumentSubstitution(),
        // reached unconditionally from BindStructInstanceMethods() while
        // binding B's `override func Foo`, before the cycle detector has
        // run. Like the BoundScope repro, this loop does not allocate per
        // iteration (a CPU spin, not memory growth).
        const string source = """
            package Probe

            open class B : C {
                override func Foo() {
                }
            }

            open class C : B {
                let W int32
            }
            """;

        var (exitCode, combined) = RunSourceOutOfProcess(source);

        Assert.True(exitCode != 0, $"expected gsc to reject this source but it succeeded:\n{combined}");
        Assert.Contains("GS0381", combined);
    }

    // Not itself a test method, so xUnit1031 (no blocking task operations in
    // [Fact] methods) does not apply: the blocking Task.Wait/GetResult below
    // only runs after WaitForExit has already confirmed the process exited,
    // mirroring IlVerifier.RunProcess's deadlock-safe concurrent-pipe-drain
    // pattern (also used by Issue4162CyclicAttributeHierarchyGuardTests).
    private static (int ExitCode, string Combined) RunSourceOutOfProcess(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue4164_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            return RunGscOutOfProcess(srcPath, outPath);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

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

        // A wall-clock timeout alone is not enough: an unguarded regression
        // in this call path can grow RSS fast enough to OOM-kill the CI
        // runner itself long before any timeout fires — the same failure
        // mode #4162's own test guards against. Poll the child's working set
        // and kill it well before it could threaten the runner, in addition
        // to the overall wall-clock ceiling below.
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
                    $"({workingSet / (1024 * 1024)} MB) compiling an explicit init(...) constructor " +
                    "parameter typed as a same-compilation class on a cyclic base-class hierarchy — " +
                    "BoundScope.TryLookupNestedTypeAliasIncludingInherited()'s cycle guard has regressed. " +
                    "Killed early to avoid OOM-killing the CI runner itself.");
            }

            if (elapsedMs >= timeoutMs)
            {
                KillAndDrain(proc);
                throw new TimeoutException(
                    $"gsc.dll did not exit within {timeoutMs} ms compiling an explicit init(...) " +
                    "constructor parameter typed as a same-compilation class on a cyclic base-class " +
                    "hierarchy — BoundScope.TryLookupNestedTypeAliasIncludingInherited()'s cycle guard " +
                    "has regressed.");
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
