// <copyright file="Issue4412SuspendMethodGroupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #4412: suspend method groups capture context through a verifier-safe thunk.</summary>
/// <remarks>
/// ADR-0154 witness: on the parent commit the direct and base cases fail
/// ILVerify with two DelegateCtor errors, while the imported structural
/// conversion reports GS0218 because its hidden context parameter is counted
/// as a source parameter.
/// </remarks>
public sealed class Issue4412SuspendMethodGroupEmitTests
{
    [Fact]
    public void DirectInstanceAndBaseSuspendMethodGroups_VerifyAndRun()
    {
        const string source = """
            package Issue4412
            import System

            delegate Runner(value int32) System.Threading.Tasks.ValueTask[int32];

            open class A {
                open suspend func M(value int32) int32 {
                    return value + 1
                }

                suspend func Wait(ch chan[int32]) string {
                    select {
                    case cancelled {
                        return "cancelled"
                    }
                    case <-ch {
                        return "received"
                    }
                    }
                }
            }

            class B : A {
                override suspend func M(value int32) int32 {
                    return value + 10
                }

                suspend func BaseDelegate(value int32) int32 {
                    let f = base.M
                    return await f(value)
                }
            }

            suspend func run() {
                let a A = B()
                let direct = a.M
                Console.WriteLine(direct(1))
                var named Runner = a.M
                Console.WriteLine(await named(2))
                Console.WriteLine(B().BaseDelegate(1))
                scope {
                    let wait = a.Wait
                    ctx.TryCancel()
                    Console.WriteLine(await wait(chan[int32](1)))
                }
            }

            run()
            """;

        var directory = PrepareDirectory(nameof(DirectInstanceAndBaseSuspendMethodGroups_VerifyAndRun));
        try
        {
            var outputPath = Compile(directory, "App", source, "/target:exe");
            IlVerifier.Verify(outputPath, new[] { Path.Combine(directory, "Gsharp.Runtime.Channels.dll") });
            Assert.Equal(
                $"11{Environment.NewLine}12{Environment.NewLine}2{Environment.NewLine}cancelled{Environment.NewLine}",
                Run(outputPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ImportedInstanceSuspendMethodGroup_VerifiesAndRuns()
    {
        const string library = """
            package Lib

            public open class A {
                public open suspend func M(value int32) int32 {
                    return value + 1
                }

                public suspend func Wait(ch chan[int32]) string {
                    select {
                    case cancelled {
                        return "cancelled"
                    }
                    case <-ch {
                        return "received"
                    }
                    }
                }
            }
            """;
        const string app = """
            package App
            import System
            import Lib

            suspend func run() {
                let direct (int32) -> System.Threading.Tasks.ValueTask[int32] = A().M
                Console.WriteLine(await direct(1))
                scope {
                    let wait (chan[int32]) -> System.Threading.Tasks.ValueTask[string] = A().Wait
                    ctx.TryCancel()
                    Console.WriteLine(await wait(chan[int32](1)))
                }
            }

            run()
            """;

        var directory = PrepareDirectory(nameof(ImportedInstanceSuspendMethodGroup_VerifiesAndRuns));
        try
        {
            var libraryPath = Compile(directory, "Lib", library, "/target:library");
            var appPath = Compile(directory, "App", app, "/target:exe", "/reference:" + libraryPath);
            IlVerifier.Verify(
                appPath,
                new[] { libraryPath, Path.Combine(directory, "Gsharp.Runtime.Channels.dll") });
            Assert.Equal($"2{Environment.NewLine}cancelled{Environment.NewLine}", Run(appPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ImportedStaticAndExtensionSuspendMethodGroups_VerifyAndRun()
    {
        const string library = """
            package Lib

            public class Number {
                public let value int32
                public init(value int32) {
                    this.value = value
                }
            }

            public suspend func Twice(value int32) int32 {
                return value * 2
            }

            public suspend func (number Number) Add(value int32) int32 {
                return number.value + value
            }
            """;
        const string app = """
            package App
            import System
            import Lib

            suspend func run() {
                let twice (int32) -> System.Threading.Tasks.ValueTask[int32] = Twice
                let add (int32) -> System.Threading.Tasks.ValueTask[int32] = Number(10).Add
                Console.WriteLine(await twice(3))
                Console.WriteLine(await add(4))
            }

            run()
            """;

        var directory = PrepareDirectory(nameof(ImportedStaticAndExtensionSuspendMethodGroups_VerifyAndRun));
        try
        {
            var libraryPath = Compile(directory, "Lib", library, "/target:library");
            var appPath = Compile(directory, "App", app, "/target:exe", "/reference:" + libraryPath);
            IlVerifier.Verify(
                appPath,
                new[] { libraryPath, Path.Combine(directory, "Gsharp.Runtime.Channels.dll") });
            Assert.Equal($"6{Environment.NewLine}14{Environment.NewLine}", Run(appPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void InferredSuspendMethodGroup_VerifiesAndRuns()
    {
        const string source = """
            package Issue4412
            import System

            func Take(ch chan[int32]) int32 {
                return <-ch
            }

            suspend func AddOne(value int32) int32 {
                return value + 1
            }

            let ch = chan[int32](1)
            ch <- 42
            let addOne = AddOne
            let take = Take
            Console.WriteLine(addOne(1))
            Console.WriteLine(take(ch))
            """;

        var directory = PrepareDirectory(nameof(InferredSuspendMethodGroup_VerifiesAndRuns));
        try
        {
            var outputPath = Compile(directory, "App", source, "/target:exe");
            IlVerifier.Verify(outputPath, new[] { Path.Combine(directory, "Gsharp.Runtime.Channels.dll") });
            Assert.Equal($"2{Environment.NewLine}42{Environment.NewLine}", Run(outputPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string PrepareDirectory(string name)
    {
        var path = Path.Combine(AppContext.BaseDirectory, name);
        if (Directory.Exists(path))
        {
            Directory.Delete(path, recursive: true);
        }

        Directory.CreateDirectory(path);
        return path;
    }

    private static string Compile(string directory, string assemblyName, string source, params string[] extra)
    {
        var sourcePath = Path.Combine(directory, assemblyName + ".gs");
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        File.WriteAllText(sourcePath, source);
        var arguments = new List<string>
        {
            "/out:" + outputPath,
            "/targetframework:net10.0",
        };
        arguments.AddRange(extra);
        arguments.AddRange(TrustedPlatformAssemblies().Select(reference => "/reference:" + reference));
        arguments.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            Program.Main(arguments.ToArray());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(
            File.Exists(outputPath) && new FileInfo(outputPath).Length > 0,
            stdout.ToString() + stderr);
        return outputPath;
    }

    private static string Run(string assemblyPath)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath),
        }) ?? throw new InvalidOperationException("could not start dotnet");
        var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.Equal(0, process.ExitCode);
        return output.ReplaceLineEndings(Environment.NewLine);
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(value)
            ? Enumerable.Empty<string>()
            : value.Split(Path.PathSeparator).Where(File.Exists);
    }
}
