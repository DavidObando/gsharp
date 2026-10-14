// <copyright file="Issue3734ImportedHomonymAmbiguityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3734: two referenced assemblies export a same-named type whose
/// members are COMPATIBLE, so on `main` the first-import-wins mis-binding
/// compiled cleanly and ran against the type the author never named — the
/// silent-wrong-code shape. The bare reference is now GS0547, an error, and
/// the two escape hatches G# already has (the qualified spelling and
/// `import Alias = Namespace.Type`) both pin the intended type.
///
/// The same-type cases are the anti-vacuity guard: a check that fired on every
/// name reachable through two imports would be useless, so a name reached
/// twice through the SAME type, and a name only one import can resolve, must
/// stay silent.
open class Issue3734ImportedHomonymAmbiguityTests {
    @Fact
    func DifferentTypes_BareName_IsRejectedAndNamesBothCandidates() {
        // On main this compiled to exit 0 and printed "alpha".
        let (exitCode, output, _) = CompileAndRun(`package Probe.App

import System
import Probe.Alpha
import Probe.Beta

Console.WriteLine(Thing.Name())`)
        Assert.True(exitCode != 0, "expected gsc to reject the bare homonym:\n" + output)
        Assert.Contains("GS0547", output, StringComparison.Ordinal)
        Assert.Contains("Probe.Alpha.Thing", output, StringComparison.Ordinal)
        Assert.Contains("Probe.Beta.Thing", output, StringComparison.Ordinal)
        // The message names the candidate first-import-wins WOULD have picked;
        // this file's import order made it Alpha.
        Assert.Contains("would bind 'Probe.Alpha.Thing'", output, StringComparison.Ordinal)
    }

    @Fact
    func DifferentTypes_ImportOrderReversed_ReportsTheOtherCandidateAsTheWinner() {
        // The point of the diagnostic: nothing in the reference changed, only
        // the order of two lines the author is unlikely to read as semantic —
        // and the silent answer flipped with it.
        let (exitCode, output, _) = CompileAndRun(`package Probe.App

import System
import Probe.Beta
import Probe.Alpha

Console.WriteLine(Thing.Name())`)
        Assert.True(exitCode != 0, "expected gsc to reject the bare homonym:\n" + output)
        Assert.Contains("GS0547", output, StringComparison.Ordinal)
        Assert.Contains("would bind 'Probe.Beta.Thing'", output, StringComparison.Ordinal)
    }

    @Fact
    func DifferentTypes_TypeClausePosition_ReportsAmbiguity() {
        // The #3725 shape: the collision is in a declared type, not a receiver.
        let (exitCode, output, _) = CompileAndRun(`package Probe.App

import System
import Probe.Alpha
import Probe.Beta

func Describe(t Thing) string { return "seen" }

Console.WriteLine(Describe(Probe.Alpha.Thing()))`)
        Assert.True(exitCode != 0, "expected gsc to reject the bare homonym:\n" + output)
        Assert.Contains("GS0547", output, StringComparison.Ordinal)
    }

    @Fact
    func DifferentTypes_ConstructionPosition_ReportsAmbiguity() {
        // `Thing()` constructs whichever homonym the import order picked, which
        // is the shape most likely to compile and behave wrongly.
        let (exitCode, output, _) = CompileAndRun(`package Probe.App

import System
import Probe.Alpha
import Probe.Beta

let t = Thing()
Console.WriteLine("built")`)
        Assert.True(exitCode != 0, "expected gsc to reject the bare homonym:\n" + output)
        Assert.Contains("GS0547", output, StringComparison.Ordinal)
    }

