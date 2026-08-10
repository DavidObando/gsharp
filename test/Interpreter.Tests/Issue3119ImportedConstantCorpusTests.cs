// <copyright file="Issue3119ImportedConstantCorpusTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>Issue #3119: imported constants preserve type and value across every driver.</summary>
[Collection("ConsoleIo")]
public class Issue3119ImportedConstantCorpusTests
{
    public static TheoryData<string> CrossEvaluationCases => new()
    {
        "Constants.Empty == \"\"",
        "Constants.Escaped == \"A\\n\\\"B\\\"\\\\C\"",
        "Constants.Character == 'Q'",
        "Constants.Boolean",
        "int32(Constants.TopLevelEnumValue) == 406",
        "int32(Constants.NestedEnumValue) == 407",
        "GenericOuter[int32].Depth2.Value == 408",
        "GenericOuter[int32].Depth2.Depth3.Value == \"depth3-409\"",
        "Constants.NullableConst == \"nullable-const-414\"",
        "Constants.PositiveControl == 499",
    };

    public static TheoryData<string, string> CrossEmissionCases => new()
    {
        { "Constants.Empty", "\n" },
        { "Constants.Escaped", "A\n\"B\"\\C\n" },
        { "Constants.Character", "Q\n" },
        { "Constants.Boolean", "True\n" },
        { "Constants.Decimal.ToString(CultureInfo.InvariantCulture)", "405.5\n" },
        { "Constants.EnabledText", "enabled-text-410\n" },
        { "Constants.EnabledInt", "411\n" },
        { "Constants.DisabledText", "disabled-text-412\n" },
        { "Constants.DisabledInt", "413\n" },
        { "int32(Constants.TopLevelEnumValue)", "406\n" },
        { "int32(Constants.NestedEnumValue)", "407\n" },
        { "GenericOuter[int32].Depth2.Value", "408\n" },
        { "GenericOuter[int32].Depth2.Depth3.Value", "depth3-409\n" },
        { "Constants.NullableConst", "nullable-const-414\n" },
        { "Constants.PositiveControl", "499\n" },
    };

    public static TheoryData<string, string> NullableNarrowingCases => new()
    {
        { "bare-gsc", "EnabledText" },
        { "gsc-emit", "EnabledText" },
        { "bare-gsc", "DisabledText" },
        { "gsc-emit", "DisabledText" },
        { "bare-gsc", "NullableConst" },
        { "gsc-emit", "NullableConst" },
    };

    public static TheoryData<string> NoReferenceDrivers => new()
    {
        "bare-gsc",
        "gsc-emit",
        "gsi",
    };

    public static TheoryData<string> RuntimeDrivers => new()
    {
        "bare-gsc",
        "gsc-emit",
        "gsi",
    };

    [Theory]
    [MemberData(nameof(CrossEvaluationCases))]
    public void CrossAssemblyImportedConstant_EvaluatesWithExactValue(string condition)
    {
        var root = CreateEmptyTestDirectory();
        try
        {
            var sourcePath = WriteSource(
                root,
                "evaluate.gs",
                CreateAssertionSource(condition));
            var result = RunCompiler(
                root,
                "/nowarn:GS9100",
                "/r:" + GetCrossFixturePath(),
                sourcePath);

            AssertSucceeded(result, "cross-assembly gsc evaluation");
            Assert.Equal(string.Empty, ProgramOutput(result));
        }
        finally
        {
            DeleteDirectory(root);
        }
    }

    [Theory]
    [MemberData(nameof(CrossEmissionCases))]
    public void CrossAssemblyImportedConstant_EmitsWithExactValue(
        string expression,
        string expectedOutput)
    {
        var root = CreateEmptyTestDirectory();
        try
        {
            var fixturePath = GetCrossFixturePath();
            var sourcePath = WriteSource(
                root,
                "emit.gs",
                CreateValueSource("GSharp.Issue3119.Cross", expression));
            var assemblyPath = Path.Combine(root, "cross-constant.dll");
            var result = RunCompiler(
                root,
                "/target:exe",
                "/nowarn:GS9100",
                "/out:" + assemblyPath,
                "/r:" + fixturePath,
                sourcePath);

            AssertSucceeded(result, "cross-assembly gsc emit");
            CopyRuntimeDependency(fixturePath, root);
            Assert.Equal(
                expectedOutput.Replace("\n", Environment.NewLine, StringComparison.Ordinal),
                RunAssembly(root, assemblyPath));
        }
        finally
        {
            DeleteDirectory(root);
        }
    }

