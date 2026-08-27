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

        interface INumericSlots {
            prop Value int32 { get; }
            prop this[index int32] int32 { get; }
            event Changed Action
        }

        interface ITextSlots {
            prop Value string { get; }
            prop this[index string] string { get; }
            event Changed Action[string]
        }

        class Marker {}
        """;

    [Fact]
    public void ImportedExplicitMembers_IncludingIssue3535Collisions_EmitAndDispatch()
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

            class Implementation : IContract, IGeneric[string], INumericSlots, ITextSlots {
                private var _handler Action?
                private var _numericHandler Action?
                private var _textHandler Action[string]?

                private func (IContract) Echo(value string) string -> "explicit:" + value
                private prop (IContract) Name string -> "imported"
                private prop (IContract) this[index int32] int32 -> index * 3
                private event (IContract) Changed Action {
                    add { _handler = value }
                    remove { _handler = nil }
                }
                private func (IGeneric[string]) Convert(value string) string -> value + ":generic"
                private prop (IGeneric[string]) Value string -> "value"
                private prop (INumericSlots) Value int32 -> 11
                private prop (ITextSlots) Value string -> "text"
                private prop (INumericSlots) this[index int32] int32 -> index + 20
                private prop (ITextSlots) this[index string] string -> "key:" + index
                private event (INumericSlots) Changed Action {
                    add { _numericHandler = value }
                    remove { _numericHandler = nil }
                }
                private event (ITextSlots) Changed Action[string] {
                    add { _textHandler = value }
                    remove { _textHandler = nil }
                }

                func Fire() { _handler?.Invoke() }
                func FireNumeric() { _numericHandler?.Invoke() }
                func FireText() { _textHandler?.Invoke("event") }
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
                var numeric INumericSlots = implementation
                var text ITextSlots = implementation
                numeric.Changed += func() { Console.WriteLine("numeric-event") }
                text.Changed += func(value string) { Console.WriteLine(value) }
                Console.WriteLine(numeric.Value)
                Console.WriteLine(text.Value)
                Console.WriteLine(numeric[2])
                Console.WriteLine(text["x"])
                implementation.FireNumeric()
                implementation.FireText()
            }
            """;

        using var artifacts = Compile(source, "exe");
        Assert.Equal(
            $"explicit:ok{Environment.NewLine}imported{Environment.NewLine}12{Environment.NewLine}1{Environment.NewLine}" +
            $"value:generic{Environment.NewLine}11{Environment.NewLine}text{Environment.NewLine}22{Environment.NewLine}" +
            $"key:x{Environment.NewLine}numeric-event{Environment.NewLine}event{Environment.NewLine}",
            Run(artifacts.OutputPath));
        IlVerifier.Verify(artifacts.OutputPath, additionalReferences: new[] { artifacts.ContractsPath });

        using var stream = File.OpenRead(artifacts.OutputPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var implementation = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(type => reader.GetString(type.Name) == "Implementation");
        Assert.Equal(15, implementation.GetMethodImplementations().Count);
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
        return stdout.ReplaceLineEndings(Environment.NewLine);
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
