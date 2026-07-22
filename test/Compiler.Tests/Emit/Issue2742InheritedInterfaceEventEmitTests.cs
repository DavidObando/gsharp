// <copyright file="Issue2742InheritedInterfaceEventEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2742: inherited events must fill interface accessor slots.</summary>
public sealed class Issue2742InheritedInterfaceEventEmitTests
{
    [Fact]
    public void OahuDownloadSettings_InheritedFieldLikeEvent_TypeLoadsDispatchesAndIlVerifies()
    {
        const string source = """
            package Oahu.Core
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
            }
            """;

        using var artifacts = Compile(source);
        IlVerifier.Verify(artifacts.OutputPath);

        var assembly = Assembly.Load(File.ReadAllBytes(artifacts.OutputPath));
        var type = assembly.GetType("Oahu.Core.DownloadSettings", throwOnError: true)!;
        var instance = Activator.CreateInstance(type)!;
        var contract = assembly.GetType("Oahu.Core.IDownloadSettings", throwOnError: true)!;
        var map = type.GetInterfaceMap(contract);

        var hits = 0;
        Action<object, EventArgs> handler = (_, _) => hits++;
        contract.GetEvent("ChangedSettings")!.AddEventHandler(instance, handler);
        type.GetMethod("Raise")!.Invoke(instance, null);

        Assert.Equal(1, hits);
        Assert.Equal(
            new[] { "add_ChangedSettings", "get_Flag", "Ping", "remove_ChangedSettings" },
            map.TargetMethods.Select(method => method.Name).OrderBy(name => name).ToArray());
        Assert.All(
            map.TargetMethods.Where(method => method.Name is "Ping" or "get_Flag"),
            method => Assert.Equal("SettingsBase", method.DeclaringType!.Name));
        Assert.All(
            map.TargetMethods.Where(method => method.Name.StartsWith("add_", StringComparison.Ordinal)
                || method.Name.StartsWith("remove_", StringComparison.Ordinal)),
            method => Assert.Equal("DownloadSettings", method.DeclaringType!.Name));
        Assert.Equal(
            new[] { "add_ChangedSettings", "remove_ChangedSettings" },
            GetMethodImplBodyNames(artifacts.OutputPath, "DownloadSettings"));
    }

    [Fact]
    public void MultiLevelInheritedCustomEvent_TypeLoadsDispatchesAndIlVerifies()
    {
        const string source = """
            package Issue2742.Custom

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
            }
            """;

        using var artifacts = Compile(source);
        IlVerifier.Verify(artifacts.OutputPath);

        var assembly = Assembly.Load(File.ReadAllBytes(artifacts.OutputPath));
        var type = assembly.GetType("Issue2742.Custom.Derived", throwOnError: true)!;
        var contract = assembly.GetType("Issue2742.Custom.IChanges", throwOnError: true)!;
        var instance = Activator.CreateInstance(type)!;
        var observed = 0;
        Action<int> handler = value => observed = value;
        contract.GetEvent("Changed")!.AddEventHandler(instance, handler);
        type.GetMethod("Raise")!.Invoke(instance, new object[] { 17 });

        Assert.Equal(17, observed);
        Assert.All(type.GetInterfaceMap(contract).TargetMethods, method => Assert.Equal("Derived", method.DeclaringType!.Name));
        Assert.Equal(
            new[] { "add_Changed", "remove_Changed" },
            GetMethodImplBodyNames(artifacts.OutputPath, "Derived"));
    }

    [Fact]
    public void ImportedInterface_InheritedFieldLikeEvent_TypeLoadsAndIlVerifies()
    {
        const string source = """
            package Issue2742.Imported
            import System.ComponentModel

            open class Base {
                event PropertyChanged PropertyChangedEventHandler
            }

            class Derived : Base, INotifyPropertyChanged {
            }
            """;

        using var artifacts = Compile(source);
        IlVerifier.Verify(artifacts.OutputPath);

        var assembly = Assembly.Load(File.ReadAllBytes(artifacts.OutputPath));
        var type = assembly.GetType("Issue2742.Imported.Derived", throwOnError: true)!;
        var instance = Activator.CreateInstance(type)!;
        var map = type.GetInterfaceMap(typeof(INotifyPropertyChanged));

        Assert.NotNull(instance);
        Assert.All(map.TargetMethods, method => Assert.Equal("Derived", method.DeclaringType!.Name));
        Assert.Equal(
            new[] { "add_PropertyChanged", "remove_PropertyChanged" },
            GetMethodImplBodyNames(artifacts.OutputPath, "Derived"));
    }

    private static string[] GetMethodImplBodyNames(string assemblyPath, string typeName)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var type = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(definition => reader.GetString(definition.Name) == typeName);
        return type.GetMethodImplementations()
            .Select(reader.GetMethodImplementation)
            .Select(implementation => GetMethodName(reader, implementation.MethodBody))
            .OrderBy(name => name)
            .ToArray();
    }

    private static string GetMethodName(MetadataReader reader, EntityHandle handle)
        => handle.Kind switch
        {
            HandleKind.MethodDefinition => reader.GetString(reader.GetMethodDefinition((MethodDefinitionHandle)handle).Name),
            HandleKind.MemberReference => reader.GetString(reader.GetMemberReference((MemberReferenceHandle)handle).Name),
            _ => throw new InvalidOperationException($"Unexpected method handle: {handle.Kind}"),
        };

    private static CompilationArtifacts Compile(string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2742-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:library",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(
            exitCode == 0,
            $"compile failed\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return new CompilationArtifacts(directory, outputPath);
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