    [Theory]
    [MemberData(nameof(NullableNarrowingCases))]
    public void NullableImportedField_CannotNarrowToString(
        string driver,
        string fieldName)
    {
        var root = CreateEmptyTestDirectory();
        try
        {
            var sourcePath = WriteSource(
                root,
                "narrow.gs",
                CreateNarrowingSource(fieldName));
            var arguments = driver == "gsc-emit"
                ? new[]
                {
                    "/target:exe",
                    "/out:" + Path.Combine(root, "narrow.dll"),
                    "/r:" + GetCrossFixturePath(),
                    sourcePath,
                }
                : new[]
                {
                    "/r:" + GetCrossFixturePath(),
                    sourcePath,
                };
            var result = RunCompiler(root, arguments);

            // Issue #3246: `string? -> string` used to classify as an
            // existing-but-explicit conversion (GS0156) only because the
            // retired builtin to-string arm accepted it; with that arm gone
            // the reference-nullable narrowing reports the standard GS0155,
            // matching every other reference type's `S? -> S` per #1627
            // (the caller must write `!!`).
            Assert.Equal(1, result.ExitCode);
            Assert.Contains("GS0155", result.Combined, StringComparison.Ordinal);
            Assert.Contains("'string?' to 'string'", result.Combined, StringComparison.Ordinal);
        }
        finally
        {
            DeleteDirectory(root);
        }
    }

    [Theory]
    [MemberData(nameof(NoReferenceDrivers))]
    public void CrossAssemblyFixture_IsUnavailableWithoutReference(string driver)
    {
        var root = CreateEmptyTestDirectory();
        try
        {
            var sourcePath = WriteSource(
                root,
                "no-reference.gs",
                CreateValueSource(
                    "GSharp.Issue3119.Cross",
                    "Constants.PositiveControl"));
            var result = driver switch
            {
                "bare-gsc" => RunCompiler(root, sourcePath),
                "gsc-emit" => RunCompiler(
                    root,
                    "/target:exe",
                    "/out:" + Path.Combine(root, "no-reference.dll"),
                    sourcePath),
                "gsi" => RunGsi(root, sourcePath),
                _ => throw new InvalidOperationException(driver),
            };

            Assert.Contains("GS0157", result.Combined, StringComparison.Ordinal);
        }
        finally
        {
            DeleteDirectory(root);
        }
    }

    [Theory]
    [MemberData(nameof(RuntimeDrivers))]
    public void RuntimeImportedConstants_PreserveExactValuesAcrossDrivers(string driver)
    {
    string Expected =
        $"2147483647{Environment.NewLine}" +
        $"-2147483648{Environment.NewLine}" +
        $"3.141592653589793{Environment.NewLine}";
        var root = CreateEmptyTestDirectory();
        try
        {
            var sourcePath = WriteSource(root, "runtime.gs", CreateRuntimeValueSource());
            DriverResult result;
            if (driver == "gsc-emit")
            {
                var assemblyPath = Path.Combine(root, "runtime-constants.dll");
                result = RunCompiler(
                    root,
                    "/target:exe",
                    "/nowarn:GS9100",
                    "/out:" + assemblyPath,
                    sourcePath);
                AssertSucceeded(result, driver);
                Assert.Equal(Expected, RunAssembly(root, assemblyPath));
                return;
            }

            result = driver switch
            {
                "bare-gsc" => RunCompiler(root, "/nowarn:GS9100", sourcePath),
                "gsi" => RunGsi(root, sourcePath),
                _ => throw new InvalidOperationException(driver),
            };
            AssertSucceeded(result, driver);
            Assert.Equal(Expected, ProgramOutput(result));
        }
        finally
        {
            DeleteDirectory(root);
        }
    }

    [Fact]
    public void CrossAssemblyFixture_HasExpectedIdentity()
    {
        var fixturePath = GetCrossFixturePath();
        Assert.True(File.Exists(fixturePath), fixturePath);
        Assert.True(new FileInfo(fixturePath).Length > 0);
        Assert.Equal(
            "GSharp.Issue3119.Cross",
            AssemblyName.GetAssemblyName(fixturePath).Name);
    }

    private static string CreateValueSource(
        string fixtureNamespace,
        string expression) => $$"""
        package Issue3119Corpus
        import System
        import System.Globalization
        import {{fixtureNamespace}}

        Console.WriteLine({{expression}})
        """;

