// <copyright file="Adr0186NullabilitySwitchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// ADR-0186: the `/nullability:<mode>` switch, exercised through the
/// real command line rather than by setting `Compilation.Nullability`.
///
/// The compiler-side plumbing has its own end-to-end test
/// (`Issue3705MemberKindNullabilityDifferentialTests.Compilation_Threads_Its_Nullability_Mode_Into_Metadata_Import`,
/// which asserts an oblivious imported field binds as `string?` off and
/// `string!` on). That test starts from a `Compilation` object, so
/// the <em>parser</em> arm — the `case "nullability":` in
/// `ParseCommandLine`, and the object-initializer that carries its result
/// onto the compilation — is the one link in the chain it does not touch.
/// These cases close it, following (cref:ProgramTests)'s existing shape
/// of driving (cref:Program.Main(string[])) and reading the exit code
/// and captured console output.
open class Adr0186NullabilitySwitchTests {
    /// Both spellings the parser accepts, and both valid modes.
    ///
    /// `--nullability=platform-types` is the ADR's own notation and works
    /// for free — `ParseCommandLine` strips a leading second `-` and
    /// `IndexOfSwitchValueSeparator` accepts `=` as well as `:`
    /// — but "works for free" is exactly the kind of claim that stops being
    /// true without anyone noticing, so it is pinned rather than assumed.
    /// @param argument The switch as a user would type it.
    @Theory
    @InlineData("/nullability:enabled")
    @InlineData("/nullability:platform-types")
    @InlineData("/nullability:platformtypes")
    @InlineData("--nullability=platform-types")
    @InlineData("--nullability=enabled")
    @InlineData("/nullability:oblivious")
    @InlineData("--nullability=oblivious")
    func ValidModes_Are_Accepted(argument string) {
        let (exit, output, error) = RunGsc(argument)
        Assert.Equal(0, exit)
        Assert.Contains("Success", output)
        Assert.DoesNotContain("nullability", error, StringComparison.OrdinalIgnoreCase)
    }

    /// An unknown mode must be rejected by name, not silently ignored — a
    /// switch that quietly accepts a typo is a switch whose value nobody can
    /// trust, and this one selects between two different readings of every
    /// imported reference position.
    @Fact
    func An_Unknown_Mode_Is_Rejected_By_Name() {
        let (exit, _, error) = RunGsc("/nullability:bogus")
        Assert.NotEqual(0, exit)
        Assert.Contains("unknown mode 'bogus'", error)
        Assert.Contains("expected enabled, platform-types or oblivious", error)
    }

    /// An empty value is a typo too (`/nullability:` or bare
    /// `/nullability`), and must not silently select a default.
    /// @param argument The malformed switch.
    @Theory
    @InlineData("/nullability")
    @InlineData("/nullability:")
    func An_Empty_Mode_Is_Rejected(argument string) {
        let (exit, _, error) = RunGsc(argument)
        Assert.NotEqual(0, exit)
        Assert.Contains("expected enabled, platform-types or oblivious", error)
    }

    /// The switch is discoverable: `/help` lists it and names its default.
    @Fact
    func Help_Documents_The_Switch_And_Its_Default() {
        using let outWriter = StringWriter()
        let previousOut = Console.Out
        Console.SetOut(outWriter)
        try {
            Assert.Equal(0, Program.Main([]string{"/?"}))
            let help = outWriter.ToString()
            Assert.Contains("/nullability:", help)
            // ADR-0186 step 3: the default moved, and `/help` has to say so.
            // This assertion is the reason the string is checked at all — a
            // help text that still names the old default is a documentation
            // bug that no other test can see.
            Assert.Contains("platform-types (default", help)
            Assert.Contains("enabled", help)
            // ADR-0186 step 5: the §9 oblivious compilation is a third value
            // of the same switch, and `/help` has to name it.
            Assert.Contains("oblivious also makes this compilation's own declarations oblivious", help)
            Assert.Contains("/platform-nil-checks:", help)
        } finally {
            Console.SetOut(previousOut)
        }
    }

    /// ADR-0186 §4's escape hatch, through the real command line.
    ///
    /// Both spellings and both values. The switch selects whether a runtime
    /// nil check exists at every `T! → T` coercion, so a typo silently
    /// accepted would be a typo that silently removes every check in the
    /// build — which is why the malformed cases below are as much the point
    /// as the valid ones.
    /// @param argument The switch as a user would type it.
    @Theory
    @InlineData("/platform-nil-checks:on")
    @InlineData("/platform-nil-checks:off")
    @InlineData("/platformnilchecks:off")
    @InlineData("--platform-nil-checks=off")
    @InlineData("--platform-nil-checks=on")
    func PlatformNilChecks_ValidValues_Are_Accepted(argument string) {
        let (exit, output, error) = RunGsc(argument)
        Assert.Equal(0, exit)
        Assert.Contains("Success", output)
        Assert.DoesNotContain("platform-nil-checks", error, StringComparison.OrdinalIgnoreCase)
    }

    /// An unknown value is rejected by name rather than silently defaulting.
    @Fact
    func PlatformNilChecks_AnUnknownValue_Is_Rejected_By_Name() {
        let (exit, _, error) = RunGsc("/platform-nil-checks:maybe")
        Assert.NotEqual(0, exit)
        Assert.Contains("unknown value 'maybe'", error)
        Assert.Contains("expected on or off", error)
    }

