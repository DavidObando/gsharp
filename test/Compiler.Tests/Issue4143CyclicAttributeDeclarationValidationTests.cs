// <copyright file="Issue4143CyclicAttributeDeclarationValidationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4143 / #4162: <c>DeclarationBinder.DerivesFromSystemAttributeDuringDeclaration</c>
/// (added by #4143's GS0585 declaration-time check) calls
/// <c>StructSymbol.DerivesFromSystemAttribute()</c> — and therefore
/// <c>StructSymbol.GetHierarchy()</c> — UNCONDITIONALLY for every struct/class
/// declaration, not only ones that turn out to be attribute classes. Before
/// #4162's fix, a genuine base-class cycle (<c>class B : C</c> / <c>class C :
/// B</c>, normally caught only later by the post-bind cycle detector, #973)
/// made that walk loop forever — #4143's own check is what turned a
/// previously dormant bug into one reachable from EVERY class declaration
/// (see #4162's writeup and <c>Issue4162CyclicAttributeHierarchyGuardTests</c>
/// for the full incident).
/// </summary>
/// <remarks>
/// <para>#4162 fixed the shared root cause (<c>GetHierarchy()</c>'s missing
/// cycle guard) and added its own regression test. This file adds
/// #4143-specific coverage on top: it is not enough that the process no
/// longer hangs — <c>DerivesFromSystemAttributeDuringDeclaration</c> must
/// still answer the right question for a cyclic class (it is not an
/// attribute, so GS0585 must not fire for it — the cycle diagnostic GS0381
/// is the correct and only answer), and the presence of a cycle elsewhere in
/// the compilation must not suppress or corrupt GS0585 validation for an
/// UNRELATED, genuinely ill-formed attribute class in the same file.</para>
/// <para>Runs OUT-OF-PROCESS with the same memory-ceiling-plus-timeout guard
/// <c>Issue4162CyclicAttributeHierarchyGuardTests</c> established, rather than
/// the in-process <c>Program.Main</c> helper the rest of this test suite
/// uses: a regression here is exactly the shape that OOM-killed the shared
/// CI runner once already, so it must fail cleanly at a bounded ceiling
/// instead of repeating that incident.</para>
/// </remarks>
public class Issue4143CyclicAttributeDeclarationValidationTests
{
    [Fact]
    public void ACyclicNonAttributeClass_ReportsOnlyTheCycleDiagnostic_NotGS0585()
    {
        // B and C form a genuine two-type inheritance cycle (GS0381).
        // Neither derives from System.Attribute anywhere in the cycle, but B
        // declares a PRIMARY constructor parameter shaped exactly like the
        // ones #4143's own tests use to trigger GS0585 (a same-compilation
        // class, Widget, which is not a valid attribute parameter type). If
        // DerivesFromSystemAttributeDuringDeclaration ever misreported a
        // cyclic class as attribute-derived (rather than correctly answering
        // "no" once GetHierarchy() terminates), this would ALSO report
        // GS0585 — the wrong diagnostic for a class that is not an attribute
        // at all. Only the cycle diagnostic is expected.
        //
        // Deliberately a PRIMARY constructor, not an explicit `init(...)`:
        // measured separately (not fixed here, filed as #4164) that an
        // EXPLICIT constructor whose parameter is a same-compilation class,
        // combined with a base-class cycle, hangs independent of #4143 —
        // reproduces identically on e2913d9b (immediately after #4162's own
        // fix, before any of this PR's commits), so it is a pre-existing,
        // unrelated defect and out of scope here.
        const string Source = """
            package Probe

            class Widget {
                let Y int32
            }

            open class B(Value Widget) : C {
            }

            open class C : B {
                let W int32
            }
            """;

        var (exitCode, combined) = CompileOutOfProcess(Source, "gs_4143_cycle_no_attr_");

        Assert.True(exitCode != 0, $"expected gsc to reject this source but it succeeded:\n{combined}");
        Assert.Contains("GS0381", combined);
        Assert.DoesNotContain("GS0585", combined);
    }

    [Fact]
    public void ACycleElsewhereInTheCompilation_DoesNotSuppressGS0585ForAnUnrelatedAttribute()
    {
        // The same B/C cycle as above, PLUS an entirely separate, genuinely
        // ill-formed attribute class (BoxedAttribute, deriving cleanly from
        // Attribute with no cycle involved) declared in the same
        // compilation. Proves the cycle's presence does not corrupt or
        // short-circuit GS0585 validation for an unrelated class that comes
        // before or after it in source order.
        const string Source = """
            package Probe
            import System

            class Holder {
                let Y int32
            }

            open class B : C {
                let V int32
            }

            open class C : B {
                let W int32
            }

            class BoxedAttribute(Value Holder) : Attribute {
            }
            """;

        var (exitCode, combined) = CompileOutOfProcess(Source, "gs_4143_cycle_plus_attr_");

        Assert.True(exitCode != 0, $"expected gsc to reject this source but it succeeded:\n{combined}");
        Assert.Contains("GS0381", combined);
        Assert.Contains("GS0585", combined);
    }

    // Not itself a test method, so xUnit1031 (no blocking task operations in
    // [Fact] methods) does not apply: the blocking Task.Wait/GetResult below
    // only runs after WaitForExit has already confirmed the process exited,
    // mirroring Issue4162CyclicAttributeHierarchyGuardTests' pattern.
    private static (int ExitCode, string Combined) CompileOutOfProcess(string source, string tempDirPrefix)
    {
        var tempDir = Directory.CreateTempSubdirectory(tempDirPrefix).FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            return RunGscOutOfProcess(srcPath, outPath);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
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

        // Same dual guard as Issue4162CyclicAttributeHierarchyGuardTests: a
        // wall-clock timeout alone is not enough, since the pre-#4162
        // reproduction reached ~18 GB RSS in 10 seconds — fast enough to
        // OOM-kill the runner before any timeout fires. Poll the child's
        // working set and kill it well before that.
        const int PollIntervalMs = 100;
        const long MemoryCeilingBytes = 512L * 1024 * 1024; // 512 MB.
        const int TimeoutMs = 30_000;
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

            if (workingSet > MemoryCeilingBytes)
            {
                KillAndDrain(proc);
                throw new InvalidOperationException(
                    $"gsc.dll's working set exceeded {MemoryCeilingBytes / (1024 * 1024)} MB " +
                    $"({workingSet / (1024 * 1024)} MB) compiling a cyclic-inheritance class — " +
                    "DerivesFromSystemAttributeDuringDeclaration / GetHierarchy()'s cycle guard has regressed. " +
                    "Killed early to avoid OOM-killing the CI runner itself.");
            }

            if (elapsedMs >= TimeoutMs)
            {
                KillAndDrain(proc);
                throw new TimeoutException(
                    $"gsc.dll did not exit within {TimeoutMs} ms compiling a cyclic-inheritance class — " +
                    "DerivesFromSystemAttributeDuringDeclaration / GetHierarchy()'s cycle guard has regressed.");
            }

            Thread.Sleep(PollIntervalMs);
            elapsedMs += PollIntervalMs;
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
