// <copyright file="Issue3734ImportedHomonymAmbiguityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3734: two referenced assemblies export a same-named type whose
/// members are COMPATIBLE, so on <c>main</c> the first-import-wins mis-binding
/// compiled cleanly and ran against the type the author never named — the
/// silent-wrong-code shape. The bare reference is now GS0547, an error, and
/// the two escape hatches G# already has (the qualified spelling and
/// <c>import Alias = Namespace.Type</c>) both pin the intended type.
/// <para>
/// The same-type cases are the anti-vacuity guard: a check that fired on every
/// name reachable through two imports would be useless, so a name reached
/// twice through the SAME type, and a name only one import can resolve, must
/// stay silent.
/// </para>
/// </summary>
public class Issue3734ImportedHomonymAmbiguityTests
{
    private const string AlphaLibrary = """
        package Probe.Alpha

        class Thing {
            shared {
                func Name() string { return "alpha" }
            }
        }

        class OnlyAlpha {
            shared {
                func Name() string { return "only-alpha" }
            }
        }
        """;

    private const string BetaLibrary = """
        package Probe.Beta

        class Thing {
            shared {
                func Name() string { return "beta" }
            }
        }
        """;

    [Fact]
    public void DifferentTypes_BareName_IsRejectedAndNamesBothCandidates()
    {
        // On main this compiled to exit 0 and printed "alpha".
        (int exitCode, string output, _) = CompileAndRun("""
            package Probe.App

            import System
            import Probe.Alpha
            import Probe.Beta

            Console.WriteLine(Thing.Name())
            """);

        Assert.True(exitCode != 0, "expected gsc to reject the bare homonym:\n" + output);
        Assert.Contains("GS0547", output, StringComparison.Ordinal);
        Assert.Contains("Probe.Alpha.Thing", output, StringComparison.Ordinal);
        Assert.Contains("Probe.Beta.Thing", output, StringComparison.Ordinal);

        // The message names the candidate first-import-wins WOULD have picked;
        // this file's import order made it Alpha.
        Assert.Contains("would bind 'Probe.Alpha.Thing'", output, StringComparison.Ordinal);
    }

    [Fact]
    public void DifferentTypes_ImportOrderReversed_ReportsTheOtherCandidateAsTheWinner()
    {
        // The point of the diagnostic: nothing in the reference changed, only
        // the order of two lines the author is unlikely to read as semantic —
        // and the silent answer flipped with it.
        (int exitCode, string output, _) = CompileAndRun("""
            package Probe.App

            import System
            import Probe.Beta
            import Probe.Alpha

            Console.WriteLine(Thing.Name())
            """);

        Assert.True(exitCode != 0, "expected gsc to reject the bare homonym:\n" + output);
        Assert.Contains("GS0547", output, StringComparison.Ordinal);
        Assert.Contains("would bind 'Probe.Beta.Thing'", output, StringComparison.Ordinal);
    }

    [Fact]
    public void DifferentTypes_TypeClausePosition_ReportsAmbiguity()
    {
        // The #3725 shape: the collision is in a declared type, not a receiver.
        (int exitCode, string output, _) = CompileAndRun("""
            package Probe.App

            import System
            import Probe.Alpha
            import Probe.Beta

            func Describe(t Thing) string { return "seen" }

            Console.WriteLine(Describe(Probe.Alpha.Thing()))
            """);

        Assert.True(exitCode != 0, "expected gsc to reject the bare homonym:\n" + output);
        Assert.Contains("GS0547", output, StringComparison.Ordinal);
    }

    [Fact]
    public void DifferentTypes_ConstructionPosition_ReportsAmbiguity()
    {
        // `Thing()` constructs whichever homonym the import order picked, which
        // is the shape most likely to compile and behave wrongly.
        (int exitCode, string output, _) = CompileAndRun("""
            package Probe.App

            import System
            import Probe.Alpha
            import Probe.Beta

            let t = Thing()
            Console.WriteLine("built")
            """);

        Assert.True(exitCode != 0, "expected gsc to reject the bare homonym:\n" + output);
        Assert.Contains("GS0547", output, StringComparison.Ordinal);
    }

    [Fact]
    public void ConstructionPosition_ImportTypeAlias_IsTheEscapeHatch()
    {
        // A package-qualified CONSTRUCTION of an imported CLR type is not a
        // spelling gsc accepts (`Probe.Beta.Thing()` is GS0157), so the alias
        // import is the escape hatch that has to work here.
        (int exitCode, string output, string stdout) = CompileAndRun("""
            package Probe.App

            import System
            import Probe.Alpha
            import Probe.Beta
            import BetaThing = Probe.Beta.Thing

            Console.WriteLine(BetaThing.Name())
            """);

        Assert.Equal(0, exitCode);
        Assert.DoesNotContain("GS0547", output, StringComparison.Ordinal);
        Assert.Equal("beta" + Environment.NewLine, stdout);
    }

