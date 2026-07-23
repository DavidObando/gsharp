// <copyright file="Issue2726NominalEventDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2726: public events preserve nominal CLR delegate identity.</summary>
public sealed class Issue2726NominalEventDelegateEmitTests
{
    [Fact]
    public void StructuralEventHandlerEvents_ExposeNominalMetadataAndVerify()
    {
        const string source = """
            package Issue2726
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
            }
            """;

        using var artifacts = CompileGSharp(source, "NominalEvents.dll");
        IlVerifier.Verify(artifacts.OutputPath);

        var assembly = Assembly.LoadFrom(artifacts.OutputPath);
        var interfaceEvent = assembly.GetType("Issue2726.IChanges")!.GetEvent("InterfaceChanged")!;
        var raiser = assembly.GetType("Issue2726.Raiser")!;

        AssertEventAbi(interfaceEvent, typeof(EventHandler));
        AssertEventAbi(raiser.GetEvent("Changed")!, typeof(EventHandler));
        AssertEventAbi(raiser.GetEvent("ExplicitChanged")!, typeof(EventHandler));
        AssertEventAbi(raiser.GetEvent("DetailedChanged")!, typeof(EventHandler<ListChangedEventArgs>));
        AssertEventAbi(
            raiser.GetEvent("LocalChanged")!,
            typeof(EventHandler<>).MakeGenericType(assembly.GetType("Issue2726.LocalArgs")!));
        Assert.Equal(
            new[] { typeof(object), typeof(EventArgs) },
            raiser.GetEvent("ExplicitChanged")!.GetRaiseMethod()!
                .GetParameters()
                .Select(parameter => parameter.ParameterType)
                .ToArray());
        Assert.Equal(
            typeof(Action<object, EventArgs>),
            raiser.GetMethod("KeepStructural")!.GetParameters().Single().ParameterType);
    }

    [Fact]
    public void UnrelatedStructuralAndNamedDelegates_AreNotCanonicalized()
    {
        const string source = """
            package Issue2726.Negative
            import System

            class Raiser {
                event NonNullableSender (object, EventArgs) -> void
                event OtherPayload (object?, string) -> void
                event NamedAction Action[object, EventArgs]
            }
            """;

        using var artifacts = CompileGSharp(source, "NegativeEvents.dll");
        IlVerifier.Verify(artifacts.OutputPath);

        var raiser = Assembly.LoadFrom(artifacts.OutputPath).GetType("Issue2726.Negative.Raiser")!;
        AssertEventAbi(raiser.GetEvent("NonNullableSender")!, typeof(Action<object, EventArgs>));
        AssertEventAbi(raiser.GetEvent("OtherPayload")!, typeof(Action<object, string>));
        AssertEventAbi(raiser.GetEvent("NamedAction")!, typeof(Action<object, EventArgs>));
    }

    [Fact]
    public void ConstrainedGenericStructuralEvent_PreservesOpenAbiAndLambdaRuns()
    {
        const string source = """
            package Issue2726.Generic
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
            }
            """;

        using var artifacts = CompileGSharp(source, "GenericEvents.dll");
        IlVerifier.Verify(artifacts.OutputPath);

        var assembly = Assembly.LoadFrom(artifacts.OutputPath);
        var openRaiser = assembly.GetType("Issue2726.Generic.GenericRaiser`1")!;
        var typeParameter = openRaiser.GetGenericArguments().Single();
        var expectedHandler = typeof(EventHandler<>).MakeGenericType(typeParameter);
        AssertEventAbi(openRaiser.GetEvent("Changed")!, expectedHandler);
        AssertEventAbi(openRaiser.GetEvent("NominalChanged")!, expectedHandler);

        var openUnconstrained = assembly.GetType("Issue2726.Generic.UnconstrainedRaiser`1")!;
        var unconstrainedParameter = openUnconstrained.GetGenericArguments().Single();
        AssertEventAbi(
            openUnconstrained.GetEvent("Changed")!,
            typeof(Action<,>).MakeGenericType(typeof(object), unconstrainedParameter));

        var localArgs = assembly.GetType("Issue2726.Generic.LocalArgs")!;
        var closedRaiser = openRaiser.MakeGenericType(localArgs);
        var instance = Activator.CreateInstance(closedRaiser)!;
        Assert.Equal(1, closedRaiser.GetMethod("Run")!.Invoke(
            instance,
            new[] { Activator.CreateInstance(localArgs) }));
    }

