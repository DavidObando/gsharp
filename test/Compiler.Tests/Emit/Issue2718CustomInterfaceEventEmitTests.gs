// <copyright file="Issue2718CustomInterfaceEventEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// Issue #2718: custom event accessors implement interface accessor slots.
class Issue2718CustomInterfaceEventEmitTests {
    @Fact
    func PerJobDownloadSettings_ImportedCustomEvent_HasExactMethodImplsAndDispatches() {
        const source = `package Cli.App
import System
import Oahu.Core

class PerJobDownloadSettings : IDownloadSettings {
    private var inner IDownloadSettings

    init(inner IDownloadSettings) {
        this.inner = inner
    }

    event ChangedSettings (object?, EventArgs) -> void {
        add { inner.ChangedSettings += value }
        remove { inner.ChangedSettings -= value }
    }
}

func Main() {
    var inner = DownloadSettings()
    var concrete = PerJobDownloadSettings(inner)
    var settings IDownloadSettings = concrete
    var hits int32 = 0
    var handler EventHandler = (sender object, args EventArgs) -> { hits += 1 }
    settings.ChangedSettings += handler
    inner.Raise()
    settings.ChangedSettings -= handler
    inner.Raise()
    Console.WriteLine(hits)
}`
        using let artifacts = Compile(source, "exe", DownloadSettingsContract)
        Assert.Equal("1${Environment.NewLine}", Run(artifacts.OutputPath))
        IlVerifier.Verify(artifacts.OutputPath, additionalReferences: []string{artifacts.ContractsPath!!})
        using let stream = File.OpenRead(artifacts.OutputPath)
        using let peReader = PEReader(stream)
        let reader = peReader.GetMetadataReader()
        let type = reader
            .TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(
            (t TypeDefinition) -> reader.GetString(t.Namespace) == "Cli.App" && reader.GetString(
                t.Name
            ) == "PerJobDownloadSettings"
        )
        let implementations = type.GetMethodImplementations().Select(reader.GetMethodImplementation).ToArray()
        Assert.Equal(2, implementations.Length)
        Assert.Equal(
            []string{"add_ChangedSettings", "remove_ChangedSettings"},
            implementations
                .Select((i MethodImplementation) -> GetMethodName(reader, i.MethodBody))
                .OrderBy((n string) -> n)
                .ToArray()
        )
        for implementation in implementations {
            let method = reader.GetMethodDefinition(MethodDefinitionHandle(implementation.MethodBody))
            Assert.True((method.Attributes & MethodAttributes.Public) != 0)
            Assert.True((method.Attributes & MethodAttributes.Virtual) != 0)
        }
        let loadContext = AssemblyLoadContext("Issue2718", isCollectible: true)
        loadContext.Resolving += (_ AssemblyLoadContext, name AssemblyName) -> if name.Name == "Oahu.Core" {
            loadContext.LoadFromAssemblyPath(artifacts.ContractsPath!!)
        } else {
            default(Assembly?)
        }
        try {
            let assembly = loadContext.LoadFromAssemblyPath(artifacts.OutputPath)
            let implementationType = assembly.GetType("Cli.App.PerJobDownloadSettings")!!
            let interfaceType = implementationType.GetInterfaces().Single(
                (i Type) -> i.FullName == "Oahu.Core.IDownloadSettings"
            )
            let interfaceMap = implementationType.GetInterfaceMap(interfaceType)
            Assert.Equal(
                []string{"add_ChangedSettings", "remove_ChangedSettings"},
                interfaceMap.TargetMethods.Select((m MethodInfo) -> m.Name).OrderBy((n string) -> n).ToArray()
            )
            Assert.Equal(typeof(EventHandler), implementationType.GetEvent("ChangedSettings")!!.EventHandlerType)
            Assert.All(
                interfaceMap.TargetMethods,
                (method MethodInfo) -> Assert.Equal(typeof(EventHandler), method.GetParameters().Single().ParameterType)
            )
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func OahuCli_ActionOfAction_MethodGroup_BindsRunsAndIlVerifies() {
        const contracts = `package Oahu.Core
import System

class AppShellOptions { }

class TuiHost {
    shared {
        func Run(options AppShellOptions?, registerRestore Action[Action]?) {
            registerRestore!!(() -> Console.WriteLine("restored"))
        }
    }
}`
        const source = `package Oahu.Cli
import System
import Oahu.Core

class CliEnvironment {
    shared {
        func RegisterRestore(restore () -> void) {
            restore()
        }
    }
}

func Main() {
    TuiHost.Run(AppShellOptions{}, CliEnvironment.RegisterRestore)
}`
        using let artifacts = Compile(source, "exe", contracts)
        Assert.Equal("restored${Environment.NewLine}", Run(artifacts.OutputPath))
        IlVerifier.Verify(artifacts.OutputPath, additionalReferences: []string{artifacts.ContractsPath!!})
        let loadContext = AssemblyLoadContext("Issue2726", isCollectible: true)
        loadContext.Resolving += (_ AssemblyLoadContext, name AssemblyName) -> if name.Name == "Oahu.Core" {
            loadContext.LoadFromAssemblyPath(artifacts.ContractsPath!!)
        } else {
            default(Assembly?)
        }
        try {
            let assembly = loadContext.LoadFromAssemblyPath(artifacts.OutputPath)
            let method = assembly
                .GetTypes()
                .SelectMany(
                func (type Type) IEnumerable[MethodInfo] {
                    return type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                }
            )
                .Single((candidate MethodInfo) -> candidate.Name == "RegisterRestore")
            Assert.Equal(typeof(() -> void), method.GetParameters().Single().ParameterType)
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func DistinctNamedDelegateOverloads_RemainAmbiguous() {
        const contracts = `package DelegateContracts

delegate FirstHandler(value int32) void;
delegate SecondHandler(value int32) void;

class Dispatcher {
    shared {
        func Run(callback FirstHandler) { }
        func Run(callback SecondHandler) { }
    }
}`
        const source = `package DelegateConsumer
import DelegateContracts

class Handlers {
    shared {
        func Handle(value int32) { }
    }
}

func Main() {
    Dispatcher.Run(Handlers.Handle)
}`
        using let artifacts = Compile(source, "library", contracts, expectSuccess: false)
        Assert.NotEqual(0, artifacts.ExitCode)
        let output = artifacts.Stdout + artifacts.Stderr
        Assert.True(output.Contains("GS0160", StringComparison.Ordinal), output)
    }

    @Fact
    func InheritedGenericInterface_PrivateCustomEvent_EmitsMethodImplsAndIlVerifies() {
        const source = `package Issue2718.Generic
import System

delegate ChangeHandler[T](value T) void;

interface IChanges[T] {
    event Changed ChangeHandler[T]
}

interface IIntChanges : IChanges[int32] {
}

class Sink : IIntChanges {
    private var handler ChangeHandler[int32]?

    private event Changed ChangeHandler[int32] {
        add { handler = value }
        remove { handler = nil }
    }

    func Fire(value int32) { handler?.Invoke(value) }
}
`
        using let artifacts = Compile(source, "library")
        IlVerifier.Verify(artifacts.OutputPath)
        using let stream = File.OpenRead(artifacts.OutputPath)
        using let peReader = PEReader(stream)
        let reader = peReader.GetMetadataReader()
        let type = reader
            .TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single((t TypeDefinition) -> reader.GetString(t.Name) == "Sink")
        Assert.Equal(2, type.GetMethodImplementations().Count)
        for name in[]string{"add_Changed", "remove_Changed"} {
            let method = type
                .GetMethods()
                .Select(reader.GetMethodDefinition)
                .Single((m MethodDefinition) -> reader.GetString(m.Name) == name)
            Assert.True((method.Attributes & MethodAttributes.Private) != 0)
            Assert.True((method.Attributes & MethodAttributes.Virtual) != 0)
        }
    }

    @Fact
    func MismatchedCustomEventHandler_ReportsMissingInterfaceMember() {
        const source = `package Issue2718.Negative

delegate ChangeHandler[T](value T) void;

interface IChanges {
    event Changed ChangeHandler[int32]
}

class Bad : IChanges {
    event Changed ChangeHandler[string] {
        add { }
        remove { }
    }
}`
        using let artifacts = Compile(source, "library", expectSuccess: false)
        Assert.NotEqual(0, artifacts.ExitCode)
        let output = artifacts.Stdout + artifacts.Stderr
        Assert.True(output.Contains("GS0187", StringComparison.Ordinal), output)
    }

    private class CompilationArtifacts : IDisposable {
        init(directory string, outputPath string, contractsPath string?, exitCode int32, stdout string, stderr string) {
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

        prop ContractsPath string? {
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
        private const DownloadSettingsContract string = `package Oahu.Core
import System

interface IDownloadSettings {
    event ChangedSettings EventHandler
}

class DownloadSettings : IDownloadSettings {
    event ChangedSettings EventHandler

    func Raise() {
        this.ChangedSettings?.Invoke(this, EventArgs.Empty)
    }
}`

        private func GetMethodName(reader MetadataReader, handle EntityHandle) string -> switch handle.Kind {
            case HandleKind.MethodDefinition: reader.GetString(
                reader.GetMethodDefinition(MethodDefinitionHandle(handle)).Name
            )
            case HandleKind.MemberReference: reader.GetString(
                reader.GetMemberReference(MemberReferenceHandle(handle)).Name
            )
            default: throw InvalidOperationException("Unexpected method handle: ${handle.Kind}")
        }

        private func Compile(
            source string,
            target string,
            contracts string? = nil,
            expectSuccess bool = true
        ) Issue2718CustomInterfaceEventEmitTests
            .CompilationArtifacts {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2718-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            var contractsPath string? = nil
            if contracts != nil {
                let contractsSourcePath = Path.Combine(directory, "contracts.gs")
                contractsPath = Path.Combine(directory, "Oahu.Core.dll")
                File.WriteAllText(contractsSourcePath, contracts)
                let contractsResult = RunCompiler(
                    []string{
                        "/out:" + contractsPath,
                        "/target:library",
                        "/targetframework:net10.0",
                        contractsSourcePath
                    }
                )
                Assert.True(contractsResult.ExitCode == 0, (`contract compile failed
` + "${contractsResult.Stdout}" + `
` + "${contractsResult.Stderr}"))
            }
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "Cli.App.dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{"/out:" + outputPath, "/target:" + target, "/targetframework:net10.0"}
            if contractsPath != nil {
                args.Add("/reference:" + contractsPath)
            }
            args.Add(sourcePath)
            let result = RunCompiler(args.ToArray())
            if expectSuccess {
                Assert.True(result.ExitCode == 0, (`compile failed
` + "${result.Stdout}" + `
` + "${result.Stderr}"))
            }
            return Issue2718CustomInterfaceEventEmitTests.CompilationArtifacts(
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
