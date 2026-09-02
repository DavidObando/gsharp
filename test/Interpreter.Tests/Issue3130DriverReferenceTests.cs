// <copyright file="Issue3130DriverReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>Issue #3130: real evaluating drivers resolve bundled and explicit references.</summary>
public sealed class Issue3130DriverReferenceTests
{
    private static readonly string[] ExtensionSamples =
    {
        "GsharpExtensionsOptional",
        "GsharpExtensionsMixed",
        "GsharpExtensionsSequences",
    };

    [Fact]
    public async Task ExtensionSamples_MatchEmitAcrossRealDrivers()
    {
        var samplesDirectory = LocateSamplesDirectory();
        var gscPath = typeof(GSharp.Compiler.Program).Assembly.Location;
        var gsiPath = typeof(GSharp.Repl.Program).Assembly.Location;
        var extensionsPath = Path.Combine(Path.GetDirectoryName(gsiPath)!, "Gsharp.Extensions.dll");
        Assert.True(File.Exists(extensionsPath), $"Missing {extensionsPath}");

        foreach (var sample in ExtensionSamples)
        {
            var directory = CreateEmptyTestDirectory(sample);
            try
            {
                var sourcePath = Path.Combine(directory, sample + ".gs");
                var outputPath = Path.Combine(directory, sample + ".dll");
                File.Copy(Path.Combine(samplesDirectory, sample + ".gs"), sourcePath);
                var expected = Normalize(File.ReadAllText(Path.Combine(samplesDirectory, sample + ".golden")));

                var emit = await RunAsync(
                    directory,
                    gscPath,
                    "/nowarn:GS9100",
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/out:" + outputPath,
                    sourcePath);
                AssertSucceeded(emit, sample + " emit");

                CollectibleAssembly.Inspect(outputPath, assembly => Assert.NotEmpty(assembly.GetTypes()));

                File.Copy(extensionsPath, Path.Combine(directory, "Gsharp.Extensions.dll"), overwrite: true);
                var emitted = await RunAsync(
                    directory,
                    "exec",
                    "--runtimeconfig",
                    Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                    outputPath);
                AssertSucceeded(emitted, sample + " emitted execution");
                Assert.Equal(expected, Normalize(emitted.StandardOutput));

                var bareGsc = await RunAsync(directory, gscPath, "/nowarn:GS9100", sourcePath);
                AssertSucceeded(bareGsc, sample + " bare gsc");
                Assert.Equal(expected + $"Success.{Environment.NewLine}", Normalize(bareGsc.StandardOutput));

                var gsi = await RunAsync(directory, gsiPath, sourcePath);
                AssertSucceeded(gsi, sample + " gsi");
                Assert.Equal(expected, Normalize(gsi.StandardOutput));
            }
            finally
            {
                DeleteDirectory(directory);
            }
        }
    }

