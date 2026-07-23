// <copyright file="Issue2726NominalEventDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Reflection;
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