    @Fact
    func ConstructionPosition_ImportTypeAlias_IsTheEscapeHatch() {
        // A package-qualified CONSTRUCTION of an imported CLR type is not a
        // spelling gsc accepts (`Probe.Beta.Thing()` is GS0157), so the alias
        // import is the escape hatch that has to work here.
        let (exitCode, output, stdout) = CompileAndRun(`package Probe.App

import System
import Probe.Alpha
import Probe.Beta
import BetaThing = Probe.Beta.Thing

Console.WriteLine(BetaThing.Name())`)
        Assert.Equal(0, exitCode)
        Assert.DoesNotContain("GS0547", output, StringComparison.Ordinal)
        Assert.Equal("beta" + Environment.NewLine, stdout)
    }

    @Fact
    func SameName_OnlyOneImportResolvesIt_StaysSilent() {
        // Anti-vacuity: both packages are imported, but only one exports this
        // name, so there is no choice to report.
        let (exitCode, output, stdout) = CompileAndRun(`package Probe.App

import System
import Probe.Alpha
import Probe.Beta

Console.WriteLine(OnlyAlpha.Name())`)
        Assert.Equal(0, exitCode)
        Assert.DoesNotContain("GS0547", output, StringComparison.Ordinal)
        Assert.Equal("only-alpha" + Environment.NewLine, stdout)
    }

    @Fact
    func SameType_ReachedThroughTheImplicitAndTheExplicitImport_StaysSilent() {
        // Anti-vacuity: `System` is imported twice (once by the compiler, once
        // by the author) and `Console` resolves to the SAME type both times —
        // the choice does not matter, so there is nothing to report.
        let (exitCode, output, stdout) = CompileAndRun(`package Probe.App

import System
import Probe.Alpha
import Probe.Beta

Console.WriteLine("same")`)
        Assert.Equal(0, exitCode)
        Assert.DoesNotContain("GS0547", output, StringComparison.Ordinal)
        Assert.Equal("same" + Environment.NewLine, stdout)
    }

    @Fact
    func QualifiedSpelling_SilencesTheAmbiguityAndPinsTheType() {
        let (exitCode, output, stdout) = CompileAndRun(`package Probe.App

import System
import Probe.Alpha
import Probe.Beta

Console.WriteLine(Probe.Beta.Thing.Name())`)
        Assert.Equal(0, exitCode)
        Assert.DoesNotContain("GS0547", output, StringComparison.Ordinal)
        Assert.Equal("beta" + Environment.NewLine, stdout)
    }

    @Fact
    func ImportTypeAlias_SilencesTheAmbiguityAndPinsTheType() {
        // The escape hatch G# already has (issue #2273), and the one cs2gs
        // already knows how to emit.
        let (exitCode, output, stdout) = CompileAndRun(`package Probe.App

import System
import Probe.Alpha
import Probe.Beta
import Thing = Probe.Beta.Thing

Console.WriteLine(Thing.Name())`)
        Assert.Equal(0, exitCode)
        Assert.DoesNotContain("GS0547", output, StringComparison.Ordinal)
        Assert.Equal("beta" + Environment.NewLine, stdout)
    }

    @Fact
    func AnImplicitImport_LosesToAWrittenOne_AndMakesNothingAmbiguous() {
        // ADR-0174 added `Gsharp.Concurrency` to the implicit import set, and it
        // exports `Context` — an ordinary name for a user type (an EF DbContext,
        // an HTTP context, a parser context). A namespace the author never asked
        // for must neither shadow the one they wrote nor collide with it: it is
        // a fallback, consulted only when no written import resolves the name.
        //
        // The regression this pins is a silent-wrong-code shape when the two
        // types happen to be compatible, and GS0547 when they are not; before
        // the fix the translated `test/NullableIncludeInference` corpus app
        // stopped compiling on exactly this.
        let (exitCode, output, stdout) = CompileAndRun(`package Probe.App

import System
import Probe.Alpha

class Context {
    shared {
        func Name() string { return "user-context" }
    }
}

Console.WriteLine(Context.Name())`)
        Assert.Equal(0, exitCode)
        Assert.DoesNotContain("GS0547", output, StringComparison.Ordinal)
        Assert.Equal("user-context" + Environment.NewLine, stdout)
    }

