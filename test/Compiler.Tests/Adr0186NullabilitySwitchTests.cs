// <copyright file="Adr0186NullabilitySwitchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
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
        Assert.Contains("expected enabled or platform-types", error);
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
        Assert.Contains("expected enabled or platform-types", error);
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