    [Fact]
    public void SameName_OnlyOneImportResolvesIt_StaysSilent()
    {
        // Anti-vacuity: both packages are imported, but only one exports this
        // name, so there is no choice to report.
        (int exitCode, string output, string stdout) = CompileAndRun("""
            package Probe.App

            import System
            import Probe.Alpha
            import Probe.Beta

            Console.WriteLine(OnlyAlpha.Name())
            """);

        Assert.Equal(0, exitCode);
        Assert.DoesNotContain("GS0547", output, StringComparison.Ordinal);
        Assert.Equal("only-alpha" + Environment.NewLine, stdout);
    }

    [Fact]
    public void SameType_ReachedThroughTheImplicitAndTheExplicitImport_StaysSilent()
    {
        // Anti-vacuity: `System` is imported twice (once by the compiler, once
        // by the author) and `Console` resolves to the SAME type both times —
        // the choice does not matter, so there is nothing to report.
        (int exitCode, string output, string stdout) = CompileAndRun("""
            package Probe.App

            import System
            import Probe.Alpha
            import Probe.Beta

            Console.WriteLine("same")
            """);

        Assert.Equal(0, exitCode);
        Assert.DoesNotContain("GS0547", output, StringComparison.Ordinal);
        Assert.Equal("same" + Environment.NewLine, stdout);
    }

    [Fact]
    public void QualifiedSpelling_SilencesTheAmbiguityAndPinsTheType()
    {
        (int exitCode, string output, string stdout) = CompileAndRun("""
            package Probe.App

            import System
            import Probe.Alpha
            import Probe.Beta

            Console.WriteLine(Probe.Beta.Thing.Name())
            """);

        Assert.Equal(0, exitCode);
        Assert.DoesNotContain("GS0547", output, StringComparison.Ordinal);
        Assert.Equal("beta" + Environment.NewLine, stdout);
    }

    [Fact]
    public void ImportTypeAlias_SilencesTheAmbiguityAndPinsTheType()
    {
        // The escape hatch G# already has (issue #2273), and the one cs2gs
        // already knows how to emit.
        (int exitCode, string output, string stdout) = CompileAndRun("""
            package Probe.App

            import System
            import Probe.Alpha
            import Probe.Beta
            import Thing = Probe.Beta.Thing

            Console.WriteLine(Thing.Name())
            """);

        Assert.Equal(0, exitCode);
        Assert.DoesNotContain("GS0547", output, StringComparison.Ordinal);
        Assert.Equal("beta" + Environment.NewLine, stdout);
    }

    private static (int ExitCode, string Output, string Stdout) CompileAndRun(string appSource)
    {
        (int exitCode, string output) = Build(appSource, out string workDir, out string appPath);
        try
        {
            if (exitCode != 0)
            {
                return (exitCode, output, string.Empty);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(appPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(appPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("failed to start dotnet exec");
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(60_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return (exitCode, output, stdout.ReplaceLineEndings(Environment.NewLine));
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static (int ExitCode, string Output) Build(string appSource, out string workDir, out string appPath)
    {
        // Two SEPARATE assemblies: the homonyms must come from referenced
        // metadata, never from the app's own compilation (which the source-type
        // collision rule, GS0496, already covers).
        workDir = Directory.CreateTempSubdirectory("gs_issue3734_").FullName;
        string alphaLibPath = Path.Combine(workDir, "Probe.Alpha.dll");
        string betaLibPath = Path.Combine(workDir, "Probe.Beta.dll");
        appPath = Path.Combine(workDir, "Probe.App.dll");

        string alphaPath = Path.Combine(workDir, "Alpha.gs");
        string betaPath = Path.Combine(workDir, "Beta.gs");
        string appSourcePath = Path.Combine(workDir, "App.gs");
        File.WriteAllText(alphaPath, AlphaLibrary);
        File.WriteAllText(betaPath, BetaLibrary);
        File.WriteAllText(appSourcePath, appSource);

        (int alphaExit, string alphaOutput) = RunGsc(
            "/out:" + alphaLibPath,
            "/target:library",
            references: Array.Empty<string>(),
            sources: new[] { alphaPath });
        Assert.True(alphaExit == 0, "Probe.Alpha failed to compile:\n" + alphaOutput);

        (int betaExit, string betaOutput) = RunGsc(
            "/out:" + betaLibPath,
            "/target:library",
            references: Array.Empty<string>(),
            sources: new[] { betaPath });
        Assert.True(betaExit == 0, "Probe.Beta failed to compile:\n" + betaOutput);

        return RunGsc(
            "/out:" + appPath,
            "/target:exe",
            references: new[] { alphaLibPath, betaLibPath },
            sources: new[] { appSourcePath });
    }

    private static (int ExitCode, string Output) RunGsc(
        string outSwitch,
        string targetSwitch,
        IReadOnlyList<string> references,
        IReadOnlyList<string> sources)
    {
        var args = new List<string>
        {
            outSwitch,
            targetSwitch,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };

        foreach (string reference in ReferenceClosure.TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        foreach (string reference in references)
        {
            args.Add("/reference:" + reference);
        }

        args.AddRange(sources);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        TextWriter previousOut = Console.Out;
        TextWriter previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return (Program.Main(args.ToArray()), stdout.ToString() + stderr);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }
    }

    private static void TryDelete(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
