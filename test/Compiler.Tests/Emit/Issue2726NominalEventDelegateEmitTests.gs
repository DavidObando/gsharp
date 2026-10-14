// <copyright file="Issue2726NominalEventDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.ComponentModel
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2726: public events preserve nominal CLR delegate identity.
class Issue2726NominalEventDelegateEmitTests {
    @Fact
    func StructuralEventHandlerEvents_ExposeNominalMetadataAndVerify() {
        const source = `package Issue2726
import System
import System.ComponentModel

interface IChanges {
    event InterfaceChanged (object?, EventArgs) -> void
}

class LocalArgs : EventArgs { }

class Raiser {
    event Changed (object?, EventArgs) -> void

    event ExplicitChanged (object?, EventArgs) -> void {
        add { }
        remove { }
        raise { }
    }

    event DetailedChanged (object?, ListChangedEventArgs) -> void
    event LocalChanged (object?, LocalArgs) -> void

    func KeepStructural(callback (object?, EventArgs) -> void) { }

    func SubscribeGenericHandlers() {
        DetailedChanged += (sender object?, args ListChangedEventArgs) -> { }
        LocalChanged += (sender object?, args LocalArgs) -> { }
    }
}`
        using let artifacts = CompileGSharp(source, "NominalEvents.dll")
        IlVerifier.Verify(artifacts.OutputPath)
        let assembly = EmittedFixture.Load(artifacts.OutputPath)
        let interfaceEvent = assembly.GetType("Issue2726.IChanges")!!.GetEvent("InterfaceChanged")!!
        let raiser = assembly.GetType("Issue2726.Raiser")!!
        AssertEventAbi(interfaceEvent, typeof(EventHandler))
        AssertEventAbi(raiser.GetEvent("Changed")!!, typeof(EventHandler))
        AssertEventAbi(raiser.GetEvent("ExplicitChanged")!!, typeof(EventHandler))
        AssertEventAbi(raiser.GetEvent("DetailedChanged")!!, typeof(EventHandler[ListChangedEventArgs]))
        AssertEventAbi(
            raiser.GetEvent("LocalChanged")!!,
            typeof(EventHandler[_]).MakeGenericType(assembly.GetType("Issue2726.LocalArgs")!!)
        )
        Assert.Equal(
            []Type{typeof(object), typeof(EventArgs)},
            raiser.GetEvent("ExplicitChanged")!!.GetRaiseMethod()!!
                .GetParameters()
                .Select((parameter ParameterInfo) -> parameter.ParameterType)
                .ToArray()
        )
        Assert.Equal(
            typeof((object, EventArgs) -> void),
            raiser.GetMethod("KeepStructural")!!.GetParameters().Single().ParameterType
        )
    }

    @Fact
    func UnrelatedStructuralAndNamedDelegates_AreNotCanonicalized() {
        const source = `package Issue2726.Negative
import System

class Raiser {
    event NonNullableSender (object, EventArgs) -> void
    event OtherPayload (object?, string) -> void
    event NamedAction Action[object, EventArgs]
}`
        using let artifacts = CompileGSharp(source, "NegativeEvents.dll")
        IlVerifier.Verify(artifacts.OutputPath)
        let raiser = EmittedFixture.Load(artifacts.OutputPath).GetType("Issue2726.Negative.Raiser")!!
        AssertEventAbi(raiser.GetEvent("NonNullableSender")!!, typeof((object, EventArgs) -> void))
        AssertEventAbi(raiser.GetEvent("OtherPayload")!!, typeof((object, string) -> void))
        AssertEventAbi(raiser.GetEvent("NamedAction")!!, typeof((object, EventArgs) -> void))
    }

