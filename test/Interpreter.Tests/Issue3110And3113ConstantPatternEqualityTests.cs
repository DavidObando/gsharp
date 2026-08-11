// <copyright file="Issue3110And3113ConstantPatternEqualityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>Issues #3110 and #3113: constant-pattern equality must agree across all three drivers.</summary>
[Collection("ConsoleIo")]
public class Issue3110And3113ConstantPatternEqualityTests
{
    [Fact]
    public async Task TwentyRowCorpus_AgreesAcrossDrivers()
    {
        const string Expected = """
            11
            11
            11
            11
            11
            11
            11
            11
            11
            11
            11
            11
            11
            11
            11
            11
            11
            11
            11
            11
            """;
        await AssertDriverMatrixAsync(SourceForTwentyRowCorpus(), Expected, nameof(TwentyRowCorpus_AgreesAcrossDrivers));
    }

    [Fact]
    public async Task FloatingAndNullableWidthControls_AgreeAcrossDrivers()
    {
        const string Expected = """
            33
            33
            11
            11
            11
            11
            11
            11
            11
            11
            11
            33
            33
            33
            33
            11
            11
            11
            """;
        await AssertDriverMatrixAsync(SourceForFloatingAndNullableWidthControls(), Expected, nameof(FloatingAndNullableWidthControls_AgreeAcrossDrivers));
    }

    [Fact]
    public async Task NonLiteralNaNConstants_AgreeAcrossDrivers()
    {
        const string Expected = """
            33
            33
            33
            33
            33
            11
            """;
        await AssertDriverMatrixAsync(SourceForNonLiteralNaNConstants(), Expected, nameof(NonLiteralNaNConstants_AgreeAcrossDrivers));
    }

