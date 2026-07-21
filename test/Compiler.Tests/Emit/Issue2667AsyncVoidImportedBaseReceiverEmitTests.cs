// <copyright file="Issue2667AsyncVoidImportedBaseReceiverEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2667: imported non-virtual base calls in async instance methods must
/// run through a receiver-safe forwarder instead of using the hoisted
/// <c>&lt;&gt;4__this</c> field directly as the call's special <c>this</c>.
/// </summary>
public sealed class Issue2667AsyncVoidImportedBaseReceiverEmitTests
{
    private const string FixtureSource = """
        using System;

        namespace Avalonia.Controls;

        public class Window
        {
            public void Open() => OnOpened(EventArgs.Empty);
            protected virtual void OnOpened(EventArgs e) => Console.WriteLine("base-opened");
            public virtual string Describe() => "base";
        }
        """;

    [Fact]
    public void AppMainWindowAsyncVoidOnOpened_MoveNext_ILVerifiesAndRuns()
    {
        using var fixture = new Fixture();
        var result = fixture.Compile("""
            package Oahu.App.Avalonia
            import System
            import System.Threading.Tasks
            import Avalonia.Controls

            open class MainWindow : Window {
                protected override func OnOpened(e EventArgs) {
                    __asyncVoid_OnOpened(e).GetAwaiter().GetResult()
                }

                private async func __asyncVoid_OnOpened(e EventArgs) {
                    base.OnOpened(e)
                    await Task.CompletedTask
                    Console.WriteLine("async-opened")
                }
            }

            MainWindow().Open()
            """);

        Assert.Equal("base-opened\nasync-opened\n", fixture.Run(result.OutputPath));

        var assembly = Assembly.LoadFrom(result.OutputPath);
        var mainWindow = assembly.GetType("Oahu.App.Avalonia.MainWindow")!;
        Assert.Contains(
            mainWindow.GetMethods(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly),
            method => method.Name.StartsWith("<>n__", StringComparison.Ordinal));
        Assert.Contains(
            mainWindow.GetNestedTypes(BindingFlags.NonPublic),
            type => type.Name.Contains("<__asyncVoid_OnOpened>d__", StringComparison.Ordinal));
        IlVerifier.Verify(result.OutputPath, additionalReferences: new[] { fixture.LibraryPath });
    }

    [Fact]
    public void NonAsyncImportedBaseCall_DoesNotSynthesizeForwarder()
    {
        using var fixture = new Fixture();
        var result = fixture.Compile("""
            package Issue2667.Sync
            import System
            import Avalonia.Controls

            open class MainWindow : Window {
                protected override func OnOpened(e EventArgs) {
                    base.OnOpened(e)
                    Console.WriteLine("sync-opened")
                }
            }

            MainWindow().Open()
            """);

        Assert.Equal("base-opened\nsync-opened\n", fixture.Run(result.OutputPath));
        IlVerifier.Verify(result.OutputPath, additionalReferences: new[] { fixture.LibraryPath });
        AssertNoForwarder(result.OutputPath, "Issue2667.Sync.MainWindow");
    }

    [Fact]
    public void AsyncOrdinaryVirtualCall_PreservesDispatchWithoutForwarder()
    {
        using var fixture = new Fixture();
        var result = fixture.Compile("""
            package Issue2667.Virtual
            import System
            import System.Threading.Tasks
            import Avalonia.Controls

            open class MainWindow : Window {
                override func Describe() string -> "derived"

                public async func DescribeAsync() string {
                    await Task.CompletedTask
                    return Describe()
                }
            }

            Console.WriteLine(MainWindow().DescribeAsync().Result)
            """);

        Assert.Equal("derived\n", fixture.Run(result.OutputPath));
        IlVerifier.Verify(result.OutputPath, additionalReferences: new[] { fixture.LibraryPath });
        AssertNoForwarder(result.OutputPath, "Issue2667.Virtual.MainWindow");
    }

    private static void AssertNoForwarder(string assemblyPath, string typeName)
    {
        var type = Assembly.LoadFrom(assemblyPath).GetType(typeName)!;
        Assert.DoesNotContain(
            type.GetMethods(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly),
            method => method.Name.StartsWith("<>n__", StringComparison.Ordinal));
    }

    private sealed class Fixture : IDisposable
    {
        private readonly string directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2667AsyncVoidImportedBaseReceiverEmitTests),
            Guid.NewGuid().ToString("N"));

        public Fixture()
        {
            Directory.CreateDirectory(directory);
            LibraryPath = Path.Combine(directory, "Avalonia.Controls.dll");
            EmitLibrary(LibraryPath);
        }

        public string LibraryPath { get; }

        public CompileResult Compile(string source)
        {
            var sourcePath = Path.Combine(directory, "App.gs");
            var outputPath = Path.Combine(directory, "App.dll");
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
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/reference:" + LibraryPath,
                    "/nowarn:GS9100",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(exitCode == 0, $"gsc failed:\n{stdout}\n{stderr}");
            return new CompileResult(outputPath);
        }

        public string Run(string assemblyPath)
        {
            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
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
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\n{stderr}");
            return stdout.Replace("\r\n", "\n", StringComparison.Ordinal);
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }

        private static void EmitLibrary(string path)
        {
            var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
                .Split(Path.PathSeparator)
                .Select(file => MetadataReference.CreateFromFile(file));
            var compilation = CSharpCompilation.Create(
                "Avalonia.Controls",
                new[] { CSharpSyntaxTree.ParseText(FixtureSource) },
                references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            var result = compilation.Emit(path);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }
    }

    private sealed record CompileResult(string OutputPath);
}
