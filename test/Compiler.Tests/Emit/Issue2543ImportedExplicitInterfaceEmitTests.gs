// <copyright file="Issue2543ImportedExplicitInterfaceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #2543: explicit implementations bind to imported interface slots.
class Issue2543ImportedExplicitInterfaceEmitTests {
    @Fact
    func ImportedExplicitMembers_IncludingIssue3535Collisions_EmitAndDispatch() {
        const source = `package Issue2543.App
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
}`
        using let artifacts = Compile(source, "exe")
        Assert.Equal(
            "explicit:ok${Environment.NewLine}imported${Environment.NewLine}12${Environment.NewLine}1${Environment.NewLine}" +
                "value:generic${Environment.NewLine}11${Environment.NewLine}text${Environment.NewLine}22${Environment.NewLine}" +
                "key:x${Environment.NewLine}numeric-event${Environment.NewLine}event${Environment.NewLine}",
            Run(artifacts.OutputPath)
        )
        IlVerifier.Verify(artifacts.OutputPath, additionalReferences: []string{artifacts.ContractsPath})
        using let stream = File.OpenRead(artifacts.OutputPath)
        using let peReader = PEReader(stream)
        let reader = peReader.GetMetadataReader()
        let implementation = reader
            .TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single((type TypeDefinition) -> reader.GetString(type.Name) == "Implementation")
        Assert.Equal(15, implementation.GetMethodImplementations().Count)
    }

    @Theory
    @InlineData("class Bad { func (Marker) Echo(value string) string -> value }", "GS0492")
    @InlineData("class Bad : IContract { func (IOther) Echo(value string) string -> value }", "GS0493")
    @InlineData("class Bad : IContract { func (IContract) Missing() string -> \"missing\" }", "GS0494")
    func ImportedQualifierErrorsRetainSpecificDiagnostics(declaration string, diagnosticId string) {
        let source = (`package Issue2543.Negative
import Issue2543.Contracts
` + "$declaration")
        using let artifacts = Compile(source, "library", expectSuccess: false)
        Assert.NotEqual(0, artifacts.ExitCode)
        Assert.Contains(diagnosticId, artifacts.Stdout + artifacts.Stderr, StringComparison.Ordinal)
    }

    private class CompilationArtifacts : IDisposable {
        init(directory string, outputPath string, contractsPath string, exitCode int32, stdout string, stderr string) {
            Directory = directory
            OutputPath = outputPath
            ContractsPath = contractsPath
            ExitCode = exitCode
            Stdout = stdout
            Stderr = stderr
        }

        prop Directory string {
            get;
        }

        prop OutputPath string {
            get;
        }

        prop ContractsPath string {
            get;
        }

        prop ExitCode int32 {
            get;
        }

        prop Stdout string {
            get;
        }

        prop Stderr string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(Directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private const ContractsSource string = `package Issue2543.Contracts
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

class Marker {}`

        private func Compile(
            source string,
            target string,
            expectSuccess bool = true
        ) Issue2543ImportedExplicitInterfaceEmitTests
            .CompilationArtifacts {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2543-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let contractsSourcePath = Path.Combine(directory, "contracts.gs")
            let contractsPath = Path.Combine(directory, "Issue2543.Contracts.dll")
            File.WriteAllText(contractsSourcePath, ContractsSource)
            let contractsResult = RunCompiler(
                []string{"/out:" + contractsPath, "/target:library", "/targetframework:net10.0", contractsSourcePath}
            )
            Assert.True(contractsResult.ExitCode == 0, (`contract compile failed
` + "${contractsResult.Stdout}" + `
` + "${contractsResult.Stderr}"))
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "Issue2543.App.dll")
            File.WriteAllText(sourcePath, source)
            let result = RunCompiler(
                []string{
                    "/out:" + outputPath,
                    "/target:" + target,
                    "/targetframework:net10.0",
                    "/reference:" + contractsPath,
                    sourcePath
                }
            )
            if expectSuccess {
                Assert.True(result.ExitCode == 0, (`compile failed
` + "${result.Stdout}" + `
` + "${result.Stderr}"))
            }
            return Issue2543ImportedExplicitInterfaceEmitTests.CompilationArtifacts(
                directory,
                outputPath,
                contractsPath,
                result.ExitCode,
                result.Stdout,
                result.Stderr
            )
        }

        private func RunCompiler(args[]string)(ExitCode int32, Stdout string, Stderr string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                return (Program.Main(args), stdout.ToString(), stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func Run(assemblyPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