    private static async Task AssertDriverMatrixAsync(string source, string expected, string testName)
    {
        var root = CreateEmptyDirectory(testName);
        try
        {
            var bare = RunBareGsc(source, CreateEmptyDirectory(root, "bare"));
            var emitted = await RunEmittedAsync(source, CreateEmptyDirectory(root, "emit"));
            var gsi = RunGsi(source, CreateEmptyDirectory(root, "gsi"));

            Assert.True(
                expected == bare && expected == emitted && expected == gsi,
                $"driver mismatch\nexpected:\n{expected}\nbare gsc:\n{bare}\nemitted:\n{emitted}\ngsi:\n{gsi}");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static string RunBareGsc(string source, string directory)
    {
        var sourcePath = Path.Combine(directory, "probe.gs");
        File.WriteAllText(sourcePath, source);
        var (exitCode, stdout, stderr) = CaptureConsole(
            () => GSharp.Compiler.Program.Main([sourcePath]));

        Assert.True(exitCode == 0, $"bare gsc failed ({exitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return NormalizeValues(stdout);
    }

    private static string RunGsi(string source, string directory)
    {
        var sourcePath = Path.Combine(directory, "probe.gs");
        File.WriteAllText(sourcePath, source);
        var (exitCode, stdout, stderr) = CaptureConsole(
            () => GSharp.Repl.Program.Main([sourcePath]));

        Assert.True(exitCode == 0, $"gsi failed ({exitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return NormalizeValues(stdout);
    }

    private static async Task<string> RunEmittedAsync(string source, string directory)
    {
        var sourcePath = Path.Combine(directory, "probe.gs");
        var outputPath = Path.Combine(directory, $"Issue3110And3113{Guid.NewGuid():N}.dll");
        File.WriteAllText(sourcePath, source);

        var (compileExit, stdout, stderr) = CaptureConsole(
            () => GSharp.Compiler.Program.Main(
                ["/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath]));
        Assert.True(compileExit == 0, $"emit failed ({compileExit})\nstdout:\n{stdout}\nstderr:\n{stderr}");

        CollectibleAssembly.Inspect(outputPath, assembly => Assert.NotEmpty(assembly.GetTypes()));

        var result = await DotnetProcess.RunAsync(directory, [outputPath]);
        Assert.True(
            result.ExitCode == 0,
            $"emitted program failed ({result.ExitCode})\nstdout:\n{result.StandardOutput}\nstderr:\n{result.StandardError}");
        return NormalizeValues(result.StandardOutput);
    }

    private static (int ExitCode, string Stdout, string Stderr) CaptureConsole(Func<int> action)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return (action(), stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string NormalizeValues(string output) =>
        string.Join(
            "\n",
            output.ReplaceLineEndings(Environment.NewLine)
                .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
                .Where(line => line != "Success."));

    private static string CreateEmptyDirectory(string name)
    {
        var parent = Path.Combine(AppContext.BaseDirectory, "issue3110-3113-probes");
        return CreateEmptyDirectory(parent, $"{name}-{Guid.NewGuid():N}");
    }

    private static string CreateEmptyDirectory(string parent, string name)
    {
        var path = Path.Combine(parent, name);
        Directory.CreateDirectory(path);
        Assert.Empty(Directory.EnumerateFileSystemEntries(path));
        return path;
    }

    private static string SourceForTwentyRowCorpus() => """
        package Issue3110And3113.Corpus
        import System

        enum Shade { Light, Dark }

        var i32 int32 = 1
        switch i32 { case 1 { Console.WriteLine(11) } case 2 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var i64 int64 = int64(2)
        switch i64 { case 2 { Console.WriteLine(11) } case 3 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var u32 uint32 = uint32(3)
        switch u32 { case 3 { Console.WriteLine(11) } case 4 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var u64 uint64 = uint64(4)
        switch u64 { case 4 { Console.WriteLine(11) } case 5 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var dec decimal = 1.5m
        switch dec { case 1.5m { Console.WriteLine(11) } case 2.5m { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var text string = "s"
        switch text { case "s" { Console.WriteLine(11) } case "t" { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var empty string = ""
        switch empty { case "" { Console.WriteLine(11) } case "x" { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nilText string? = nil
        switch nilText { case nil { Console.WriteLine(11) } case "x" { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var truth bool = true
        switch truth { case true { Console.WriteLine(11) } case false { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var letter char = 'x'
        switch letter { case 'x' { Console.WriteLine(11) } case 'y' { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var shade Shade = Shade.Dark
        switch shade { case Shade.Dark { Console.WriteLine(11) } case Shade.Light { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var boxedInt object = 1
        switch boxedInt { case 1 { Console.WriteLine(11) } case 2 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var boxedBool object = true
        switch boxedBool { case true { Console.WriteLine(11) } case false { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var boxedString object = "s"
        switch boxedString { case "s" { Console.WriteLine(11) } case "t" { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nullableInt32 int32? = 1
        switch nullableInt32 { case 1 { Console.WriteLine(11) } case 2 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nullableChar char? = 'x'
        switch nullableChar { case 'x' { Console.WriteLine(11) } case 'y' { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nullableBool bool? = true
        switch nullableBool { case true { Console.WriteLine(11) } case false { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nullableInt64 int64? = int64(3)
        switch nullableInt64 { case 3 { Console.WriteLine(11) } case 4 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nullableFloat64 float64? = 1.5
        switch nullableFloat64 { case 1.5 { Console.WriteLine(11) } case 2.5 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nilFloat64 float64? = nil
        switch nilFloat64 { case nil { Console.WriteLine(11) } case 1.5 { Console.WriteLine(22) } default { Console.WriteLine(33) } }
        """;

    private static string SourceForFloatingAndNullableWidthControls() => """
        package Issue3110And3113.Controls
        import System

        enum ControlShade { Light, Dark }

        var nan32 float32 = Single.NaN
        switch nan32 { case Single.NaN { Console.WriteLine(11) } case Single.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nan64 float64 = Double.NaN
        switch nan64 { case Double.NaN { Console.WriteLine(11) } case Double.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var negativeZero float64 = -0.0
        switch negativeZero { case 0.0 { Console.WriteLine(11) } case 1.0 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var epsilon32 float32 = Single.Epsilon
        switch epsilon32 { case Single.Epsilon { Console.WriteLine(11) } case Single.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var positiveInfinity float64 = Double.PositiveInfinity
        switch positiveInfinity { case Double.PositiveInfinity { Console.WriteLine(11) } case Double.NegativeInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var negativeInfinity float64 = Double.NegativeInfinity
        switch negativeInfinity { case Double.NegativeInfinity { Console.WriteLine(11) } case Double.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nullableInt8 int8? = int8(1)
        switch nullableInt8 { case 1 { Console.WriteLine(11) } case 2 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nullableInt16 int16? = int16(1)
        switch nullableInt16 { case 1 { Console.WriteLine(11) } case 2 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nullableUInt32 uint32? = uint32(1)
        switch nullableUInt32 { case 1 { Console.WriteLine(11) } case 2 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nullableUInt64 uint64? = uint64(1)
        switch nullableUInt64 { case 1 { Console.WriteLine(11) } case 2 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nullableFloat32 float32? = Single.Epsilon
        switch nullableFloat32 { case Single.Epsilon { Console.WriteLine(11) } case Single.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nullableNaN32 float32? = Single.NaN
        switch nullableNaN32 { case Single.NaN { Console.WriteLine(11) } case Single.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var nullableNaN64 float64? = Double.NaN
        switch nullableNaN64 { case Double.NaN { Console.WriteLine(11) } case Double.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var boxedNaN32 object = Single.NaN
        switch boxedNaN32 { case Single.NaN { Console.WriteLine(11) } case Single.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var boxedNaN64 object = Double.NaN
        switch boxedNaN64 { case Double.NaN { Console.WriteLine(11) } case Double.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var boxedDecimal object = 1.5m
        switch boxedDecimal { case 1.5m { Console.WriteLine(11) } case 2.5m { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var boxedChar object = 'x'
        switch boxedChar { case 'x' { Console.WriteLine(11) } case 'y' { Console.WriteLine(22) } default { Console.WriteLine(33) } }

        var boxedEnum object = ControlShade.Dark
        switch boxedEnum { case ControlShade.Dark { Console.WriteLine(11) } case ControlShade.Light { Console.WriteLine(22) } default { Console.WriteLine(33) } }
        """;

    private static string SourceForNonLiteralNaNConstants() => """
        package Issue3110And3113.NonLiteralNaN
        import System

        var divided object = Double.NaN
        switch divided { case 0.0 / 0.0 { Console.WriteLine(11) } default { Console.WriteLine(33) } }

        var multiplied object = Double.NaN
        switch multiplied { case Double.NaN * 1.0 { Console.WriteLine(11) } default { Console.WriteLine(33) } }

        var negated object = Double.NaN
        switch negated { case -Double.NaN { Console.WriteLine(11) } default { Console.WriteLine(33) } }

        var nullable float64? = Double.NaN
        switch nullable { case 0.0 / 0.0 { Console.WriteLine(11) } default { Console.WriteLine(33) } }

        var chainedNaN object = float64(float32(Single.NaN))
        switch chainedNaN { case (float64(float32(Single.NaN))) { Console.WriteLine(11) } default { Console.WriteLine(33) } }

        var chainedControl object = float64(float32(1.00000001))
        switch chainedControl { case (float64(float32(1.00000001))) { Console.WriteLine(11) } default { Console.WriteLine(33) } }
        """;
}
