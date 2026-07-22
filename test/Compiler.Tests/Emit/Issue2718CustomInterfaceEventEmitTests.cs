// <copyright file="Issue2718CustomInterfaceEventEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2718: custom event accessors implement interface accessor slots.</summary>
public sealed class Issue2718CustomInterfaceEventEmitTests
{
    private const string DownloadSettingsContract = """
        package Oahu.Core
        import System

        interface IDownloadSettings {
            event ChangedSettings EventHandler
        }

        class DownloadSettings : IDownloadSettings {
            event ChangedSettings EventHandler

            func Raise() {
                this.ChangedSettings?.Invoke(this, EventArgs.Empty)
            }
        }
        """;

    [Fact]
    public void PerJobDownloadSettings_ImportedCustomEvent_HasExactMethodImplsAndDispatches()
    {
        const string source = """
            package Cli.App
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
            }
            """;

        using var artifacts = Compile(source, "exe", DownloadSettingsContract);
        Assert.Equal("1\n", Run(artifacts.OutputPath));
        IlVerifier.Verify(artifacts.OutputPath, additionalReferences: new[] { artifacts.ContractsPath });

        using var stream = File.OpenRead(artifacts.OutputPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var type = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(t => reader.GetString(t.Namespace) == "Cli.App"
                && reader.GetString(t.Name) == "PerJobDownloadSettings");
        var implementations = type.GetMethodImplementations()
            .Select(reader.GetMethodImplementation)
            .ToArray();

        Assert.Equal(2, implementations.Length);
        Assert.Equal(
            new[] { "add_ChangedSettings", "remove_ChangedSettings" },
            implementations
                .Select(i => GetMethodName(reader, i.MethodBody))
                .OrderBy(n => n)
                .ToArray());

        foreach (var implementation in implementations)
        {
            var method = reader.GetMethodDefinition((MethodDefinitionHandle)implementation.MethodBody);
            Assert.True((method.Attributes & MethodAttributes.Public) != 0);
            Assert.True((method.Attributes & MethodAttributes.Virtual) != 0);
        }

        var loadContext = new AssemblyLoadContext("Issue2718", isCollectible: true);
        loadContext.Resolving += (_, name) => name.Name == "Oahu.Core"
            ? loadContext.LoadFromAssemblyPath(artifacts.ContractsPath)
            : null;
        try
        {
            var assembly = loadContext.LoadFromAssemblyPath(artifacts.OutputPath);
            var implementationType = assembly.GetType("Cli.App.PerJobDownloadSettings")!;
            var interfaceType = implementationType.GetInterfaces()
                .Single(i => i.FullName == "Oahu.Core.IDownloadSettings");
            var interfaceMap = implementationType.GetInterfaceMap(interfaceType);
            Assert.Equal(
                new[] { "add_ChangedSettings", "remove_ChangedSettings" },
                interfaceMap.TargetMethods.Select(m => m.Name).OrderBy(n => n).ToArray());
            Assert.Equal(
                typeof(EventHandler),
                implementationType.GetEvent("ChangedSettings")!.EventHandlerType);
            Assert.All(
                interfaceMap.TargetMethods,
                method => Assert.Equal(typeof(EventHandler), method.GetParameters().Single().ParameterType));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void OahuCli_ActionOfAction_MethodGroup_BindsRunsAndIlVerifies()
    {
        const string contracts = """
            package Oahu.Core
            import System

            class AppShellOptions { }

            class TuiHost {
                shared {
                    func Run(options AppShellOptions?, registerRestore Action[Action]?) {
                        registerRestore!!(() -> Console.WriteLine("restored"))
                    }
                }
            }
            """;
        const string source = """
            package Oahu.Cli
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
            }
            """;

        using var artifacts = Compile(source, "exe", contracts);
        Assert.Equal("restored\n", Run(artifacts.OutputPath));
        IlVerifier.Verify(artifacts.OutputPath, additionalReferences: new[] { artifacts.ContractsPath });

        var loadContext = new AssemblyLoadContext("Issue2726", isCollectible: true);
        loadContext.Resolving += (_, name) => name.Name == "Oahu.Core"
            ? loadContext.LoadFromAssemblyPath(artifacts.ContractsPath)
            : null;
        try
        {
            var assembly = loadContext.LoadFromAssemblyPath(artifacts.OutputPath);
            var method = assembly.GetTypes()
                .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
                .Single(candidate => candidate.Name == "RegisterRestore");
            Assert.Equal(typeof(Action), method.GetParameters().Single().ParameterType);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void DistinctNamedDelegateOverloads_RemainAmbiguous()
    {
        const string contracts = """
            package DelegateContracts

            type FirstHandler = delegate func(value int32) void
            type SecondHandler = delegate func(value int32) void

            class Dispatcher {
                shared {
                    func Run(callback FirstHandler) { }
                    func Run(callback SecondHandler) { }
                }
            }
            """;
        const string source = """
            package DelegateConsumer
            import DelegateContracts

            class Handlers {
                shared {
                    func Handle(value int32) { }
                }
            }

            func Main() {
                Dispatcher.Run(Handlers.Handle)
            }
            """;

        using var artifacts = Compile(source, "library", contracts, expectSuccess: false);
        Assert.NotEqual(0, artifacts.ExitCode);
        var output = artifacts.Stdout + artifacts.Stderr;
        Assert.True(output.Contains("GS0160", StringComparison.Ordinal), output);
    }

    [Fact]
    public void InheritedGenericInterface_PrivateCustomEvent_EmitsMethodImplsAndIlVerifies()
    {
        const string source = """
            package Issue2718.Generic
            import System

            type ChangeHandler[T] = delegate func(value T) void

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

            """;

        using var artifacts = Compile(source, "library");
        IlVerifier.Verify(artifacts.OutputPath);

        using var stream = File.OpenRead(artifacts.OutputPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var type = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(t => reader.GetString(t.Name) == "Sink");
        Assert.Equal(2, type.GetMethodImplementations().Count);

        foreach (var name in new[] { "add_Changed", "remove_Changed" })
        {
            var method = type.GetMethods()
                .Select(reader.GetMethodDefinition)
                .Single(m => reader.GetString(m.Name) == name);
            Assert.True((method.Attributes & MethodAttributes.Private) != 0);
            Assert.True((method.Attributes & MethodAttributes.Virtual) != 0);
        }
    }

    [Fact]
    public void MismatchedCustomEventHandler_ReportsMissingInterfaceMember()
    {
        const string source = """
            package Issue2718.Negative

            type ChangeHandler[T] = delegate func(value T) void

            interface IChanges {
                event Changed ChangeHandler[int32]
            }

            class Bad : IChanges {
                event Changed ChangeHandler[string] {
                    add { }
                    remove { }
                }
            }
            """;

        using var artifacts = Compile(source, "library", expectSuccess: false);
        Assert.NotEqual(0, artifacts.ExitCode);
        var output = artifacts.Stdout + artifacts.Stderr;
        Assert.True(output.Contains("GS0187", StringComparison.Ordinal), output);
    }

    private static string GetMethodName(MetadataReader reader, EntityHandle handle)
        => handle.Kind switch
        {
            HandleKind.MethodDefinition => reader.GetString(reader.GetMethodDefinition((MethodDefinitionHandle)handle).Name),
            HandleKind.MemberReference => reader.GetString(reader.GetMemberReference((MemberReferenceHandle)handle).Name),
            _ => throw new InvalidOperationException($"Unexpected method handle: {handle.Kind}"),
        };

    private static CompilationArtifacts Compile(
        string source,
        string target,
        string contracts = null,
        bool expectSuccess = true)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2718-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        string contractsPath = null;
        if (contracts != null)
        {
            var contractsSourcePath = Path.Combine(directory, "contracts.gs");
            contractsPath = Path.Combine(directory, "Oahu.Core.dll");
            File.WriteAllText(contractsSourcePath, contracts);
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
        }

        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "Cli.App.dll");
        File.WriteAllText(sourcePath, source);
        var args = new System.Collections.Generic.List<string>
        {
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
        };
        if (contractsPath != null)
        {
            args.Add("/reference:" + contractsPath);
        }

        args.Add(sourcePath);
        var result = RunCompiler(args.ToArray());
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
