// <copyright file="Issue2894LambdaBodyGenericClosureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Compiler;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2894: type parameters referenced only from a lambda body must be
/// reified onto its synthesized closure class.
/// </summary>
public class Issue2894LambdaBodyGenericClosureTests
{
    public static IEnumerable<object[]> Contexts()
    {
        yield return Case(
            "generic-function",
            "11",
            1,
            ["T", "TBox"],
            """
            package Issue2894.GenericFunction
            import System
            open class Box {}
            open class Box[T any] : Box { var Value T = default(T) }
            class IntBox : Box[int32] {}
            class Descriptor { var Factory (() -> Box)? }
            func Make[T any, TBox Box[T] init()](input T) Descriptor {
                return Descriptor{
                    Factory: func() Box {
                        let value = TBox()
                        value.Value = input
                        return value
                    },
                }
            }
            func Main() int32 {
                let descriptor = Make[int32, IntBox](11)
                guard let factory = descriptor.Factory else { return 1 }
                let value = (factory() as IntBox)!!
                Console.WriteLine(value.Value)
                return value.Value == 11 ? 0 : 2
            }
            """);

        yield return Case(
            "generic-class-method",
            "22",
            1,
            ["T", "TBox"],
            """
            package Issue2894.GenericClass
            import System
            open class Box {}
            open class Box[T any] : Box { var Value T = default(T) }
            class IntBox : Box[int32] {}
            class Descriptor { var Factory (() -> Box)? }
            class Maker[T any, TBox Box[T] init()] {
                func Make(input T) Descriptor {
                    return Descriptor{
                        Factory: func() Box {
                            let value = TBox()
                            value.Value = input
                            return value
                        },
                    }
                }
            }
            func Main() int32 {
                let descriptor = Maker[int32, IntBox]().Make(22)
                guard let factory = descriptor.Factory else { return 1 }
                let value = (factory() as IntBox)!!
                Console.WriteLine(value.Value)
                return value.Value == 22 ? 0 : 2
            }
            """);

        yield return Case(
            "nested-lambda",
            "33",
            2,
            ["T", "TBox"],
            """
            package Issue2894.NestedLambda
            import System
            open class Box {}
            open class Box[T any] : Box { var Value T = default(T) }
            class IntBox : Box[int32] {}
            class Descriptor { var Factory (() -> Box)? }
            func Make[T any, TBox Box[T] init()](input T) Descriptor {
                return Descriptor{
                    Factory: func() Box {
                        let inner (() -> Box) = func() Box {
                            let value = TBox()
                            value.Value = input
                            return value
                        }
                        return inner()
                    },
                }
            }
            func Main() int32 {
                let descriptor = Make[int32, IntBox](33)
                guard let factory = descriptor.Factory else { return 1 }
                let value = (factory() as IntBox)!!
                Console.WriteLine(value.Value)
                return value.Value == 33 ? 0 : 2
            }
            """);

        yield return Case(
            "generic-local-function-top-level",
            "44",
            1,
            ["T", "TBox"],
            """
            package Issue2894.GenericLocalTopLevel
            import System
            open class Box {}
            open class Box[T any] : Box { var Value T = default(T) }
            class IntBox : Box[int32] {}
            class Descriptor { var Factory (() -> Box)? }
            let Make[T any, TBox Box[T] init()] = func(input T) Descriptor {
                return Descriptor{
                    Factory: func() Box {
                        let value = TBox()
                        value.Value = input
                        return value
                    },
                }
            }
            let descriptor = Make[int32, IntBox](44)
            let factory = descriptor.Factory!!
            let value = (factory() as IntBox)!!
            Console.WriteLine(value.Value)
            """);

        yield return Case(
            "generic-local-function-in-function",
            "55",
            1,
            ["T", "TBox"],
            """
            package Issue2894.GenericLocalInFunction
            import System
            open class Box {}
            open class Box[T any] : Box { var Value T = default(T) }
            class IntBox : Box[int32] {}
            class Descriptor { var Factory (() -> Box)? }
            func Run() int32 {
                let Make[T any, TBox Box[T] init()] = func(input T) Descriptor {
                    return Descriptor{
                        Factory: func() Box {
                            let value = TBox()
                            value.Value = input
                            return value
                        },
                    }
                }
                let descriptor = Make[int32, IntBox](55)
                guard let factory = descriptor.Factory else { return 1 }
                let value = (factory() as IntBox)!!
                Console.WriteLine(value.Value)
                return value.Value == 55 ? 0 : 2
            }
            func Main() int32 -> Run()
            """);

        yield return Case(
            "iterator-state-machine",
            "66",
            1,
            ["TBox"],
            """
            package Issue2894.Iterator
            import System
            open class Box { var Value int32 = 0 }
            class Descriptor { var Factory (() -> Box)? }
            func Make[TBox any](input int32) sequence[Descriptor] {
                yield Descriptor{
                    Factory: func() Box {
                        let ignored = default(TBox)
                        return Box{ Value: input }
                    },
                }
            }
            func Main() int32 {
                for descriptor in Make[string](66) {
                    guard let factory = descriptor.Factory else { return 1 }
                    let value = factory()
                    Console.WriteLine(value.Value)
                    return value.Value == 66 ? 0 : 2
                }
                return 3
            }
            """);

        yield return Case(
            "async-state-machine",
            "77",
            1,
            ["T", "TBox"],
            """
            package Issue2894.Async
            import System
            import System.Threading.Tasks
            open class Box {}
            open class Box[T any] : Box { var Value T = default(T) }
            class IntBox : Box[int32] {}
            class Descriptor { var Factory (() -> Box)? }
            async func Make[T any, TBox Box[T] init()](input T) Task[Descriptor] {
                await Task.CompletedTask
                return Descriptor{
                    Factory: func() Box {
                        let value = TBox()
                        value.Value = input
                        return value
                    },
                }
            }
            func Main() int32 {
                let descriptor = Make[int32, IntBox](77).GetAwaiter().GetResult()
                guard let factory = descriptor.Factory else { return 1 }
                let value = (factory() as IntBox)!!
                Console.WriteLine(value.Value)
                return value.Value == 77 ? 0 : 2
            }
            """);
    }