    [Fact]
    public void ExplicitRaiseAccessors_ExposeIdenticalParameterSignaturesInOutAndRefoutMetadata()
    {
        // Issue #2726 follow-up: canonicalized nominal `EventHandler`/`EventHandler<T>`
        // events with explicit `raise` accessors must expose the same raise_X
        // parameter signature in the implementation (`/out`) assembly and the
        // reference (`/refout`, MetadataOnly) assembly. The metadata-only fallback
        // previously emitted zero-parameter raise_X methods because it only
        // recognized `FunctionTypeSymbol` handler types, not canonicalized nominal
        // CLR delegates.
        const string source = """
            package Issue2726.Refout
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
            }
            """;

        using var artifacts = CompileGSharpWithReference(source, "RefoutRaise.dll");
        IlVerifier.Verify(artifacts.OutputPath);

        var implementationSignatures = ReadRaiseSignatureBlobs(artifacts.OutputPath);
        var referenceSignatures = ReadRaiseSignatureBlobs(artifacts.ReferenceOutputPath);

        var expectedRaiseMethods = new[]
        {
            "Raiser.raise_ExplicitChanged",
            "Raiser.raise_ExplicitLocal",
            "Raiser.raise_NominalChanged",
            "GenericRaiser`1.raise_OpenChanged",
        };

        // The implementation assembly emits each explicit raise_X accessor.
        Assert.Equal(
            expectedRaiseMethods.OrderBy(name => name, StringComparer.Ordinal),
            implementationSignatures.Keys.OrderBy(name => name, StringComparer.Ordinal));

        // The reference assembly exposes the identical set of raise_X accessors...
        Assert.Equal(
            implementationSignatures.Keys.OrderBy(name => name, StringComparer.Ordinal),
            referenceSignatures.Keys.OrderBy(name => name, StringComparer.Ordinal));

        // ...with byte-for-byte identical parameter signatures, and a non-zero
        // parameter count proving the metadata-only fallback no longer collapses
        // canonicalized nominal handlers to a zero-parameter shape.
        foreach (var raiseMethod in expectedRaiseMethods)
        {
            var implementationSignature = implementationSignatures[raiseMethod];
            var referenceSignature = referenceSignatures[raiseMethod];
            Assert.Equal(implementationSignature.Blob, referenceSignature.Blob);
            Assert.Equal(2, implementationSignature.ParameterCount);
            Assert.Equal(2, referenceSignature.ParameterCount);
        }

        // Tie the shared metadata back to concrete CLR parameter types on the
        // loadable implementation assembly for the closed shapes.
        var assembly = Assembly.LoadFrom(artifacts.OutputPath);
        var raiser = assembly.GetType("Issue2726.Refout.Raiser")!;
        var localArgs = assembly.GetType("Issue2726.Refout.LocalArgs")!;
        Assert.Equal(
            new[] { typeof(object), typeof(EventArgs) },
            raiser.GetEvent("ExplicitChanged")!.GetRaiseMethod()!
                .GetParameters().Select(parameter => parameter.ParameterType).ToArray());
        Assert.Equal(
            new[] { typeof(object), localArgs },
            raiser.GetEvent("ExplicitLocal")!.GetRaiseMethod()!
                .GetParameters().Select(parameter => parameter.ParameterType).ToArray());
        Assert.Equal(
            new[] { typeof(object), localArgs },
            raiser.GetEvent("NominalChanged")!.GetRaiseMethod()!
                .GetParameters().Select(parameter => parameter.ParameterType).ToArray());
    }

    [Fact]
    public void Override_Wins_Over_Inner_Quality()
    {
        using var artifacts = CompileBaselineConsumerAndMigratedContract();
        using var loaded = LoadConsumer(artifacts);

        var inner = Activator.CreateInstance(loaded.Contract.GetType("Oahu.Core.DownloadSettings")!, "inner")!;
        var wrapper = Activator.CreateInstance(
            loaded.Contract.GetType("Oahu.Core.PerJobDownloadSettings")!,
            inner,
            "override")!;

        Assert.Equal("override", wrapper.GetType().GetMethod("GetQuality")!.Invoke(wrapper, null));
    }

