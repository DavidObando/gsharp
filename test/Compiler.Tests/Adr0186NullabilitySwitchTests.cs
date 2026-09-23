// <copyright file="Adr0186NullabilitySwitchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// ADR-0186: the <c>/nullability:&lt;mode&gt;</c> switch, exercised through the
/// real command line rather than by setting <c>Compilation.Nullability</c>.
/// <para>
/// The compiler-side plumbing has its own end-to-end test
/// (<c>Issue3705MemberKindNullabilityDifferentialTests.Compilation_Threads_Its_Nullability_Mode_Into_Metadata_Import</c>,
/// which asserts an oblivious imported field binds as <c>string?</c> off and
/// <c>string!</c> on). That test starts from a <c>Compilation</c> object, so
/// the <em>parser</em> arm — the `case "nullability":` in
/// <c>ParseCommandLine</c>, and the object-initializer that carries its result
/// onto the compilation — is the one link in the chain it does not touch.
/// These cases close it, following <see cref="ProgramTests"/>'s existing shape
/// of driving <see cref="Program.Main(string[])"/> and reading the exit code
/// and captured console output.
/// </para>
/// </summary>
public class Adr0186NullabilitySwitchTests
{
    /// <summary>
    /// Both spellings the parser accepts, and both valid modes.
    /// <para>
    /// <c>--nullability=platform-types</c> is the ADR's own notation and works
    /// for free — <c>ParseCommandLine</c> strips a leading second <c>-</c> and
    /// <c>IndexOfSwitchValueSeparator</c> accepts <c>=</c> as well as <c>:</c>
    /// — but "works for free" is exactly the kind of claim that stops being
    /// true without anyone noticing, so it is pinned rather than assumed.
    /// </para>
    /// </summary>
    /// <param name="argument">The switch as a user would type it.</param>
    [Theory]
    [InlineData("/nullability:enabled")]
    [InlineData("/nullability:platform-types")]
    [InlineData("/nullability:platformtypes")]
    [InlineData("--nullability=platform-types")]
    [InlineData("--nullability=enabled")]
    [InlineData("/nullability:oblivious")]
    [InlineData("--nullability=oblivious")]
    public void ValidModes_Are_Accepted(string argument)
    {
        var (exit, output, error) = RunGsc(argument);

        Assert.Equal(0, exit);
        Assert.Contains("Success", output);
        Assert.DoesNotContain("nullability", error, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// An unknown mode must be rejected by name, not silently ignored — a
    /// switch that quietly accepts a typo is a switch whose value nobody can
    /// trust, and this one selects between two different readings of every
    /// imported reference position.
    /// </summary>
    [Fact]
    public void An_Unknown_Mode_Is_Rejected_By_Name()
    {
        var (exit, _, error) = RunGsc("/nullability:bogus");

        Assert.NotEqual(0, exit);
        Assert.Contains("unknown mode 'bogus'", error);
        Assert.Contains("expected enabled, platform-types or oblivious", error);
    }

    /// <summary>
    /// An empty value is a typo too (<c>/nullability:</c> or bare
    /// <c>/nullability</c>), and must not silently select a default.
    /// </summary>
    /// <param name="argument">The malformed switch.</param>
    [Theory]
    [InlineData("/nullability")]
    [InlineData("/nullability:")]
    public void An_Empty_Mode_Is_Rejected(string argument)
    {
        var (exit, _, error) = RunGsc(argument);

        Assert.NotEqual(0, exit);
        Assert.Contains("expected enabled, platform-types or oblivious", error);
    }

    /// <summary>
    /// The switch is discoverable: <c>/help</c> lists it and names its default.
    /// </summary>
    [Fact]
    public void Help_Documents_The_Switch_And_Its_Default()
    {
        using var outWriter = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            Assert.Equal(0, Program.Main(new[] { "/?" }));
            var help = outWriter.ToString();
            Assert.Contains("/nullability:", help);

            // ADR-0186 step 3: the default moved, and `/help` has to say so.
            // This assertion is the reason the string is checked at all — a
            // help text that still names the old default is a documentation
            // bug that no other test can see.
            Assert.Contains("platform-types (default", help);
            Assert.Contains("enabled", help);

            // ADR-0186 step 5: the §9 oblivious compilation is a third value
            // of the same switch, and `/help` has to name it.
            Assert.Contains("oblivious also makes this compilation's own declarations oblivious", help);
            Assert.Contains("/platform-nil-checks:", help);
        }
        finally
        {
            Console.SetOut(previousOut);
        }
    }

    /// <summary>
    /// ADR-0186 §4's escape hatch, through the real command line.
    /// <para>
    /// Both spellings and both values. The switch selects whether a runtime
    /// nil check exists at every <c>T! → T</c> coercion, so a typo silently
    /// accepted would be a typo that silently removes every check in the
    /// build — which is why the malformed cases below are as much the point
    /// as the valid ones.
    /// </para>
    /// </summary>
    /// <param name="argument">The switch as a user would type it.</param>
    [Theory]
    [InlineData("/platform-nil-checks:on")]
    [InlineData("/platform-nil-checks:off")]
    [InlineData("/platformnilchecks:off")]
    [InlineData("--platform-nil-checks=off")]
    [InlineData("--platform-nil-checks=on")]
    public void PlatformNilChecks_ValidValues_Are_Accepted(string argument)
    {
        var (exit, output, error) = RunGsc(argument);

        Assert.Equal(0, exit);
        Assert.Contains("Success", output);
        Assert.DoesNotContain("platform-nil-checks", error, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// An unknown value is rejected by name rather than silently defaulting.
    /// </summary>
    [Fact]
    public void PlatformNilChecks_AnUnknownValue_Is_Rejected_By_Name()
    {
        var (exit, _, error) = RunGsc("/platform-nil-checks:maybe");

        Assert.NotEqual(0, exit);
        Assert.Contains("unknown value 'maybe'", error);
        Assert.Contains("expected on or off", error);
    }

    /// <summary>
    /// ADR-0186 step 3, end to end and through the <b>real command line with
    /// no switch at all</b>: the CLI's default is <c>platform-types</c>.
    /// <para>
    /// <b>Why the other cases do not cover this</b> (Copilot review on the
    /// flip PR). <see cref="ValidModes_Are_Accepted"/> passes whichever way
    /// <c>CommandLineArgs.Nullability</c> is initialised, because it always
    /// supplies the switch. <see cref="Help_Documents_The_Switch_And_Its_Default"/>
    /// asserts what the help text <em>claims</em>, which is a documentation
    /// check, not a behaviour one — and those are exactly the two that drift
    /// apart. And the differential fixtures in <c>Core.Tests</c> start from a
    /// <c>Compilation</c> object, so they exercise
    /// <c>NullabilityOptions.DefaultMode</c>, which is a <em>separate</em>
    /// default: <c>Program</c> assigns <c>CommandLineArgs.Nullability</c>
    /// unconditionally, so <c>gsc</c> never observes the ambient one. Both
    /// had to move for the flip to be complete, and this is the only case
    /// that fails if the CLI half is missed.
    /// </para>
    /// <para>
    /// The discriminator is an oblivious imported field bound into a
    /// <b>non-null</b> <c>string</c> local. Under ADR-0136's reading the
    /// position is <c>string?</c> and that is <c>GS0155</c>; under ADR-0186's
    /// it is <c>string!</c> and the conversion is implicit, carrying §4's
    /// runtime check instead of a diagnostic. The <c>/nullability:enabled</c>
    /// arm is the control: the same source, the same library, the old answer
    /// — so a green no-switch arm cannot be explained by the probe simply
    /// being wrong.
    /// </para>
    /// </summary>
    /// <param name="extraArguments">The switches to pass, if any.</param>
    /// <param name="expectSuccess">Whether the probe must compile.</param>
    [Theory]
    [InlineData(new string[0], true)]
    [InlineData(new[] { "/nullability:platform-types" }, true)]
    [InlineData(new[] { "/nullability:enabled" }, false)]
    public void TheCliDefault_Reads_AnObliviousPosition_As_APlatformType(
        string[] extraArguments,
        bool expectSuccess)
    {
        var directory = Directory.CreateTempSubdirectory("gsc_adr0186_default_").FullName;
        try
        {
            var libraryPath = EmitObliviousLibrary(directory);
            var probe = Path.Combine(directory, "probe.gs");
            File.WriteAllText(
                probe,
                """
                package P
                import Adr0186.Switch.Library

                func Main() {
                    let bound string = Ob.Field
                    Console.WriteLine(bound)
                }
                """);

            var arguments = new[] { probe, "/r:" + libraryPath }
                .Concat(extraArguments)
                .ToArray();

            var (exit, output, error) = RunGscWith(directory, arguments);

            if (expectSuccess)
            {
                Assert.Equal(0, exit);
                Assert.DoesNotContain("GS0155", output + error, StringComparison.Ordinal);
            }
            else
            {
                Assert.NotEqual(0, exit);
                Assert.Contains("GS0155", output + error, StringComparison.Ordinal);
            }
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    /// <summary>
    /// Emits a C# library with <b>no</b> nullable context at all, so every
    /// reference position in it is genuinely oblivious — the one input this
    /// fixture's discriminator needs and that the annotated BCL cannot
    /// supply.
    /// </summary>
    /// <param name="directory">Where to write the assembly.</param>
    /// <returns>The emitted assembly's path.</returns>
    private static string EmitObliviousLibrary(string directory)
    {
        const string source = """
            namespace Adr0186.Switch.Library;

            public static class Ob
            {
                public static string Field = "V";
            }
            """;

        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator) ?? Array.Empty<string>())
            .Where(path => path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            .Select(path => MetadataReference.CreateFromFile(path))
            .ToImmutableArray();

        var compilation = CSharpCompilation.Create(
            "Adr0186.Switch.Library",
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var path = Path.Combine(directory, "Adr0186.Switch.Library.dll");
        var result = compilation.Emit(path);
        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics.Select(d => d.ToString())));
        return path;
    }

    /// <summary>
    /// <see cref="RunGsc"/>'s sibling for a probe that needs its own working
    /// directory and reference set.
    /// </summary>
    /// <param name="workingDirectory">The directory gsc runs in.</param>
    /// <param name="arguments">The full argument vector.</param>
    /// <returns>The exit code and the captured stdout/stderr.</returns>
    private static (int Exit, string Output, string Error) RunGscWith(
        string workingDirectory,
        string[] arguments)
    {
        var originalCwd = Directory.GetCurrentDirectory();
        Directory.SetCurrentDirectory(workingDirectory);
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var exit = Program.Main(arguments);
            return (exit, outWriter.ToString(), errWriter.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
            Directory.SetCurrentDirectory(originalCwd);
        }
    }

    /// <summary>
    /// Compiles a trivial program with the supplied extra switch, capturing
    /// the exit code and both console streams. Mirrors
    /// <c>ProgramTests.Main_ValidSample_ReturnsSuccess</c>, including its
    /// temporary working directory (gsc writes its output relative to the
    /// current directory when no <c>/out</c> is given).
    /// </summary>
    /// <param name="argument">The switch under test.</param>
    /// <returns>The exit code and the captured stdout/stderr.</returns>
    private static (int Exit, string Output, string Error) RunGsc(string argument)
    {
        var sample = Path.Combine(Path.GetTempPath(), $"gs_adr0186_{Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n\nfunc Main() {\n}\n");
        var originalCwd = Directory.GetCurrentDirectory();
        var tempCwd = Directory.CreateTempSubdirectory("gsc_adr0186_").FullName;
        Directory.SetCurrentDirectory(tempCwd);
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var exit = Program.Main(new[] { sample, argument });
            return (exit, outWriter.ToString(), errWriter.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
            Directory.SetCurrentDirectory(originalCwd);
            try
            {
                Directory.Delete(tempCwd, recursive: true);
            }
            catch (IOException)
            {
            }

            try
            {
                File.Delete(sample);
            }
            catch (IOException)
            {
            }
        }
    }
}