    /// ADR-0186 step 3, end to end and through the <b>real command line with
    /// no switch at all</b>: the CLI's default is `platform-types`.
    ///
    /// <b>Why the other cases do not cover this</b> (Copilot review on the
    /// flip PR). (cref:ValidModes_Are_Accepted) passes whichever way
    /// `CommandLineArgs.Nullability` is initialised, because it always
    /// supplies the switch. (cref:Help_Documents_The_Switch_And_Its_Default)
    /// asserts what the help text <em>claims</em>, which is a documentation
    /// check, not a behaviour one — and those are exactly the two that drift
    /// apart. And the differential fixtures in `Core.Tests` start from a
    /// `Compilation` object, so they exercise
    /// `NullabilityOptions.DefaultMode`, which is a <em>separate</em>
    /// default: `Program` assigns `CommandLineArgs.Nullability`
    /// unconditionally, so `gsc` never observes the ambient one. Both
    /// had to move for the flip to be complete, and this is the only case
    /// that fails if the CLI half is missed.
    ///
    /// The discriminator is an oblivious imported field bound into a
    /// <b>non-null</b> `string` local. Under ADR-0136's reading the
    /// position is `string?` and that is `GS0155`; under ADR-0186's
    /// it is `string!` and the conversion is implicit, carrying §4's
    /// runtime check instead of a diagnostic. The `/nullability:enabled`
    /// arm is the control: the same source, the same library, the old answer
    /// — so a green no-switch arm cannot be explained by the probe simply
    /// being wrong.
    /// @param extraArguments The switches to pass, if any.
    /// @param expectSuccess Whether the probe must compile.
    @Theory
    @InlineData([0]string, true)
    @InlineData([]string{"/nullability:platform-types"}, true)
    @InlineData([]string{"/nullability:enabled"}, false)
    func TheCliDefault_Reads_AnObliviousPosition_As_APlatformType(extraArguments[]string, expectSuccess bool) {
        let directory = Directory.CreateTempSubdirectory("gsc_adr0186_default_").FullName
        try {
            let libraryPath = EmitObliviousLibrary(directory)
            let probe = Path.Combine(directory, "probe.gs")
            File.WriteAllText(probe, `package P
import Adr0186.Switch.Library

func Main() {
    let bound string = Ob.Field
    Console.WriteLine(bound)
}`)
            let arguments = []string{probe, "/r:" + libraryPath}.Concat(extraArguments).ToArray()
            let (exit, output, error) = RunGscWith(directory, arguments)
            if expectSuccess {
                Assert.Equal(0, exit)
                Assert.DoesNotContain("GS0155", output + error, StringComparison.Ordinal)
            } else {
                Assert.NotEqual(0, exit)
                Assert.Contains("GS0155", output + error, StringComparison.Ordinal)
            }
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch (IOException) { }
        }
    }

    shared {
        /// Emits a C# library with <b>no</b> nullable context at all, so every
        /// reference position in it is genuinely oblivious — the one input this
        /// fixture's discriminator needs and that the annotated BCL cannot
        /// supply.
        /// @param directory Where to write the assembly.
        /// @returns The emitted assembly's path.
        private func EmitObliviousLibrary(directory string) string {
            const source = `namespace Adr0186.Switch.Library;

public static class Ob
{
    public static string Field = "V";
}`
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where((path string) -> path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                .Select((path string) -> MetadataReference.CreateFromFile(path))
                .ToImmutableArray()
            let compilation = CSharpCompilation.Create(
                "Adr0186.Switch.Library",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let path = Path.Combine(directory, "Adr0186.Switch.Library.dll")
            let result = compilation.Emit(path)
            Assert.True(
                result.Success,
                string.Join(Environment.NewLine, result.Diagnostics.Select((d Diagnostic) -> d.ToString()))
            )
            return path
        }

        /// (cref:RunGsc)'s sibling for a probe that needs its own working
        /// directory and reference set.
        /// @param workingDirectory The directory gsc runs in.
        /// @param arguments The full argument vector.
        /// @returns The exit code and the captured stdout/stderr.
        private func RunGscWith(workingDirectory string, arguments[]string)(Exit int32, Output string, Error string) {
            let originalCwd = Directory.GetCurrentDirectory()
            Directory.SetCurrentDirectory(workingDirectory)
            using let outWriter = StringWriter()
            using let errWriter = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(outWriter)
            Console.SetError(errWriter)
            try {
                let exit = Program.Main(arguments)
                return (exit, outWriter.ToString(), errWriter.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
                Directory.SetCurrentDirectory(originalCwd)
            }
        }

        /// Compiles a trivial program with the supplied extra switch, capturing
        /// the exit code and both console streams. Mirrors
        /// `ProgramTests.Main_ValidSample_ReturnsSuccess`, including its
        /// temporary working directory (gsc writes its output relative to the
        /// current directory when no `/out` is given).
        /// @param argument The switch under test.
        /// @returns The exit code and the captured stdout/stderr.
        private func RunGsc(argument string)(Exit int32, Output string, Error string) {
            let sample = Path.Combine(Path.GetTempPath(), "gs_adr0186_${Guid.NewGuid():N}.gs")
            File.WriteAllText(sample, `package P

func Main() {
}
`)
            let originalCwd = Directory.GetCurrentDirectory()
            let tempCwd = Directory.CreateTempSubdirectory("gsc_adr0186_").FullName
            Directory.SetCurrentDirectory(tempCwd)
            using let outWriter = StringWriter()
            using let errWriter = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(outWriter)
            Console.SetError(errWriter)
            try {
                let exit = Program.Main([]string{sample, argument})
                return (exit, outWriter.ToString(), errWriter.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
                Directory.SetCurrentDirectory(originalCwd)
                try {
                    Directory.Delete(tempCwd, recursive: true)
                } catch (IOException) { }
                try {
                    File.Delete(sample)
                } catch (IOException) { }
            }
        }
    }
}