    [Fact]
    public void ChangedSettings_Subscription_Forwards_To_Inner()
    {
        using var artifacts = CompileBaselineConsumerAndMigratedContract();
        using var loaded = LoadConsumer(artifacts);

        var innerType = loaded.Contract.GetType("Oahu.Core.DownloadSettings")!;
        var inner = Activator.CreateInstance(innerType, "inner")!;
        var wrapper = Activator.CreateInstance(
            loaded.Contract.GetType("Oahu.Core.PerJobDownloadSettings")!,
            new object[] { inner, null })!;
        var hits = 0;
        EventHandler handler = (_, _) => hits++;

        wrapper.GetType().GetEvent("ChangedSettings")!.AddEventHandler(wrapper, handler);
        innerType.GetMethod("Raise")!.Invoke(inner, null);
        wrapper.GetType().GetEvent("ChangedSettings")!.RemoveEventHandler(wrapper, handler);
        innerType.GetMethod("Raise")!.Invoke(inner, null);

        Assert.Equal(1, hits);
    }

    [Fact]
    public void BaselineCompiledCSharpConsumer_BindsAndRunsAgainstMigratedContract()
    {
        using var artifacts = CompileBaselineConsumerAndMigratedContract();
        using var loaded = LoadConsumer(artifacts);

        var innerType = loaded.Contract.GetType("Oahu.Core.DownloadSettings")!;
        var inner = Activator.CreateInstance(innerType, "inner")!;
        var wrapper = Activator.CreateInstance(
            loaded.Consumer.GetType("App.PerJobDownloadSettings")!,
            new object[] { inner, null })!;
        var hits = 0;
        EventHandler handler = (_, _) => hits++;

        wrapper.GetType().GetEvent("ChangedSettings")!.AddEventHandler(wrapper, handler);
        innerType.GetMethod("Raise")!.Invoke(inner, null);

        Assert.Equal(1, hits);
    }

    private static void AssertEventAbi(EventInfo @event, Type expectedHandler)
    {
        Assert.Equal(expectedHandler, @event.EventHandlerType);
        Assert.Equal(expectedHandler, @event.GetAddMethod()!.GetParameters().Single().ParameterType);
        Assert.Equal(expectedHandler, @event.GetRemoveMethod()!.GetParameters().Single().ParameterType);
    }

    private static CrossAssemblyArtifacts CompileBaselineConsumerAndMigratedContract()
    {
        var directory = ArtifactDirectory();
        var baselinePath = Path.Combine(directory, "baseline", "Oahu.Core.dll");
        var consumerPath = Path.Combine(directory, "consumer", "App.dll");
        var migratedPath = Path.Combine(directory, "migrated", "Oahu.Core.dll");
        Directory.CreateDirectory(Path.GetDirectoryName(baselinePath)!);
        Directory.CreateDirectory(Path.GetDirectoryName(consumerPath)!);
        Directory.CreateDirectory(Path.GetDirectoryName(migratedPath)!);

        EmitCSharp(
            """
            using System;

            namespace Oahu.Core;

            public interface IDownloadSettings
            {
                event EventHandler ChangedSettings;
                string GetQuality();
            }
            """,
            baselinePath);

        EmitCSharp(
            """
            using System;
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
            }
            """,
            consumerPath,
            baselinePath);

        const string migratedSource = """
            package Oahu.Core
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
            }
            """;

        var sourcePath = Path.Combine(directory, "migrated", "Oahu.Core.gs");
        File.WriteAllText(sourcePath, migratedSource);
        CompileGSharpFile(sourcePath, migratedPath);

        IlVerifier.Verify(migratedPath);
        IlVerifier.Verify(consumerPath, additionalReferences: new[] { migratedPath });
        return new CrossAssemblyArtifacts(directory, consumerPath, migratedPath);
    }

    private static LoadedConsumer LoadConsumer(CrossAssemblyArtifacts artifacts)
    {
        var context = new AssemblyLoadContext("Issue2726-" + Guid.NewGuid().ToString("N"), isCollectible: true);
        context.Resolving += (_, name) => name.Name == "Oahu.Core"
            ? context.LoadFromAssemblyPath(artifacts.MigratedPath)
            : null;
        var contract = context.LoadFromAssemblyPath(artifacts.MigratedPath);
        var consumer = context.LoadFromAssemblyPath(artifacts.ConsumerPath);
        return new LoadedConsumer(context, contract, consumer);
    }