    @Fact
    func ConstrainedGenericStructuralEvent_PreservesOpenAbiAndLambdaRuns() {
        const source = `package Issue2726.Generic
import System

class LocalArgs : EventArgs { }

class GenericRaiser[T EventArgs] {
    event Changed (object?, T) -> void
    event NominalChanged EventHandler[T]

    func Run(args T) int32 {
        var hits int32 = 0
        NominalChanged += (sender object?, value T) -> { hits += 1 }
        this.NominalChanged?.Invoke(this, args)
        return hits
    }
}

class UnconstrainedRaiser[T any] {
    event Changed (object?, T) -> void
}`
        using let artifacts = CompileGSharp(source, "GenericEvents.dll")
        IlVerifier.Verify(artifacts.OutputPath)
        let assembly = EmittedFixture.Load(artifacts.OutputPath)
        let openRaiser = assembly.GetType("Issue2726.Generic.GenericRaiser`1")!!
        let typeParameter = openRaiser.GetGenericArguments().Single()
        let expectedHandler = typeof(EventHandler[_]).MakeGenericType(typeParameter)
        AssertEventAbi(openRaiser.GetEvent("Changed")!!, expectedHandler)
        AssertEventAbi(openRaiser.GetEvent("NominalChanged")!!, expectedHandler)
        let openUnconstrained = assembly.GetType("Issue2726.Generic.UnconstrainedRaiser`1")!!
        let unconstrainedParameter = openUnconstrained.GetGenericArguments().Single()
        AssertEventAbi(
            openUnconstrained.GetEvent("Changed")!!,
            typeof(Action[_, _]).MakeGenericType(typeof(object), unconstrainedParameter)
        )
        let localArgs = assembly.GetType("Issue2726.Generic.LocalArgs")!!
        let closedRaiser = openRaiser.MakeGenericType(localArgs)
        let instance = Activator.CreateInstance(closedRaiser)!!
        Assert.Equal(1, closedRaiser.GetMethod("Run")!!.Invoke(instance, []object{Activator.CreateInstance(localArgs)}))
    }

    @Fact
    func ExplicitRaiseAccessors_ExposeIdenticalParameterSignaturesInOutAndRefoutMetadata() {
        // Issue #2726 follow-up: canonicalized nominal `EventHandler`/`EventHandler<T>`
        // events with explicit `raise` accessors must expose the same raise_X
        // parameter signature in the implementation (`/out`) assembly and the
        // reference (`/refout`, MetadataOnly) assembly. The metadata-only fallback
        // previously emitted zero-parameter raise_X methods because it only
        // recognized `FunctionTypeSymbol` handler types, not canonicalized nominal
        // CLR delegates.
        const source = `package Issue2726.Refout
import System

class LocalArgs : EventArgs { }

class Raiser {
    event ExplicitChanged (object?, EventArgs) -> void {
        add { }
        remove { }
        raise { }
    }

    event ExplicitLocal (object?, LocalArgs) -> void {
        add { }
        remove { }
        raise { }
    }

    event NominalChanged EventHandler[LocalArgs] {
        add { }
        remove { }
        raise { }
    }
}

class GenericRaiser[T EventArgs] {
    event OpenChanged EventHandler[T] {
        add { }
        remove { }
        raise { }
    }
}`
        using let artifacts = CompileGSharpWithReference(source, "RefoutRaise.dll")
        IlVerifier.Verify(artifacts.OutputPath)
        let implementationSignatures = ReadRaiseSignatureBlobs(artifacts.OutputPath)
        let referenceSignatures = ReadRaiseSignatureBlobs(artifacts.ReferenceOutputPath)
        let expectedRaiseMethods = []string{
            "Raiser.raise_ExplicitChanged",
            "Raiser.raise_ExplicitLocal",
            "Raiser.raise_NominalChanged",
            "GenericRaiser`1.raise_OpenChanged"
        }
        // The implementation assembly emits each explicit raise_X accessor.
        Assert.Equal(
            expectedRaiseMethods.OrderBy((name string) -> name, StringComparer.Ordinal),
            implementationSignatures.Keys.OrderBy((name string) -> name, StringComparer.Ordinal)
        )
        // The reference assembly exposes the identical set of raise_X accessors...
        Assert.Equal(
            implementationSignatures.Keys.OrderBy((name string) -> name, StringComparer.Ordinal),
            referenceSignatures.Keys.OrderBy((name string) -> name, StringComparer.Ordinal)
        )
        // ...with byte-for-byte identical parameter signatures, and a non-zero
        // parameter count proving the metadata-only fallback no longer collapses
        // canonicalized nominal handlers to a zero-parameter shape.
        for raiseMethod in expectedRaiseMethods {
            let implementationSignature = implementationSignatures[raiseMethod]
            let referenceSignature = referenceSignatures[raiseMethod]
            Assert.Equal(implementationSignature.Blob, referenceSignature.Blob)
            Assert.Equal(2, implementationSignature.ParameterCount)
            Assert.Equal(2, referenceSignature.ParameterCount)
        }
        // Tie the shared metadata back to concrete CLR parameter types on the
        // loadable implementation assembly for the closed shapes.
        let assembly = EmittedFixture.Load(artifacts.OutputPath)
        let raiser = assembly.GetType("Issue2726.Refout.Raiser")!!
        let localArgs = assembly.GetType("Issue2726.Refout.LocalArgs")!!
        Assert.Equal(
            []Type{typeof(object), typeof(EventArgs)},
            raiser.GetEvent("ExplicitChanged")!!.GetRaiseMethod()!!
                .GetParameters()
                .Select((parameter ParameterInfo) -> parameter.ParameterType)
                .ToArray()
        )
        Assert.Equal(
            []Type{typeof(object), localArgs},
            raiser.GetEvent("ExplicitLocal")!!.GetRaiseMethod()!!
                .GetParameters()
                .Select((parameter ParameterInfo) -> parameter.ParameterType)
                .ToArray()
        )
        Assert.Equal(
            []Type{typeof(object), localArgs},
            raiser.GetEvent("NominalChanged")!!.GetRaiseMethod()!!
                .GetParameters()
                .Select((parameter ParameterInfo) -> parameter.ParameterType)
                .ToArray()
        )
    }

