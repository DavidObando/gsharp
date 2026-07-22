// <copyright file="Issue2753TopLevelUsingLifetimeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public class Issue2753TopLevelUsingLifetimeEmitTests
{
    [Fact]
    public void AsyncTopLevelUsing_ClosureAndReturn_DisposesInReverseOrderAtProgramEnd()
    {
        const string source = """
            package Probe
            import System
            import System.Threading.Tasks

            class Outer : IDisposable {
                func Dispose() {
                    Console.WriteLine("dispose:outer")
                }
                func Ping() {
                    Console.WriteLine("ping:outer")
                }
            }

            class Inner : IDisposable {
                func Dispose() {
                    Console.WriteLine("dispose:inner")
                }
            }

            class Holder {
                var Factory (() -> Outer)? = nil
                async func Invoke() Task[int32] {
                    await Task.Yield()
                    Factory!!().Ping()
                    return 0
                }
            }

            using let outer = Outer()
            using let inner = Inner()
            let holder = Holder()
            holder.Factory = () -> outer
            Console.WriteLine("before")
            return await holder.Invoke()
            """;

        var result = CompileAndRun(source);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal("before\nping:outer\ndispose:inner\ndispose:outer\n", result.StandardOutput);
    }

    [Fact]
    public void AsyncTopLevelUsing_ExplicitTryCatchFinally_KeepsClosureAlive()
    {
        const string source = """
            package Probe
            import System
            import System.Threading.Tasks

            class Res : IDisposable {
                var Disposed bool = false
                func Dispose() {
                    Disposed = true
                    Console.WriteLine("disposed")
                }
                func Ping() {
                    if Disposed {
                        throw ObjectDisposedException("Res")
                    }
                    Console.WriteLine("ping")
                }
            }

            class Holder {
                var Factory (() -> Res)? = nil
                async func Invoke() Task[int32] {
                    await Task.Yield()
                    Factory!!().Ping()
                    return 0
                }
            }

            using let resource = Res()
            let holder = Holder()
            holder.Factory = () -> resource
            try {
                return await holder.Invoke()
            } catch (ex Exception) {
                Console.WriteLine("caught")
                return 1
            } finally {
                Console.WriteLine("restore")
            }
            """;

        var result = CompileAndRun(source);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal("ping\nrestore\ndisposed\n", result.StandardOutput);
    }

    [Fact]
    public void AsyncLambdaUsingDeclaration_KeepsResourceAliveAcrossAwait()
    {
        const string source = """
            package Probe
            import System
            import System.Threading.Tasks

            class Res : IDisposable {
                var Disposed bool = false
                func Dispose() {
                    Disposed = true
                    Console.WriteLine("disposed")
                }
                func Ping() {
                    if Disposed {
                        throw ObjectDisposedException("Res")
                    }
                    Console.WriteLine("ping")
                }
            }

            await Task.Run(async () -> {
                using let resource = Res()
                await Task.Yield()
                resource.Ping()
            })
            """;

        var result = CompileAndRun(source);
        Assert.True(
            result.ExitCode == 0,
            $"exited {result.ExitCode}\nstdout:\n{result.StandardOutput}\nstderr:\n{result.StandardError}");
        Assert.Equal("ping\ndisposed\n", result.StandardOutput);
    }

    [Fact]
    public void AsyncTopLevelUsing_UnhandledException_StillDisposes()
    {
        const string source = """
            package Probe
            import System
            import System.Threading.Tasks

            class Res : IDisposable {
                func Dispose() {
                    Console.WriteLine("disposed")
                }
            }

            using let resource = Res()
            Console.WriteLine("before")
            await Task.Yield()
            throw Exception("boom")
            """;

        var result = CompileAndRun(source);
        Assert.NotEqual(0, result.ExitCode);
        Assert.Equal("before\ndisposed\n", result.StandardOutput);
        Assert.Contains("boom", result.StandardError);
    }

    [Fact]
    public void MethodUsingDeclarations_PreserveNestedLexicalLifetimes()
    {
        const string source = """
            package Probe
            import System

            class Outer : IDisposable {
                func Dispose() {
                    Console.WriteLine("dispose:outer")
                }
            }

            class Inner : IDisposable {
                func Dispose() {
                    Console.WriteLine("dispose:inner")
                }
            }

            func Run() {
                using let outer = Outer()
                {
                    using let inner = Inner()
                    Console.WriteLine("body")
                }
                Console.WriteLine("after")
            }

            Run()
            """;

        var result = CompileAndRun(source);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal("body\ndispose:inner\nafter\ndispose:outer\n", result.StandardOutput);
    }

    [Fact]
    public void AsyncTopLevelUsing_MoveNextCleanupRegionsProtectRemainingStatements()
    {
        const string source = """
            package Probe
            import System
            import System.Threading.Tasks

            class Res : IDisposable {
                func Dispose() {}
                func Ping() {}
            }

            using let outer = Res()
            using let inner = Res()
            await Task.Yield()
            outer.Ping()
            inner.Ping()
            """;

        var assemblyPath = Compile(source);
        try
        {
            using var stream = File.OpenRead(assemblyPath);
            using var pe = new PEReader(stream);
            var metadata = pe.GetMetadataReader();
            var moveNext = metadata.TypeDefinitions
                .Select(handle => metadata.GetTypeDefinition(handle))
                .Where(type => metadata.GetString(type.Name).Contains("<Main>$", StringComparison.Ordinal))
                .SelectMany(type => type.GetMethods())
                .Select(handle => metadata.GetMethodDefinition(handle))
                .Single(method => metadata.GetString(method.Name) == "MoveNext");
            var body = pe.GetMethodBody(moveNext.RelativeVirtualAddress);
            var cleanupRegions = body.ExceptionRegions
                .Where(region => region.Kind == ExceptionRegionKind.Catch)
                .ToArray();

            Assert.Contains(
                cleanupRegions,
                outer => cleanupRegions.Any(middle =>
                    Contains(outer, middle)
                    && cleanupRegions.Any(inner => Contains(middle, inner))));
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(assemblyPath)!, recursive: true);
        }
    }

    private static bool Contains(ExceptionRegion outer, ExceptionRegion inner) =>
        outer.TryOffset < inner.TryOffset
        && outer.TryOffset + outer.TryLength >= inner.TryOffset + inner.TryLength;

    private static (int ExitCode, string StandardOutput, string StandardError) CompileAndRun(string source)
    {
        var assemblyPath = Compile(source);
        var directory = Path.GetDirectoryName(assemblyPath)!;
        try
        {
            using var process = Process.Start(new ProcessStartInfo("dotnet")
            {
                ArgumentList =
                {
                    "exec",
                    "--runtimeconfig",
                    Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                    assemblyPath,
                },
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            })!;
            var standardOutput = process.StandardOutput.ReadToEnd().Replace("\r\n", "\n");
            var standardError = process.StandardError.ReadToEnd().Replace("\r\n", "\n");
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            return (process.ExitCode, standardOutput, standardError);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string Compile(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2753_").FullName;
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var standardOutput = new StringWriter();
        using var standardError = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(standardOutput);
        Console.SetError(standardError);
        try
        {
            var exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
            Assert.True(exitCode == 0, $"compile failed ({exitCode}):\n{standardOutput}\n{standardError}");
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        IlVerifier.Verify(outputPath);
        return outputPath;
    }
}