    private static string CreateNarrowingSource(string fieldName) => $$"""
        package Issue3119Corpus
        import GSharp.Issue3119.Cross

        var narrowed string = Constants.{{fieldName}}
        """;

    private static string CreateAssertionSource(string condition) => $$"""
        package Issue3119Corpus
        import System
        import GSharp.Issue3119.Cross

        if !({{condition}}) { throw Exception("wrong imported constant value") }
        """;

    private static string CreateRuntimeValueSource() => """
        package Issue3119Corpus
        import System
        import System.Globalization

        Console.WriteLine(int32.MaxValue)
        Console.WriteLine(int32.MinValue)
        Console.WriteLine(Math.PI.ToString("R", CultureInfo.InvariantCulture))
        """;

    private static DriverResult RunCompiler(string workingDirectory, params string[] arguments)
        => Capture(workingDirectory, () => GSharp.Compiler.Program.Main(arguments));

    private static DriverResult RunGsi(string workingDirectory, string sourcePath)
        => Capture(workingDirectory, () => GSharp.Repl.Program.Main(new[] { sourcePath }));

    private static DriverResult Capture(string workingDirectory, Func<int> action)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        var previousDirectory = Environment.CurrentDirectory;
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            Environment.CurrentDirectory = workingDirectory;
            return new DriverResult(action(), stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Environment.CurrentDirectory = previousDirectory;
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static void AssertSucceeded(DriverResult result, string name)
    {
        Assert.True(
            result.ExitCode == 0,
            $"{name} exited {result.ExitCode}\nstdout:\n{result.StandardOutput}\nstderr:\n{result.StandardError}");
        Assert.DoesNotContain("error GS", result.Combined, StringComparison.Ordinal);
    }

    private static string RunAssembly(string directory, string assemblyPath)
    {
        var runtimeConfigPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json");
        File.WriteAllText(
            runtimeConfigPath,
            """
            {
              "runtimeOptions": {
                "tfm": "net10.0",
                "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
              }
            }
            """);

        var result = DotnetProcess.Run(
            directory,
            "exec",
            "--runtimeconfig",
            runtimeConfigPath,
            assemblyPath);
        Assert.True(
            result.ExitCode == 0,
            $"Emitted assembly exited {result.ExitCode}\nstdout:\n{result.StandardOutput}\nstderr:\n{result.StandardError}");
        Assert.Equal(string.Empty, result.StandardError);
        return Normalize(result.StandardOutput);
    }

    private static void CopyRuntimeDependency(string sourcePath, string directory)
    {
        var destination = Path.Combine(directory, Path.GetFileName(sourcePath));
        if (!string.Equals(sourcePath, destination, StringComparison.Ordinal))
        {
            File.Copy(sourcePath, destination, overwrite: true);
        }
    }

    private static string ProgramOutput(DriverResult result)
    {
        var success = $"Success.{Environment.NewLine}";
        var output = Normalize(result.StandardOutput);
        return output.EndsWith(success, StringComparison.Ordinal)
            ? output[..^success.Length]
            : output;
    }

    private static string CreateEmptyTestDirectory()
    {
        var artifacts = Path.Combine(Environment.CurrentDirectory, "TestArtifacts");
        Directory.CreateDirectory(artifacts);
        var directory = Path.Combine(
            artifacts,
            $"{nameof(Issue3119ImportedConstantCorpusTests)}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        Assert.Empty(Directory.GetFileSystemEntries(directory));
        return directory;
    }

    private static string WriteSource(string directory, string name, string source)
    {
        var path = Path.Combine(directory, name);
        File.WriteAllText(path, source);
        return path;
    }

    private static string GetCrossFixturePath()
    {
        var configurationRoot = Directory.GetParent(
            AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar))?.FullName
            ?? throw new InvalidOperationException("Cannot resolve test output root");
        return Path.Combine(
            configurationRoot,
            "Issue3119.CrossConstants",
            "GSharp.Issue3119.Cross.dll");
    }

    private static void DeleteDirectory(string path)
    {
        try
        {
            Directory.Delete(path, recursive: true);
        }
        catch
        {
        }
    }

    private static string Normalize(string text)
        => text.ReplaceLineEndings(Environment.NewLine);

    private sealed record DriverResult(int ExitCode, string StandardOutput, string StandardError)
    {
        public string Combined => StandardOutput + StandardError;
    }
}
