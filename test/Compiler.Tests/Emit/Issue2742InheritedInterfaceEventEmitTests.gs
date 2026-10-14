// <copyright file="Issue2742InheritedInterfaceEventEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.ComponentModel
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2742: inherited events must fill interface accessor slots.
class Issue2742InheritedInterfaceEventEmitTests {
    @Fact
    func OahuDownloadSettings_InheritedFieldLikeEvent_TypeLoadsDispatchesAndIlVerifies() {
        const source = `package Oahu.Core
import System

interface IDownloadSettings {
    event ChangedSettings (object?, EventArgs) -> void
    func Ping() int32;
    prop Flag bool { get; }
}

open class SettingsBase {
    event ChangedSettings (object?, EventArgs) -> void
    func Raise() { this.ChangedSettings?.Invoke(this, EventArgs.Empty) }
    func Ping() int32 -> 42
    prop Flag bool { get -> true }
}

class DownloadSettings : SettingsBase, IDownloadSettings {
}`
        using let artifacts = Compile(source)
        IlVerifier.Verify(artifacts.OutputPath)
        let assembly = EmittedFixture.Load(artifacts.OutputPath)
        let type = assembly.GetType("Oahu.Core.DownloadSettings", throwOnError: true)!!
        let instance = Activator.CreateInstance(type)!!
        let contract = assembly.GetType("Oahu.Core.IDownloadSettings", throwOnError: true)!!
        let map_ = type.GetInterfaceMap(contract)
        var hits = 0
        let handler EventHandler = (_ object?, _ EventArgs) -> hits++
        let changedSettings = contract.GetEvent("ChangedSettings")!!
        changedSettings.AddEventHandler(instance, handler)
        type.GetMethod("Raise")!!.Invoke(instance, nil)
        Assert.Equal(1, hits)
        Assert.Equal(typeof(EventHandler), changedSettings.EventHandlerType)
        Assert.Equal(
            []string{"add_ChangedSettings", "get_Flag", "Ping", "remove_ChangedSettings"},
            map_.TargetMethods.Select((method MethodInfo) -> method.Name).OrderBy((name string) -> name).ToArray()
        )
        Assert.All(
            map_.TargetMethods.Where((method MethodInfo) -> (method.Name is "Ping" or "get_Flag")),
            (method MethodInfo) -> Assert.Equal("SettingsBase", method.DeclaringType!!.Name)
        )
        Assert.All(
            map_.TargetMethods.Where(
                (method MethodInfo) -> method.Name.StartsWith("add_", StringComparison.Ordinal) ||
                    method
                    .Name
                    .StartsWith("remove_", StringComparison.Ordinal)
            ),
            (method MethodInfo) -> Assert.Equal("DownloadSettings", method.DeclaringType!!.Name)
        )
        Assert.Equal(
            []string{"add_ChangedSettings", "remove_ChangedSettings"},
            GetMethodImplBodyNames(artifacts.OutputPath, "DownloadSettings")
        )
    }

    @Fact
    func MultiLevelInheritedCustomEvent_TypeLoadsDispatchesAndIlVerifies() {
        const source = `package Issue2742.Custom

interface IChanges {
    event Changed (int32) -> void
}

open class Base {
    private var handler ((int32) -> void)?

    event Changed (int32) -> void {
        add { handler = value }
        remove { handler = nil }
    }

    func Raise(value int32) { handler?.Invoke(value) }
}

open class Middle : Base {
}

class Derived : Middle, IChanges {
}`
        using let artifacts = Compile(source)
        IlVerifier.Verify(artifacts.OutputPath)
        let assembly = EmittedFixture.Load(artifacts.OutputPath)
        let type = assembly.GetType("Issue2742.Custom.Derived", throwOnError: true)!!
        let contract = assembly.GetType("Issue2742.Custom.IChanges", throwOnError: true)!!
        let instance = Activator.CreateInstance(type)!!
        var observed = 0
        let handler(int32) -> void = (value int32) -> {
            observed = value
        }
        contract.GetEvent("Changed")!!.AddEventHandler(instance, handler)
        type.GetMethod("Raise")!!.Invoke(instance, []object{17})
        Assert.Equal(17, observed)
        Assert.All(
            type.GetInterfaceMap(contract).TargetMethods,
            (method MethodInfo) -> Assert.Equal("Derived", method.DeclaringType!!.Name)
        )
        Assert.Equal([]string{"add_Changed", "remove_Changed"}, GetMethodImplBodyNames(artifacts.OutputPath, "Derived"))
    }

    @Fact
    func ImportedInterface_InheritedFieldLikeEvent_TypeLoadsAndIlVerifies() {
        const source = `package Issue2742.Imported
import System.ComponentModel

open class Base {
    event PropertyChanged PropertyChangedEventHandler
}

class Derived : Base, INotifyPropertyChanged {
}`
        using let artifacts = Compile(source)
        IlVerifier.Verify(artifacts.OutputPath)
        let assembly = EmittedFixture.Load(artifacts.OutputPath)
        let type = assembly.GetType("Issue2742.Imported.Derived", throwOnError: true)!!
        let instance = Activator.CreateInstance(type)!!
        let map_ = type.GetInterfaceMap(typeof(INotifyPropertyChanged))
        Assert.NotNull(instance)
        Assert.All(map_.TargetMethods, (method MethodInfo) -> Assert.Equal("Derived", method.DeclaringType!!.Name))
        Assert.Equal(
            []string{"add_PropertyChanged", "remove_PropertyChanged"},
            GetMethodImplBodyNames(artifacts.OutputPath, "Derived")
        )
    }

    private class CompilationArtifacts : IDisposable {
        init(directory string, outputPath string) {
            Directory = directory
            OutputPath = outputPath
        }

        prop Directory string {
            get;
        }

        prop OutputPath string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(Directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private func GetMethodImplBodyNames(assemblyPath string, typeName string)[]string {
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let type = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single((definition TypeDefinition) -> reader.GetString(definition.Name) == typeName)
            return type
                .GetMethodImplementations()
                .Select(reader.GetMethodImplementation)
                .Select((implementation MethodImplementation) -> GetMethodName(reader, implementation.MethodBody))
                .OrderBy((name string) -> name)
                .ToArray()
        }

        private func GetMethodName(reader MetadataReader, handle EntityHandle) string -> switch handle.Kind {
            case HandleKind.MethodDefinition: reader.GetString(
                reader.GetMethodDefinition(MethodDefinitionHandle(handle)).Name
            )
            case HandleKind.MemberReference: reader.GetString(
                reader.GetMemberReference(MemberReferenceHandle(handle)).Name
            )
            default: throw InvalidOperationException("Unexpected method handle: ${handle.Kind}")
        }

        private func Compile(source string) Issue2742InheritedInterfaceEventEmitTests.CompilationArtifacts {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2742-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:library", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, (`compile failed
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return Issue2742InheritedInterfaceEventEmitTests.CompilationArtifacts(directory, outputPath)
        }
    }
}