    [Fact]
    public async Task FullyQualifiedExtensionUse_MatchesEmitAcrossRealDrivers()
    {
        var directory = CreateEmptyTestDirectory("fully-qualified");
        try
        {
            var gscPath = typeof(GSharp.Compiler.Program).Assembly.Location;
            var gsiPath = typeof(GSharp.Repl.Program).Assembly.Location;
            var extensionsPath = Path.Combine(Path.GetDirectoryName(gsiPath)!, "Gsharp.Extensions.dll");
            var sourcePath = Path.Combine(directory, "probe.gs");
            var outputPath = Path.Combine(directory, "probe.dll");
            File.WriteAllText(
                sourcePath,
                """
                package FullyQualifiedProbe
                import System

                let values = Gsharp.Extensions.Sequences.Sequences.Of(11, 22, 33)
                Console.WriteLine(values[0])
                """);

            var emit = await RunAsync(
                directory,
                gscPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/out:" + outputPath,
                sourcePath);
            AssertSucceeded(emit, "fully-qualified emit");

            File.Copy(extensionsPath, Path.Combine(directory, "Gsharp.Extensions.dll"), overwrite: true);
            var emitted = await RunAsync(
                directory,
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                outputPath);
            AssertSucceeded(emitted, "fully-qualified emitted execution");
            Assert.Equal($"11{Environment.NewLine}", Normalize(emitted.StandardOutput));

            var bareGsc = await RunAsync(directory, gscPath, sourcePath);
            AssertSucceeded(bareGsc, "fully-qualified bare gsc");
            Assert.Equal(
                $"11{Environment.NewLine}Success.{Environment.NewLine}",
                Normalize(bareGsc.StandardOutput));

            var gsi = await RunAsync(directory, gsiPath, sourcePath);
            AssertSucceeded(gsi, "fully-qualified gsi");
            Assert.Equal($"11{Environment.NewLine}", Normalize(gsi.StandardOutput));
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    [Fact]
    public async Task ExplicitReference_WorksAcrossRealDrivers()
    {
        var directory = CreateEmptyTestDirectory("explicit");
        try
        {
            var gscPath = typeof(GSharp.Compiler.Program).Assembly.Location;
            var gsiPath = typeof(GSharp.Repl.Program).Assembly.Location;
            var referencePath = Path.Combine(directory, "ExternalProbe.dll");
            var sourcePath = Path.Combine(directory, "probe.gs");
            var outputPath = Path.Combine(directory, "probe.dll");
            EmitProbeAssembly(referencePath);
            File.WriteAllText(
                sourcePath,
                """
                package ReferenceProbe
                import System
                import ExternalProbe

                Console.WriteLine(Values.Answer())
                """);

            var bareWithoutReference = await RunAsync(directory, gscPath, sourcePath);
            Assert.NotEqual(0, bareWithoutReference.ExitCode);
            Assert.Contains("error GS", bareWithoutReference.Combined);
            var gsiWithoutReference = await RunAsync(directory, gsiPath, sourcePath);
            Assert.NotEqual(0, gsiWithoutReference.ExitCode);
            Assert.Contains("error GS", gsiWithoutReference.Combined);

            var emit = await RunAsync(
                directory,
                gscPath,
                "/nowarn:GS9100",
                "/target:exe",
                "/targetframework:net10.0",
                "/out:" + outputPath,
                "/r:" + referencePath,
                sourcePath);
            AssertSucceeded(emit, "explicit-reference emit");

            var emitted = await RunAsync(
                directory,
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                outputPath);
            AssertSucceeded(emitted, "explicit-reference emitted execution");
            Assert.Equal($"42{Environment.NewLine}", Normalize(emitted.StandardOutput));

            var bareGsc = await RunAsync(directory, gscPath, "/nowarn:GS9100", "/r:" + referencePath, sourcePath);
            AssertSucceeded(bareGsc, "explicit-reference bare gsc");
            Assert.Equal(
                $"42{Environment.NewLine}Success.{Environment.NewLine}",
                Normalize(bareGsc.StandardOutput));

            var gsi = await RunAsync(directory, gsiPath, "/r:" + referencePath, sourcePath);
            AssertSucceeded(gsi, "explicit-reference gsi");
            Assert.Equal($"42{Environment.NewLine}", Normalize(gsi.StandardOutput));

            var help = await RunAsync(directory, gsiPath, "--help");
            AssertSucceeded(help, "gsi help");
            Assert.Contains("/r:<file>", help.StandardOutput);

            var misplacedHelp = await RunAsync(directory, gsiPath, sourcePath, "--help");
            Assert.NotEqual(0, misplacedHelp.ExitCode);
            Assert.Contains("Unrecognized argument: --help", misplacedHelp.StandardError);
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    [Fact]
    public void GsiRuntimeManifest_IncludesExtensionsAssembly()
    {
        var gsiPath = typeof(GSharp.Repl.Program).Assembly.Location;
        var dependenciesPath = Path.ChangeExtension(gsiPath, ".deps.json");
        Assert.Contains("Gsharp.Extensions", File.ReadAllText(dependenciesPath));
    }

    [Fact]
    public async Task UnrelatedEmit_DoesNotAcquireImplicitExtensionWarnings()
    {
        var directory = CreateEmptyTestDirectory("unrelated-emit");
        try
        {
            var sourcePath = Path.Combine(directory, "probe.gs");
            File.WriteAllText(sourcePath, "import System\nConsole.WriteLine(42)");
            var result = await RunAsync(
                directory,
                typeof(GSharp.Compiler.Program).Assembly.Location,
                "/target:exe",
                "/targetframework:net10.0",
                "/out:" + Path.Combine(directory, "probe.dll"),
                sourcePath);

            AssertSucceeded(result, "unrelated emit");
            Assert.DoesNotContain("GS9100", result.Combined);
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    [Fact]
    public async Task BundledExtensionEmit_UsesInvokableRuntimeTypes()
    {
        var directory = CreateEmptyTestDirectory("runtime-emit");
        try
        {
            var gsiPath = typeof(GSharp.Repl.Program).Assembly.Location;
            var extensionsPath = Path.Combine(Path.GetDirectoryName(gsiPath)!, "Gsharp.Extensions.dll");
            var sourcePath = Path.Combine(directory, "probe.gs");
            var outputPath = Path.Combine(directory, "probe.dll");
            File.WriteAllText(
                sourcePath,
                """
                package RuntimeEmitProbe
                import System

                let values = chan[DateTime](1)
                values <- DateTime(2020, 1, 1)
                Console.WriteLine((<-values).Year)
                """);

            var emit = await RunAsync(
                directory,
                typeof(GSharp.Compiler.Program).Assembly.Location,
                "/target:exe",
                "/targetframework:net10.0",
                "/out:" + outputPath,
                sourcePath);
            AssertSucceeded(emit, "runtime extension emit");

            File.Copy(extensionsPath, Path.Combine(directory, "Gsharp.Extensions.dll"), overwrite: true);
            var emitted = await RunAsync(
                directory,
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                outputPath);
            AssertSucceeded(emitted, "runtime extension execution");
            Assert.Equal($"2020{Environment.NewLine}", Normalize(emitted.StandardOutput));
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    [Fact]
    public async Task BadReferences_AreRejectedAcrossRealDrivers()
    {
        foreach (var kind in new[] { "missing", "junk" })
        {
            var directory = CreateEmptyTestDirectory("bad-" + kind);
            try
            {
                var gscPath = typeof(GSharp.Compiler.Program).Assembly.Location;
                var gsiPath = typeof(GSharp.Repl.Program).Assembly.Location;
                var sourcePath = Path.Combine(directory, "probe.gs");
                var referencePath = Path.Combine(directory, kind + ".dll");
                File.WriteAllText(sourcePath, "import System\nConsole.WriteLine(42)");
                if (kind == "junk")
                {
                    File.WriteAllText(referencePath, "not an assembly");
                }

                var referenceArgument = "/r:" + referencePath;
                AssertRejectedReference(
                    await RunAsync(directory, gscPath, referenceArgument, sourcePath),
                    referencePath,
                    "bare gsc " + kind);
                AssertRejectedReference(
                    await RunAsync(
                        directory,
                        gscPath,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/out:" + Path.Combine(directory, "probe.dll"),
                        referenceArgument,
                        sourcePath),
                    referencePath,
                    "emit " + kind);
                AssertRejectedReference(
                    await RunAsync(directory, gsiPath, referenceArgument, sourcePath),
                    referencePath,
                    "gsi " + kind);
            }
            finally
            {
                DeleteDirectory(directory);
            }
        }
    }

    [Fact]
    public void BundledExtensionProbe_PrefersDriverSiblingThenBuildThenSdkLayout()
    {
        var directory = CreateEmptyTestDirectory("layouts");
        try
        {
            var driverDirectory = Path.Combine(directory, "compiler");
            var driverSibling = Path.Combine(driverDirectory, "Gsharp.Extensions.dll");
            var buildSibling = Path.Combine(directory, "Gsharp.Extensions", "Gsharp.Extensions.dll");
            var sdkSibling = Path.Combine(directory, "extensions", "Gsharp.Extensions.dll");
            Directory.CreateDirectory(driverDirectory);
            Directory.CreateDirectory(Path.GetDirectoryName(buildSibling)!);
            Directory.CreateDirectory(Path.GetDirectoryName(sdkSibling)!);
            File.WriteAllText(driverSibling, string.Empty);
            File.WriteAllText(buildSibling, string.Empty);
            File.WriteAllText(sdkSibling, string.Empty);

            Assert.Equal(driverSibling, ReferenceResolver.FindBundledExtensionPath(driverDirectory));
            File.Delete(driverSibling);
            Assert.Equal(buildSibling, ReferenceResolver.FindBundledExtensionPath(driverDirectory));
            File.Delete(buildSibling);
            Assert.Equal(sdkSibling, ReferenceResolver.FindBundledExtensionPath(driverDirectory));
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    [Fact]
    public void RuntimeReferenceResolver_DoesNotSilenceInvalidReferences()
    {
        var directory = CreateEmptyTestDirectory("runtime-invalid");
        try
        {
            var missingPath = Path.Combine(directory, "missing.dll");
            var junkPath = Path.Combine(directory, "junk.dll");
            File.WriteAllText(junkPath, "not an assembly");

            Assert.Throws<FileNotFoundException>(() => ReferenceResolver.WithRuntimeReferences([missingPath]));
            Assert.Throws<BadImageFormatException>(() => ReferenceResolver.WithRuntimeReferences([junkPath]));
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    [Fact]
    public void RuntimeReferenceResolver_DoesNotLeakExplicitReferences()
    {
        var directory = CreateEmptyTestDirectory("runtime-isolation");
        try
        {
            var referencePath = Path.Combine(directory, "ExternalProbe.dll");
            EmitProbeAssembly(referencePath);

            using (var referenced = ReferenceResolver.WithRuntimeReferences([referencePath]))
            {
                Assert.True(referenced.TryResolveType("ExternalProbe.Values", out _));
            }

            using var clean = ReferenceResolver.WithRuntimeReferences([]);
            Assert.False(clean.TryResolveType("ExternalProbe.Values", out _));
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    [Fact]
    public void SessionEngine_UsesProvidedRuntimeReferences()
    {
        // ADR-0156 Phase 3c (#3176): the interactive /r: channel now belongs
        // to the emitted engine; same probe, same reference path contract.
        var directory = CreateEmptyTestDirectory("session-reference");
        try
        {
            var referencePath = Path.Combine(directory, "ExternalProbe.dll");
            EmitProbeAssembly(referencePath);

            using var engine = new EmittedSessionEngine([referencePath]);
            var cell = engine.Evaluate(
                "package SessionReference\nimport ExternalProbe\nvar answer = Values.Answer()");

            Assert.False(cell.HasError, string.Join(Environment.NewLine, cell.Diagnostics));
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    private static void EmitProbeAssembly(string outputPath)
    {
        var builder = new PersistedAssemblyBuilder(new AssemblyName("ExternalProbe"), typeof(object).Assembly);
        var module = builder.DefineDynamicModule("ExternalProbe");
        var type = module.DefineType(
            "ExternalProbe.Values",
            TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed);
        var answer = type.DefineMethod(
            "Answer",
            MethodAttributes.Public | MethodAttributes.Static,
            typeof(int),
            Type.EmptyTypes);
        var il = answer.GetILGenerator();
        il.Emit(OpCodes.Ldc_I4, 42);
        il.Emit(OpCodes.Ret);
        type.CreateType();
        builder.Save(outputPath);
    }

    private static Task<DotnetProcessResult> RunAsync(string workingDirectory, params string[] arguments)
        => DotnetProcess.RunAsync(workingDirectory, arguments);

    private static void AssertSucceeded(DotnetProcessResult result, string operation)
        => Assert.True(
            result.ExitCode == 0,
            $"{operation} exited {result.ExitCode}\nstdout:\n{result.StandardOutput}\nstderr:\n{result.StandardError}");

    private static void AssertRejectedReference(DotnetProcessResult result, string referencePath, string operation)
    {
        Assert.True(result.ExitCode != 0, $"{operation} unexpectedly succeeded");
        Assert.Contains("Unable to load reference", result.Combined);
        Assert.Contains(referencePath, result.Combined);
    }

    private static string LocateSamplesDirectory()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "samples");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
            {
                return candidate;
            }
        }

        throw new DirectoryNotFoundException("Unable to locate samples directory");
    }

    private static string CreateEmptyTestDirectory(string suffix)
    {
        var root = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3130DriverReferenceTests),
            suffix + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.GetFileSystemEntries(root));
        return root;
    }

    private static void DeleteDirectory(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch
        {
        }
    }

    private static string Normalize(string text) => text.ReplaceLineEndings(Environment.NewLine);
}