    @Fact
    func AnImplicitImport_StillSuppliesANameNobodyElseDoes() {
        // The other half: the fallback has to still work, or `Context` would be
        // unreachable without an explicit `import Gsharp.Concurrency`.
        let (exitCode, output, stdout) = CompileAndRun(`package Probe.App

import System

func describe(ctx Context) string {
    return ctx.IsCancelled ? "cancelled" : "live"
}

Console.WriteLine(describe(Context.None))`)
        Assert.Equal(0, exitCode)
        Assert.DoesNotContain("GS0547", output, StringComparison.Ordinal)
        Assert.Equal("live" + Environment.NewLine, stdout)
    }

    shared {
        private const AlphaLibrary string = `package Probe.Alpha

class Thing {
    shared {
        func Name() string { return "alpha" }
    }
}

class OnlyAlpha {
    shared {
        func Name() string { return "only-alpha" }
    }
}`

        private const BetaLibrary string = `package Probe.Beta

class Thing {
    shared {
        func Name() string { return "beta" }
    }
}`

        private func CompileAndRun(appSource string)(ExitCode int32, Output string, Stdout string) {
            let (exitCode, output) = Build(appSource, out var workDir, out var appPath)
            try {
                if exitCode != 0 {
                    return (exitCode, output, string.Empty)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = workDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(appPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(appPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(60_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return (exitCode, output, stdout.ReplaceLineEndings(Environment.NewLine))
            } finally {
                TryDelete(workDir)
            }
        }

        private func Build(appSource string, out workDir string, out appPath string)(ExitCode int32, Output string) {
            // Two SEPARATE assemblies: the homonyms must come from referenced
            // metadata, never from the app's own compilation (which the source-type
            // collision rule, GS0496, already covers).
            workDir = Directory.CreateTempSubdirectory("gs_issue3734_").FullName
            let alphaLibPath = Path.Combine(workDir, "Probe.Alpha.dll")
            let betaLibPath = Path.Combine(workDir, "Probe.Beta.dll")
            appPath = Path.Combine(workDir, "Probe.App.dll")
            let alphaPath = Path.Combine(workDir, "Alpha.gs")
            let betaPath = Path.Combine(workDir, "Beta.gs")
            let appSourcePath = Path.Combine(workDir, "App.gs")
            File.WriteAllText(alphaPath, AlphaLibrary)
            File.WriteAllText(betaPath, BetaLibrary)
            File.WriteAllText(appSourcePath, appSource)
            let (alphaExit, alphaOutput) = RunGsc(
                "/out:" + alphaLibPath,
                "/target:library",
                references: Array.Empty[string](),
                sources: []string{alphaPath}
            )
            Assert.True(alphaExit == 0, "Probe.Alpha failed to compile:\n" + alphaOutput)
            let (betaExit, betaOutput) = RunGsc(
                "/out:" + betaLibPath,
                "/target:library",
                references: Array.Empty[string](),
                sources: []string{betaPath}
            )
            Assert.True(betaExit == 0, "Probe.Beta failed to compile:\n" + betaOutput)
            return RunGsc(
                "/out:" + appPath,
                "/target:exe",
                references: []string{alphaLibPath, betaLibPath},
                sources: []string{appSourcePath}
            )
        }

        private func RunGsc(
            outSwitch string,
            targetSwitch string,
            references IReadOnlyList[string],
            sources IReadOnlyList[string]
        )(ExitCode int32, Output string) {
            let args = List[string]{outSwitch, targetSwitch, "/targetframework:net10.0", "/nowarn:GS9100"}
            for reference in ReferenceClosure.TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            for reference in references {
                args.Add("/reference:" + reference)
            }
            args.AddRange(sources)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                return (Program.Main(args.ToArray()), stdout.ToString() + stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
        }

        private func TryDelete(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