    @Fact
    func Override_Wins_Over_Inner_Quality() {
        using let artifacts = CompileBaselineConsumerAndMigratedContract()
        using let loaded = LoadConsumer(artifacts)
        let inner = Activator.CreateInstance(loaded.Contract.GetType("Oahu.Core.DownloadSettings")!!, "inner")!!
        let wrapper = Activator.CreateInstance(
            loaded.Contract.GetType("Oahu.Core.PerJobDownloadSettings")!!,
            inner,
            "override"
        )!!
        Assert.Equal("override", wrapper.GetType().GetMethod("GetQuality")!!.Invoke(wrapper, nil))
    }

    @Fact
    func ChangedSettings_Subscription_Forwards_To_Inner() {
        using let artifacts = CompileBaselineConsumerAndMigratedContract()
        using let loaded = LoadConsumer(artifacts)
        let innerType = loaded.Contract.GetType("Oahu.Core.DownloadSettings")!!
        let inner = Activator.CreateInstance(innerType, "inner")!!
        let wrapper = Activator.CreateInstance(
            loaded.Contract.GetType("Oahu.Core.PerJobDownloadSettings")!!,
            []object? {inner, nil}
        )!!
        var hits = 0
        let handler EventHandler = (_ object?, _ EventArgs) -> hits++
        wrapper.GetType().GetEvent("ChangedSettings")!!.AddEventHandler(wrapper, handler)
        innerType.GetMethod("Raise")!!.Invoke(inner, nil)
        wrapper.GetType().GetEvent("ChangedSettings")!!.RemoveEventHandler(wrapper, handler)
        innerType.GetMethod("Raise")!!.Invoke(inner, nil)
        Assert.Equal(1, hits)
    }

    @Fact
    func BaselineCompiledCSharpConsumer_BindsAndRunsAgainstMigratedContract() {
        using let artifacts = CompileBaselineConsumerAndMigratedContract()
        using let loaded = LoadConsumer(artifacts)
        let innerType = loaded.Contract.GetType("Oahu.Core.DownloadSettings")!!
        let inner = Activator.CreateInstance(innerType, "inner")!!
        let wrapper = Activator.CreateInstance(
            loaded.Consumer.GetType("App.PerJobDownloadSettings")!!,
            []object? {inner, nil}
        )!!
        var hits = 0
        let handler EventHandler = (_ object?, _ EventArgs) -> hits++
        wrapper.GetType().GetEvent("ChangedSettings")!!.AddEventHandler(wrapper, handler)
        innerType.GetMethod("Raise")!!.Invoke(inner, nil)
        Assert.Equal(1, hits)
    }

    private data struct RaiseSignature(Blob string, ParameterCount int32) : IEquatable[RaiseSignature] { }

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