    [Theory]
    [MemberData(nameof(Contexts))]
    public void BodyOnlyGenericParameter_ClosureDeclaresParameterAndRuns(
        string name,
        string expectedOutput,
        int expectedClosureCount,
        string[] expectedTypeParameters,
        string source)
    {
        var directory = Directory.CreateDirectory(
            Path.Combine(AppContext.BaseDirectory, "issue2894", Guid.NewGuid().ToString("N"))).FullName;
        try
        {
            var sourcePath = Path.Combine(directory, name + ".gs");
            var assemblyPath = Path.Combine(directory, name + ".dll");
            File.WriteAllText(sourcePath, source);

            var exitCode = Program.Main(
            [
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            ]);
            Assert.Equal(0, exitCode);

            Assert.Equal(expectedOutput + Environment.NewLine, Run(assemblyPath, directory));

            var assembly = EmittedFixture.Load(assemblyPath);
            var closureTypes = assembly.GetTypes()
                .Where(type => type.Name.StartsWith("<closure_", StringComparison.Ordinal))
                .ToArray();
            Assert.Equal(expectedClosureCount, closureTypes.Length);
            foreach (var closureType in closureTypes)
            {
                Assert.Equal(
                    expectedTypeParameters,
                    closureType.GetGenericArguments().Select(parameter => parameter.Name));
            }
        }
        finally
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

    private static object[] Case(
        string name,
        string expectedOutput,
        int expectedClosureCount,
        string[] expectedTypeParameters,
        string source) =>
        [name, expectedOutput, expectedClosureCount, expectedTypeParameters, source];

    private static string Run(string assemblyPath, string directory)
    {
        var runtimeConfig = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json");
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                runtimeConfig,
                assemblyPath,
            },
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        }) ?? throw new InvalidOperationException("Failed to start dotnet child process.");

        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            throw new TimeoutException("dotnet child process timed out.");
        }

        var stdout = stdoutTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine);
        var stderr = stderrTask.GetAwaiter().GetResult();
        Assert.True(
            process.ExitCode == 0,
            $"dotnet exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }
}
