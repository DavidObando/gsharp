// <copyright file="Issue2617ImportedGenericStaticExplicitTypeArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2617: explicit type arguments on imported generic static methods must
/// participate in overload resolution and satisfy constraints symbolically.
/// </summary>
public sealed class Issue2617ImportedGenericStaticExplicitTypeArgumentTests
{
    private const string ContractsSource = """
        #nullable enable
        using System;

        namespace Oahu.Aux
        {
            public interface IUserSettings { }

            public static class SettingsManager
            {
                public static T GetUserSettings<T>(bool renew = false, string? settingsFile = null)
                    where T : class, IUserSettings, new()
                {
                    Console.WriteLine("default:" + typeof(T).Name);
                    return new T();
                }

                public static T GetUserSettings<T>(string settingsFile, bool renew = false)
                    where T : class, IUserSettings, new()
                {
                    Console.WriteLine("file:" + settingsFile);
                    return new T();
                }
            }
        }
        """;

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(
        () => TrustedPlatformAssemblies().ToArray());

    [Theory]
    [InlineData("Oahu.App", "UserSettings")]
    [InlineData("Oahu.Cli.App", "OahuUserSettings")]
    public void ExactOahuCall_CrossAssembly_BindsAndRuns(string packageName, string settingsType)
    {
        var source = $$"""
            package {{packageName}}
            import System
            import Oahu.Aux

            class {{settingsType}} : IUserSettings {}

            func Main() {
                var settings = SettingsManager.GetUserSettings[{{settingsType}}]()
                Console.WriteLine(settings.GetType().Name)
            }
            """;

        using var result = Compile(source, target: "exe");
        Assert.DoesNotContain("GS0159", result.Stdout + result.Stderr, StringComparison.Ordinal);
        Assert.Equal($"default:{settingsType}\n{settingsType}\n", Run(result.OutputPath));
        IlVerifier.Verify(result.OutputPath, additionalReferences: new[] { result.ContractsPath });
    }

    [Fact]
    public void ExplicitTypeArgument_StillSelectsApplicableOverload()
    {
        const string source = """
            package Oahu.Overloads
            import System
            import Oahu.Aux

            class UserSettings : IUserSettings {}

            func Main() {
                var settings = SettingsManager.GetUserSettings[UserSettings]("custom.json")
                Console.WriteLine(settings.GetType().Name)
            }
            """;

        using var result = Compile(source, target: "exe");
        Assert.Equal("file:custom.json\nUserSettings\n", Run(result.OutputPath));
    }

    [Fact]
    public void ExplicitTypeArgument_ThatViolatesImportedInterfaceConstraint_IsRejected()
    {
        const string source = """
            package Oahu.Negative
            import Oahu.Aux

            class NotUserSettings {}

            func Bad() NotUserSettings ->
                SettingsManager.GetUserSettings[NotUserSettings]()
            """;

        using var result = Compile(source, target: "library", expectSuccess: false);
        Assert.Contains("GS0159", result.Stdout + result.Stderr, StringComparison.Ordinal);
    }

    [Fact]
    public void ExplicitTypeArgument_ThatViolatesImportedConstructorConstraint_IsRejected()
    {
        const string source = """
            package Oahu.Negative
            import Oahu.Aux

            class UserSettings(value int32) : IUserSettings {}

            func Bad() UserSettings ->
                SettingsManager.GetUserSettings[UserSettings]()
            """;

        using var result = Compile(source, target: "library", expectSuccess: false);
        Assert.Contains("GS0159", result.Stdout + result.Stderr, StringComparison.Ordinal);
    }

    private static CompilationResult Compile(string source, string target, bool expectSuccess = true)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2617-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var contractsPath = EmitContracts(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/reference:" + contractsPath,
        };
        args.AddRange(BclReferences.Value.Select(path => "/reference:" + path));
        args.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        if (expectSuccess)
        {
            Assert.True(
                exitCode == 0,
                $"compile failed ({exitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        }
        else
        {
            Assert.NotEqual(0, exitCode);
        }

        return new CompilationResult(directory, outputPath, contractsPath, stdout.ToString(), stderr.ToString());
    }

    private static string EmitContracts(string directory)
    {
        var outputPath = Path.Combine(directory, "Oahu.Aux.dll");
        var compilation = CSharpCompilation.Create(
            "Oahu.Aux",
            new[] { CSharpSyntaxTree.ParseText(ContractsSource, new CSharpParseOptions(LanguageVersion.Latest)) },
            BclReferences.Value.Select(path => MetadataReference.CreateFromFile(path)),
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable));
        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
    }

    private static string Run(string assemblyPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath)!,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet exec.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n");
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(value)
            ? Enumerable.Empty<string>()
            : value.Split(Path.PathSeparator);
    }

    private sealed class CompilationResult : IDisposable
    {
        public CompilationResult(
            string directoryPath,
            string outputPath,
            string contractsPath,
            string stdout,
            string stderr)
        {
            DirectoryPath = directoryPath;
            OutputPath = outputPath;
            ContractsPath = contractsPath;
            Stdout = stdout;
            Stderr = stderr;
        }

        public string DirectoryPath { get; }

        public string OutputPath { get; }

        public string ContractsPath { get; }

        public string Stdout { get; }

        public string Stderr { get; }

        public void Dispose()
        {
            try
            {
                Directory.Delete(DirectoryPath, recursive: true);
            }
            catch
            {
            }
        }
    }
}