    private static CompilationArtifacts CompileGSharp(string source, string outputName)
    {
        var directory = ArtifactDirectory();
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, outputName);
        File.WriteAllText(sourcePath, source);
        CompileGSharpFile(sourcePath, outputPath);
        return new CompilationArtifacts(directory, outputPath);
    }

    private static ReferenceCompilationArtifacts CompileGSharpWithReference(string source, string outputName)
    {
        var directory = ArtifactDirectory();
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, outputName);
        var referenceOutputPath = Path.Combine(
            directory,
            Path.GetFileNameWithoutExtension(outputName) + ".ref" + Path.GetExtension(outputName));
        File.WriteAllText(sourcePath, source);
        var result = RunCompiler(new[]
        {
            "/out:" + outputPath,
            "/refout:" + referenceOutputPath,
            "/target:library",
            "/targetframework:net10.0",
            sourcePath,
        });
        Assert.True(result.ExitCode == 0, $"gsc failed:\n{result.Stdout}\n{result.Stderr}");
        return new ReferenceCompilationArtifacts(directory, outputPath, referenceOutputPath);
    }

    private static Dictionary<string, RaiseSignature> ReadRaiseSignatureBlobs(string assemblyPath)
    {
        var signatures = new Dictionary<string, RaiseSignature>(StringComparer.Ordinal);
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        foreach (var typeHandle in reader.TypeDefinitions)
        {
            var type = reader.GetTypeDefinition(typeHandle);
            var typeName = reader.GetString(type.Name);
            foreach (var methodHandle in type.GetMethods())
            {
                var method = reader.GetMethodDefinition(methodHandle);
                var methodName = reader.GetString(method.Name);
                if (!methodName.StartsWith("raise_", StringComparison.Ordinal))
                {
                    continue;
                }

                var blob = reader.GetBlobBytes(method.Signature);

                // ECMA-335 II.23.2.1: the second byte of a non-generic method
                // signature is the compressed parameter count (single-byte for the
                // small counts used here).
                signatures[$"{typeName}.{methodName}"] = new RaiseSignature(
                    Convert.ToHexString(blob),
                    blob[1]);
            }
        }

        return signatures;
    }

    private readonly record struct RaiseSignature(string Blob, int ParameterCount);

    private static void CompileGSharpFile(string sourcePath, string outputPath)
    {
        var result = RunCompiler(new[]
        {
            "/out:" + outputPath,
            "/target:library",
            "/targetframework:net10.0",
            sourcePath,
        });
        Assert.True(result.ExitCode == 0, $"gsc failed:\n{result.Stdout}\n{result.Stderr}");
    }

    private static void EmitCSharp(string source, string outputPath, params string[] additionalReferences)
    {
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Select(path => MetadataReference.CreateFromFile(path))
            .Concat(additionalReferences.Select(path => MetadataReference.CreateFromFile(path)));
        var compilation = CSharpCompilation.Create(
            Path.GetFileNameWithoutExtension(outputPath),
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var result = compilation.Emit(outputPath);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
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

    private static string ArtifactDirectory()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2726-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private sealed class CompilationArtifacts : IDisposable
    {
        public CompilationArtifacts(string directory, string outputPath)
        {
            Directory = directory;
            OutputPath = outputPath;
        }

        public string Directory { get; }

        public string OutputPath { get; }

        public void Dispose() => DeleteDirectory(Directory);
    }

    private sealed class ReferenceCompilationArtifacts : IDisposable
    {
        public ReferenceCompilationArtifacts(string directory, string outputPath, string referenceOutputPath)
        {
            Directory = directory;
            OutputPath = outputPath;
            ReferenceOutputPath = referenceOutputPath;
        }

        public string Directory { get; }

        public string OutputPath { get; }

        public string ReferenceOutputPath { get; }

        public void Dispose() => DeleteDirectory(Directory);
    }

    private sealed class CrossAssemblyArtifacts : IDisposable
    {
        public CrossAssemblyArtifacts(string directory, string consumerPath, string migratedPath)
        {
            Directory = directory;
            ConsumerPath = consumerPath;
            MigratedPath = migratedPath;
        }

        public string Directory { get; }

        public string ConsumerPath { get; }

        public string MigratedPath { get; }

        public void Dispose() => DeleteDirectory(Directory);
    }

    private sealed class LoadedConsumer : IDisposable
    {
        public LoadedConsumer(AssemblyLoadContext context, Assembly contract, Assembly consumer)
        {
            Context = context;
            Contract = contract;
            Consumer = consumer;
        }

        public AssemblyLoadContext Context { get; }

        public Assembly Contract { get; }

        public Assembly Consumer { get; }

        public void Dispose() => Context.Unload();
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
}