        func Dispose() -> Issue2726NominalEventDelegateEmitTests.DeleteDirectory(Directory)
    }

    private class ReferenceCompilationArtifacts : IDisposable {
        init(directory string, outputPath string, referenceOutputPath string) {
            Directory = directory
            OutputPath = outputPath
            ReferenceOutputPath = referenceOutputPath
        }

        prop Directory string {
            get;
        }

        prop OutputPath string {
            get;
        }

        prop ReferenceOutputPath string {
            get;
        }

        func Dispose() -> Issue2726NominalEventDelegateEmitTests.DeleteDirectory(Directory)
    }

    private class CrossAssemblyArtifacts : IDisposable {
        init(directory string, consumerPath string, migratedPath string) {
            Directory = directory
            ConsumerPath = consumerPath
            MigratedPath = migratedPath
        }

        prop Directory string {
            get;
        }

        prop ConsumerPath string {
            get;
        }

        prop MigratedPath string {
            get;
        }

        func Dispose() -> Issue2726NominalEventDelegateEmitTests.DeleteDirectory(Directory)
    }

    private class LoadedConsumer : IDisposable {
        init(context AssemblyLoadContext, contract Assembly, consumer Assembly) {
            Context = context
            Contract = contract
            Consumer = consumer
        }

        prop Context AssemblyLoadContext {
            get;
        }

        prop Contract Assembly {
            get;
        }

        prop Consumer Assembly {
            get;
        }

        func Dispose() -> Context.Unload()
    }

    shared {
        private func AssertEventAbi(event EventInfo?, expectedHandler Type) {
            Assert.Equal(expectedHandler, event!!.EventHandlerType)
            Assert.Equal(expectedHandler, event!!.GetAddMethod()!!.GetParameters().Single().ParameterType)
            Assert.Equal(expectedHandler, event!!.GetRemoveMethod()!!.GetParameters().Single().ParameterType)
        }

        private func CompileBaselineConsumerAndMigratedContract() CrossAssemblyArtifacts {
            let directory = ArtifactDirectory()
            let baselinePath = Path.Combine(directory, "baseline", "Oahu.Core.dll")
            let consumerPath = Path.Combine(directory, "consumer", "App.dll")
            let migratedPath = Path.Combine(directory, "migrated", "Oahu.Core.dll")
            Directory.CreateDirectory(Path.GetDirectoryName(baselinePath)!!)
            Directory.CreateDirectory(Path.GetDirectoryName(consumerPath)!!)
            Directory.CreateDirectory(Path.GetDirectoryName(migratedPath)!!)
            EmitCSharp(`using System;

namespace Oahu.Core;

public interface IDownloadSettings
{
    event EventHandler ChangedSettings;
    string GetQuality();
}`, baselinePath)
            EmitCSharp(`using System;
using Oahu.Core;

namespace App;

public sealed class PerJobDownloadSettings
{
    private readonly IDownloadSettings inner;
    private readonly string quality;

    public PerJobDownloadSettings(IDownloadSettings inner, string quality)
    {
        this.inner = inner;
        this.quality = quality;
    }

    public string Quality => quality ?? inner.GetQuality();

    public event EventHandler ChangedSettings
    {
        add => inner.ChangedSettings += value;
        remove => inner.ChangedSettings -= value;
    }
}`, consumerPath, baselinePath)
            const migratedSource = `package Oahu.Core
import System

interface IDownloadSettings {
    event ChangedSettings (object?, EventArgs) -> void
    func GetQuality() string;
}

class DownloadSettings : IDownloadSettings {
    private var quality string
    event ChangedSettings (object?, EventArgs) -> void

    init(quality string) {
        this.quality = quality
    }

    func GetQuality() string { return quality }
    func Raise() { this.ChangedSettings?.Invoke(this, EventArgs.Empty) }
}

class PerJobDownloadSettings : IDownloadSettings {
    private var inner IDownloadSettings
    private var quality string?

    init(inner IDownloadSettings, quality string?) {
        this.inner = inner
        this.quality = quality
    }

    event ChangedSettings (object?, EventArgs) -> void {
        add { inner.ChangedSettings += value }
        remove { inner.ChangedSettings -= value }
    }

    func GetQuality() string { return quality ?? inner.GetQuality() }
}`
            let sourcePath = Path.Combine(directory, "migrated", "Oahu.Core.gs")
            File.WriteAllText(sourcePath, migratedSource)
            CompileGSharpFile(sourcePath, migratedPath)
            IlVerifier.Verify(migratedPath)
            IlVerifier.Verify(consumerPath, additionalReferences: []string{migratedPath})
            return CrossAssemblyArtifacts(directory, consumerPath, migratedPath)
        }

        private func LoadConsumer(artifacts CrossAssemblyArtifacts) LoadedConsumer {
            let context = AssemblyLoadContext("Issue2726-" + Guid.NewGuid().ToString("N"), isCollectible: true)
            context.Resolving += (_ AssemblyLoadContext, name AssemblyName) -> if name.Name == "Oahu.Core" {
                context.LoadFromAssemblyPath(artifacts.MigratedPath)
            } else {
                default(Assembly?)
            }
            let contract = context.LoadFromAssemblyPath(artifacts.MigratedPath)
            let consumer = context.LoadFromAssemblyPath(artifacts.ConsumerPath)
            return LoadedConsumer(context, contract, consumer)
        }

        private func CompileGSharp(source string, outputName string) Issue2726NominalEventDelegateEmitTests
            .CompilationArtifacts {
            let directory = ArtifactDirectory()
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, outputName)
            File.WriteAllText(sourcePath, source)
            CompileGSharpFile(sourcePath, outputPath)
            return Issue2726NominalEventDelegateEmitTests.CompilationArtifacts(directory, outputPath)
        }

        private func CompileGSharpWithReference(source string, outputName string) ReferenceCompilationArtifacts {
            let directory = ArtifactDirectory()
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, outputName)
            let referenceOutputPath = Path.Combine(
                directory,
                Path.GetFileNameWithoutExtension(outputName) + ".ref" + Path.GetExtension(outputName)
            )
            File.WriteAllText(sourcePath, source)
            let result = RunCompiler(
                []string{
                    "/out:" + outputPath,
                    "/refout:" + referenceOutputPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    sourcePath
                }
            )
            Assert.True(result.ExitCode == 0, (`gsc failed:
` + "${result.Stdout}" + `
` + "${result.Stderr}"))
            return ReferenceCompilationArtifacts(directory, outputPath, referenceOutputPath)
        }

        private func ReadRaiseSignatureBlobs(assemblyPath string) Dictionary[string, RaiseSignature] {
            let signatures = Dictionary[string, RaiseSignature](StringComparer.Ordinal)
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            for typeHandle in reader.TypeDefinitions {
                let type = reader.GetTypeDefinition(typeHandle)
                let typeName = reader.GetString(type.Name)
                for methodHandle in type.GetMethods() {
                    let method = reader.GetMethodDefinition(methodHandle)
                    let methodName = reader.GetString(method.Name)
                    if !methodName.StartsWith("raise_", StringComparison.Ordinal) {
                        continue
                    }
                    let blob = reader.GetBlobBytes(method.Signature)
                    // ECMA-335 II.23.2.1: the second byte of a non-generic method
                    // signature is the compressed parameter count (single-byte for the
                    // small counts used here).
                    signatures["$typeName.$methodName"] = RaiseSignature(Convert.ToHexString(blob), blob[1])
                }
            }
            return signatures
        }

        private func CompileGSharpFile(sourcePath string, outputPath string) {
            let result = RunCompiler(
                []string{"/out:" + outputPath, "/target:library", "/targetframework:net10.0", sourcePath}
            )
            Assert.True(result.ExitCode == 0, (`gsc failed:
` + "${result.Stdout}" + `
` + "${result.Stderr}"))
        }

        private func EmitCSharp(source string, outputPath string, additionalReferences ...string) {
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!))
                .Split(Path.PathSeparator)
                .Select((path string) -> MetadataReference.CreateFromFile(path))
                .Concat(additionalReferences.Select((path string) -> MetadataReference.CreateFromFile(path)))
            let compilation = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(outputPath),
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let result = compilation.Emit(outputPath)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
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

        private func ArtifactDirectory() string {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2726-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            return directory
        }

        private func DeleteDirectory(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }
}
