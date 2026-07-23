// <copyright file="Issue2786AsyncIteratorCoalesceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2786AsyncIteratorCoalesceEmitTests
{
    [Fact]
    public void AsyncIteratorCalls_KeepEnumerableTypeAcrossBranching_VerifyAndRun()
    {
        const string source = """
            package Issue2786
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            class Streams {
                async func InstanceEmpty() IAsyncEnumerable[int32] {
                    await Task.CompletedTask
                }
                async func InstanceOne() IAsyncEnumerable[int32] {
                    await Task.CompletedTask
                    yield 1
                }
                shared {
                    async func Empty() IAsyncEnumerable[int32] {
                        await Task.CompletedTask
                    }
                    async func One() IAsyncEnumerable[int32] {
                        await Task.CompletedTask
                        yield 1
                    }
                    async func GenericEmpty[T any]() IAsyncEnumerable[T] {
                        await Task.CompletedTask
                    }
                    async func GenericOne[T any](value T) IAsyncEnumerable[T] {
                        await Task.CompletedTask
                        yield value
                    }
                    func SyncOne() IEnumerable[int32] {
                        yield 3
                    }
                    func SyncWrapper() IEnumerable[int32] {
                        Console.WriteLine("sync-wrapper")
                        return SyncOne()
                    }
                    async func Value() int32 {
                        await Task.CompletedTask
                        return 42
                    }
                    async func Work() {
                        await Task.CompletedTask
                    }
                }

                func LeftCall() IAsyncEnumerable[int32] -> Streams.Empty() ?? Streams.One()
                func RightCall(value IAsyncEnumerable[int32]?) IAsyncEnumerable[int32] -> value ?? Streams.Empty()
                func NullableReceiver(value Streams?) IAsyncEnumerable[int32] -> value?.InstanceOne() ?? Streams.Empty()
                func NullableEmpty(value Streams?) IAsyncEnumerable[int32] -> value?.InstanceEmpty() ?? Streams.One()
                func Direct() IAsyncEnumerable[int32] -> Streams.Empty()
                func Conditional(flag bool) IAsyncEnumerable[int32] -> flag ? Streams.Empty() : Streams.One()
                func GenericNested[T any](flag bool, value T) IAsyncEnumerable[T] -> flag ? Streams.GenericEmpty[T]() : Streams.GenericOne[T](value)
                func SyncControl(value IEnumerable[int32]?) IEnumerable[int32] -> value ?? Streams.SyncWrapper()
            }

            async func Count[T any](values IAsyncEnumerable[T]) int32 {
                var count = 0
                await for value in values { count += 1 }
                return count
            }
            func CountSync[T any](values IEnumerable[T]) int32 {
                var count = 0
                for value in values { count += 1 }
                return count
            }

            let streams = Streams()
            Console.WriteLine("left=" + Count[int32](streams.LeftCall()).GetAwaiter().GetResult().ToString())
            Console.WriteLine("right=" + Count[int32](streams.RightCall(nil)).GetAwaiter().GetResult().ToString())
            Console.WriteLine("receiver-present=" + Count[int32](streams.NullableReceiver(streams)).GetAwaiter().GetResult().ToString())
            Console.WriteLine("receiver-nil=" + Count[int32](streams.NullableReceiver(nil)).GetAwaiter().GetResult().ToString())
            Console.WriteLine("nullable-empty-present=" + Count[int32](streams.NullableEmpty(streams)).GetAwaiter().GetResult().ToString())
            Console.WriteLine("nullable-empty-nil=" + Count[int32](streams.NullableEmpty(nil)).GetAwaiter().GetResult().ToString())
            Console.WriteLine("direct=" + Count[int32](streams.Direct()).GetAwaiter().GetResult().ToString())
            Console.WriteLine("conditional-empty=" + Count[int32](streams.Conditional(true)).GetAwaiter().GetResult().ToString())
            Console.WriteLine("conditional-one=" + Count[int32](streams.Conditional(false)).GetAwaiter().GetResult().ToString())
            Console.WriteLine("generic-empty=" + Count[int32](streams.GenericNested[int32](true, 7)).GetAwaiter().GetResult().ToString())
            Console.WriteLine("generic-one=" + Count[int32](streams.GenericNested[int32](false, 7)).GetAwaiter().GetResult().ToString())
            Console.WriteLine("sync=" + CountSync[int32](streams.SyncControl(nil)).ToString())
            Console.WriteLine("value=" + Streams.Value().GetAwaiter().GetResult().ToString())
            Streams.Work().GetAwaiter().GetResult()
            Console.WriteLine("work=done")
            """;

        using var result = Compile(source);
        IlVerifier.Verify(result.OutputPath);
        AssertMetadataReturnTypes(result.OutputPath);
        Assert.Equal(
            """
            left=0
            right=0
            receiver-present=1
            receiver-nil=0
            nullable-empty-present=0
            nullable-empty-nil=1
            direct=0
            conditional-empty=0
            conditional-one=1
            generic-empty=0
            generic-one=1
            sync-wrapper
            sync=1
            value=42
            work=done

            """,
            Run(result.OutputPath));
    }

    private static void AssertMetadataReturnTypes(string outputPath)
    {
        var loadContext = new AssemblyLoadContext(nameof(Issue2786AsyncIteratorCoalesceEmitTests), isCollectible: true);
        using var pe = File.OpenRead(outputPath);
        var assembly = loadContext.LoadFromStream(pe);
        var streams = assembly.GetType("Issue2786.Streams", throwOnError: true)!;

        foreach (var name in new[]
        {
            "InstanceEmpty",
            "InstanceOne",
            "Empty",
            "One",
            "LeftCall",
            "RightCall",
            "NullableReceiver",
            "NullableEmpty",
            "Direct",
            "Conditional",
        })
        {
            Assert.Equal(typeof(IAsyncEnumerable<int>), GetMethod(streams, name).ReturnType);
        }

        foreach (var name in new[] { "GenericEmpty", "GenericOne", "GenericNested" })
        {
            var returnType = GetMethod(streams, name).ReturnType;
            Assert.True(returnType.IsGenericType);
            Assert.Equal(typeof(IAsyncEnumerable<>), returnType.GetGenericTypeDefinition());
            Assert.True(returnType.GetGenericArguments()[0].IsGenericParameter);
        }

        Assert.Equal(typeof(IEnumerable<int>), GetMethod(streams, "SyncWrapper").ReturnType);
        Assert.Equal(typeof(IEnumerable<int>), GetMethod(streams, "SyncControl").ReturnType);
        Assert.Equal(typeof(Task<int>), GetMethod(streams, "Value").ReturnType);
        Assert.Equal(typeof(Task), GetMethod(streams, "Work").ReturnType);
        loadContext.Unload();
    }

    private static MethodInfo GetMethod(Type type, string name)
        => type.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
            ?? throw new InvalidOperationException($"Missing method {name}.");

    private static CompilationResult Compile(string source)
    {
        var directory = Path.Combine(
            Directory.GetCurrentDirectory(),
            "out",
            "test-artifacts",
            "issue2786-" + Guid.NewGuid().ToString("N"));
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
                "/target:exe",
                "/targetframework:net10.0",
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
        return new CompilationResult(directory, outputPath);
    }

    private static string Run(string outputPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(outputPath)!,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(outputPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet exec.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\n{stderr}");
        return stdout.Replace("\r\n", "\n");
    }

    private sealed class CompilationResult : IDisposable
    {
        public CompilationResult(string directory, string outputPath)
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
