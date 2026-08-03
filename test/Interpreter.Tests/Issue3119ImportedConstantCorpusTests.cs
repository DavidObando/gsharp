// <copyright file="Issue3119ImportedConstantCorpusTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>Issue #3119: imported constants preserve type and value across every driver.</summary>
[Collection("ConsoleIo")]
public class Issue3119ImportedConstantCorpusTests
{
    private static readonly string[] ExpectedValues =
    {
        "empty-401",
        "escaped-402",
        "char-403",
        "bool-404",
        "405.5",
        "enabled-text-410",
        "411",
        "disabled-text-412",
        "413",
        "406",
        "407",
        "408",
        "depth3-409",
        "499",
    };

    [Fact]
    public void ImportedConstants_PreserveValuesAcrossSameAndCrossAssemblyDrivers()
    {
        var root = CreateEmptyTestDirectory();
        try
        {
            var sameFixture = typeof(GSharp.Issue3119.Same.Constants).Assembly;
            Assert.NotEmpty(sameFixture.GetTypes());
            Assert.Equal(
                "GSharp.Issue3119.ImportedConstants",
                sameFixture.GetName().Name);

            var crossFixturePath = GetCrossFixturePath();
            Assert.True(File.Exists(crossFixturePath), crossFixturePath);
            Assert.True(new FileInfo(crossFixturePath).Length > 0);
            Assert.Equal(
                "GSharp.Issue3119.Cross",
                AssemblyName.GetAssemblyName(crossFixturePath).Name);

            var sources = Path.Combine(root, "sources");
            Directory.CreateDirectory(sources);
            var sameSource = WriteSource(
                sources,
                "same.gs",
                CreateCorpusSource("GSharp.Issue3119.Same"));
            var crossSource = WriteSource(
                sources,
                "cross.gs",
                CreateCorpusSource("GSharp.Issue3119.Cross"));
            var crossAssertionSource = WriteSource(
                sources,
                "cross-assert.gs",
                CreateAssertionSource("GSharp.Issue3119.Cross"));

            RunSameAssemblyMatrix(root, sameSource, sameFixture.Location);
            RunCrossAssemblyMatrix(root, crossSource, crossAssertionSource, crossFixturePath);

            var loadedCrossFixture = Assembly.Load(File.ReadAllBytes(crossFixturePath));
            Assert.NotEmpty(loadedCrossFixture.GetTypes());
        }
        finally
        {
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static void RunSameAssemblyMatrix(
        string root,
        string sourcePath,
        string runtimeDependency)
    {
        var bareDirectory = CreateEmptyCell(root, "same-gsc-evaluate");
        var bare = RunCompiler(bareDirectory, "/nowarn:GS9100", sourcePath);
        AssertSucceededWithValues(bare, "same-assembly gsc evaluation");

        var emitDirectory = CreateEmptyCell(root, "same-gsc-emit");
        var assemblyPath = Path.Combine(emitDirectory, "same-constants.dll");
        var emitted = RunCompiler(
            emitDirectory,
            "/target:exe",
            "/nowarn:GS9100",
            "/out:" + assemblyPath,
            sourcePath);
        AssertSucceeded(emitted, "same-assembly gsc emit");
        CopyRuntimeDependency(runtimeDependency, emitDirectory);
        AssertAssemblyLoads(assemblyPath);
        Assert.Equal(ExpectedValues, RunAssembly(emitDirectory, assemblyPath));

        var interpreterDirectory = CreateEmptyCell(root, "same-gsi");
        var interpreted = RunInterpreter(interpreterDirectory, sourcePath);
        AssertSucceededWithValues(interpreted, "same-assembly gsi");
    }

    private static void RunCrossAssemblyMatrix(
        string root,
        string sourcePath,
        string assertionSourcePath,
        string fixturePath)
    {
        var noReferenceDirectory = CreateEmptyCell(root, "cross-gsc-no-reference");
        var noReference = RunCompiler(
            noReferenceDirectory,
            "/nowarn:GS9100",
            assertionSourcePath);
        Assert.Equal(1, noReference.ExitCode);
        Assert.Contains("error GS", noReference.Combined, StringComparison.Ordinal);

        var bareDirectory = CreateEmptyCell(root, "cross-gsc-evaluate");
        // MetadataLoadContext-backed evaluation cannot execute decimal or nullable fields;
        // the emitted cross-assembly cell below covers their values.
        var bare = RunCompiler(
            bareDirectory,
            "/nowarn:GS9100",
            "/r:" + fixturePath,
            assertionSourcePath);
        AssertSucceeded(bare, "cross-assembly gsc evaluation");
        Assert.Equal("Success.\n", Normalize(bare.StandardOutput));

        var emitDirectory = CreateEmptyCell(root, "cross-gsc-emit");
        var assemblyPath = Path.Combine(emitDirectory, "cross-constants.dll");
        var emitted = RunCompiler(
            emitDirectory,
            "/target:exe",
            "/nowarn:GS9100",
            "/out:" + assemblyPath,
            "/r:" + fixturePath,
            sourcePath);
        AssertSucceeded(emitted, "cross-assembly gsc emit");
        CopyRuntimeDependency(fixturePath, emitDirectory);
        AssertAssemblyLoads(assemblyPath);
        Assert.Equal(ExpectedValues, RunAssembly(emitDirectory, assemblyPath));
    }

    private static string CreateCorpusSource(string fixtureNamespace) => $$"""
        package Issue3119Corpus
        import System
        import {{fixtureNamespace}}

        if Constants.Empty == "" {
            Console.WriteLine("empty-401")
        } else {
            Console.WriteLine("bad-empty")
        }

        if Constants.Escaped == "A\n\"B\"\\C" {
            Console.WriteLine("escaped-402")
        } else {
            Console.WriteLine("bad-escaped")
        }

        if Constants.Character == 'Q' {
            Console.WriteLine("char-403")
        } else {
            Console.WriteLine("bad-char")
        }

        if Constants.Boolean {
            Console.WriteLine("bool-404")
        } else {
            Console.WriteLine("bad-bool")
        }

        Console.WriteLine(Constants.Decimal)

        var enabledText string? = Constants.EnabledText
        var enabledInt int32? = Constants.EnabledInt
        var disabledText string? = Constants.DisabledText
        var disabledInt int32? = Constants.DisabledInt
        Console.WriteLine(enabledText ?? "bad-enabled-text")
        Console.WriteLine(enabledInt ?? -411)
        Console.WriteLine(disabledText ?? "bad-disabled-text")
        Console.WriteLine(disabledInt ?? -413)

        Console.WriteLine(int32(Constants.TopLevelEnumValue))
        Console.WriteLine(int32(Constants.NestedEnumValue))
        Console.WriteLine(GenericOuter[int32].Depth2.Value)
        Console.WriteLine(GenericOuter[int32].Depth2.Depth3.Value)
        Console.WriteLine(Constants.PositiveControl)
        """;

    private static string CreateAssertionSource(string fixtureNamespace) => $$"""
        package Issue3119Corpus
        import System
        import {{fixtureNamespace}}

        if Constants.Empty != "" { throw Exception("empty-401") }
        if Constants.Escaped != "A\n\"B\"\\C" { throw Exception("escaped-402") }
        if Constants.Character != 'Q' { throw Exception("char-403") }
        if !Constants.Boolean { throw Exception("bool-404") }
        if int32(Constants.TopLevelEnumValue) != 406 { throw Exception("top-enum-406") }
        if int32(Constants.NestedEnumValue) != 407 { throw Exception("nested-enum-407") }
        if GenericOuter[int32].Depth2.Value != 408 { throw Exception("depth2-408") }
        if GenericOuter[int32].Depth2.Depth3.Value != "depth3-409" { throw Exception("depth3-409") }
        if Constants.PositiveControl != 499 { throw Exception("positive-control-499") }
        """;

    private static DriverResult RunCompiler(string workingDirectory, params string[] arguments)
        => Capture(workingDirectory, () => GSharp.Compiler.Program.Main(arguments));

    private static DriverResult RunInterpreter(string workingDirectory, string sourcePath)
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

    private static void AssertSucceededWithValues(DriverResult result, string name)
    {
        AssertSucceeded(result, name);
        var values = Normalize(result.StandardOutput)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Where(line => line != "Success.")
            .ToArray();
        Assert.Equal(ExpectedValues, values);
    }

    private static void AssertSucceeded(DriverResult result, string name)
    {
        Assert.True(
            result.ExitCode == 0,
            $"{name} exited {result.ExitCode}\nstdout:\n{result.StandardOutput}\nstderr:\n{result.StandardError}");
        Assert.DoesNotContain("error GS", result.Combined, StringComparison.Ordinal);
    }

    private static string[] RunAssembly(string directory, string assemblyPath)
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

        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = directory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(runtimeConfigPath);
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start emitted assembly");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "Emitted assembly timed out");
        Assert.True(
            process.ExitCode == 0,
            $"Emitted assembly exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        Assert.Equal(string.Empty, stderr);
        return Normalize(stdout)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries);
    }

    private static void CopyRuntimeDependency(string sourcePath, string directory)
    {
        var destination = Path.Combine(directory, Path.GetFileName(sourcePath));
        if (!string.Equals(sourcePath, destination, StringComparison.Ordinal))
        {
            File.Copy(sourcePath, destination, overwrite: true);
        }
    }

    private static void AssertAssemblyLoads(string assemblyPath)
    {
        var loadContext = new AssemblyLoadContext(
            $"Issue3119-{Guid.NewGuid():N}",
            isCollectible: true);
        try
        {
            Assert.NotEmpty(loadContext.LoadFromAssemblyPath(assemblyPath).GetTypes());
        }
        finally
        {
            loadContext.Unload();
        }
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

    private static string CreateEmptyCell(string root, string name)
    {
        var directory = Path.Combine(root, name);
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

    private static string Normalize(string text)
        => text.Replace("\r\n", "\n", StringComparison.Ordinal);

    private sealed record DriverResult(int ExitCode, string StandardOutput, string StandardError)
    {
        public string Combined => StandardOutput + StandardError;
    }
}
