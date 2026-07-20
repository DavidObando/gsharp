// <copyright file="Issue2543ImportedExplicitInterfaceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2543: explicit implementations bind to imported interface slots.</summary>
public sealed class Issue2543ImportedExplicitInterfaceEmitTests
{
    private const string ContractsSource = """
        package Issue2543.Contracts
        import System

        interface IContract {
            func Echo(value string) string;
            prop Name string { get; }
            prop this[index int32] int32 { get; }
            event Changed Action
        }

        interface IOther {
            func Echo(value string) string;
        }

        interface IGeneric[T] {
            func Convert(value T) T;
            prop Value T { get; }
        }

        class Marker {}
        """;

    [Fact]
    public void ImportedExplicitMembers_CompileEmitMethodImplsAndDispatch()
    {
        const string source = """
            package Issue2543.App
            import System
            import Issue2543.Contracts

            class Sink {
                var Hits int32
                init() { Hits = 0 }
                func Bump() { Hits = Hits + 1 }
            }

            class Implementation : IContract, IGeneric[string] {
                private var _handler Action?

                private func (IContract) Echo(value string) string -> "explicit:" + value
                private prop (IContract) Name string -> "imported"
                private prop (IContract) this[index int32] int32 -> index * 3
                private event (IContract) Changed Action {
                    add { _handler = value }
                    remove { _handler = nil }
                }
                private func (IGeneric[string]) Convert(value string) string -> value + ":generic"
                private prop (IGeneric[string]) Value string -> "value"

                func Fire() { _handler?.Invoke() }
            }

            func Main() {
                var implementation = Implementation()
                var contract IContract = implementation
                var sink = Sink()
                contract.Changed += func() { sink.Bump() }
                implementation.Fire()
                Console.WriteLine(contract.Echo("ok"))
                Console.WriteLine(contract.Name)
                Console.WriteLine(contract[4])
                Console.WriteLine(sink.Hits)
                var generic IGeneric[string] = implementation
                Console.WriteLine(generic.Convert(generic.Value))
            }
            """;

        using var artifacts = Compile(source, "exe");
        Assert.Equal("explicit:ok\nimported\n12\n1\nvalue:generic\n", Run(artifacts.OutputPath));
        IlVerifier.Verify(artifacts.OutputPath, additionalReferences: new[] { artifacts.ContractsPath });

        using var stream = File.OpenRead(artifacts.OutputPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var implementation = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(type => reader.GetString(type.Name) == "Implementation");
        Assert.Equal(7, implementation.GetMethodImplementations().Count);
    }

    [Theory]
    [InlineData(
        "class Bad { func (Marker) Echo(value string) string -> value }",
        "GS0492")]
    [InlineData(
        "class Bad : IContract { func (IOther) Echo(value string) string -> value }",
        "GS0493")]
    [InlineData(
        "class Bad : IContract { func (IContract) Missing() string -> \"missing\" }",
        "GS0494")]
    public void ImportedQualifierErrorsRetainSpecificDiagnostics(string declaration, string diagnosticId)
    {
        var source = $$"""
            package Issue2543.Negative
            import Issue2543.Contracts
            {{declaration}}
            """;

        using var artifacts = Compile(source, "library", expectSuccess: false);
        Assert.NotEqual(0, artifacts.ExitCode);
        Assert.Contains(diagnosticId, artifacts.Stdout + artifacts.Stderr, StringComparison.Ordinal);
    }

    private static CompilationArtifacts Compile(string source, string target, bool expectSuccess = true)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2543-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        var contractsSourcePath = Path.Combine(directory, "contracts.gs");
        var contractsPath = Path.Combine(directory, "Issue2543.Contracts.dll");
        File.WriteAllText(contractsSourcePath, ContractsSource);
        var contractsResult = RunCompiler(new[]
        {
            "/out:" + contractsPath,
            "/target:library",
            "/targetframework:net10.0",
            contractsSourcePath,
        });
        Assert.True(
            contractsResult.ExitCode == 0,
            $"contract compile failed\n{contractsResult.Stdout}\n{contractsResult.Stderr}");

        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "Issue2543.App.dll");
        File.WriteAllText(sourcePath, source);
        var result = RunCompiler(new[]
        {
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/reference:" + contractsPath,
            sourcePath,
        });
        if (expectSuccess)
        {
            Assert.True(
                result.ExitCode == 0,
                $"compile failed\n{result.Stdout}\n{result.Stderr}");
        }

        return new CompilationArtifacts(
            directory,
            outputPath,
            contractsPath,
            result.ExitCode,
            result.Stdout,
            result.Stderr);
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

    private sealed class CompilationArtifacts : IDisposable
    {
        public CompilationArtifacts(
            string directory,
            string outputPath,
            string contractsPath,
            int exitCode,
            string stdout,
            string stderr)
        {
            Directory = directory;
            OutputPath = outputPath;
            ContractsPath = contractsPath;
            ExitCode = exitCode;
            Stdout = stdout;
            Stderr = stderr;
        }

        public string Directory { get; }

        public string OutputPath { get; }

        public string ContractsPath { get; }

        public int ExitCode { get; }

        public string Stdout { get; }

        public string Stderr { get; }

        public void Dispose()
        {
            try
            {
                System.IO.Directory.Delete(Directory, recursive: true);
            }
            catch
            {
            }
        }
    }
}
