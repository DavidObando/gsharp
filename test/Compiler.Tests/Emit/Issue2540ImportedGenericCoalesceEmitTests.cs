// <copyright file="Issue2540ImportedGenericCoalesceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2540ImportedGenericCoalesceEmitTests
{
    private const string ContractsSource = """
        package Issue2540.Contracts

        interface ILogger[out T] {
            func Name() string;
        }

        class Category {}
        """;

    private const string ImplementationsSource = """
        package Issue2540.Implementations
        import Issue2540.Contracts

        class NullLogger : ILogger[Category] {
            shared {
                let Instance NullLogger = NullLogger()
            }

            func Name() string -> "null"
        }
        """;

    [Fact]
    public void ImportedGenericInterface_CoalescesWithConcreteSingleton()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2540-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        try
        {
            var contractsPath = CompileContracts(directory);
            var implementationsPath = CompileFixture(
                directory,
                "Issue2540.Implementations",
                ImplementationsSource,
                contractsPath);
            const string source = """
                package Issue2540.App
                import System
                import Issue2540.Contracts
                import Issue2540.Implementations

                class Service {
                    private let logger ILogger[Category]

                    init(logger ILogger[Category]?) {
                        var selected = logger ?? NullLogger.Instance
                        this.logger = selected
                    }

                    func Name() string -> logger!!.Name()!!
                }

                func Main() {
                    Console.WriteLine(Service(nil).Name())
                }
                """;

            var outputPath = Path.Combine(directory, "Issue2540.App.dll");
            var result = Compile(
                directory,
                source,
                outputPath,
                contractsPath,
                implementationsPath);
            Assert.True(
                result.ExitCode == 0,
                $"compile failed\n{result.Stdout}\n{result.Stderr}");
            IlVerifier.Verify(
                outputPath,
                additionalReferences: new[] { contractsPath, implementationsPath });
            Assert.Equal("null\n", Run(outputPath));

            const string invalidSource = """
                package Issue2540.Invalid
                import Issue2540.Contracts

                class Other {}

                func Bad(logger ILogger[Category]?) ILogger[Category] {
                    return logger ?? Other()
                }
                """;
            var invalid = Compile(
                directory,
                invalidSource,
                Path.Combine(directory, "Issue2540.Invalid.dll"),
                contractsPath,
                implementationsPath,
                target: "library");
            Assert.NotEqual(0, invalid.ExitCode);
            Assert.Contains("GS0129", invalid.Stdout + invalid.Stderr, StringComparison.Ordinal);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static string CompileContracts(string directory)
        => CompileFixture(directory, "Issue2540.Contracts", ContractsSource);

    private static string CompileFixture(
        string directory,
        string assemblyName,
        string source,
        params string[] fixtureReferences)
    {
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        var sourcePath = Path.Combine(directory, assemblyName + ".gs");
        File.WriteAllText(sourcePath, source);
        var args = new string[fixtureReferences.Length + 4];
        args[0] = "/out:" + outputPath;
        args[1] = "/target:library";
        args[2] = "/targetframework:net10.0";
        for (var i = 0; i < fixtureReferences.Length; i++)
        {
            args[i + 3] = "/reference:" + fixtureReferences[i];
        }

        args[^1] = sourcePath;
        var result = RunCompiler(args);
        Assert.True(
            result.ExitCode == 0,
            $"fixture compile failed\n{result.Stdout}\n{result.Stderr}");
        return outputPath;
    }

    private static (int ExitCode, string Stdout, string Stderr) Compile(
        string directory,
        string source,
        string outputPath,
        string contractsPath,
        string implementationsPath,
        string target = "exe")
    {
        var sourcePath = Path.Combine(directory, Path.GetFileNameWithoutExtension(outputPath) + ".gs");
        File.WriteAllText(sourcePath, source);
        return RunCompiler(new[]
        {
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/reference:" + contractsPath,
            "/reference:" + implementationsPath,
            sourcePath,
        });
    }

    private static (int ExitCode, string Stdout, string Stderr) RunCompiler(string[] args)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return (Program.Main(args), stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
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
}
