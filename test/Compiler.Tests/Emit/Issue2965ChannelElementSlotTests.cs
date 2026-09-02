// <copyright file="Issue2965ChannelElementSlotTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using GSharp.Compiler;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2965: channel signatures, locals, and member references must retain
/// same-compilation value-type element identities instead of erasing them to
/// <see cref="object"/>.
/// </summary>
public class Issue2965ChannelElementSlotTests
{
    [Fact]
    public void SendOnlyUserStructChannel_LoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2965SendOnly
            import System

            data struct Pair(Value int32)

            let ch = chan[Pair](1)
            ch <- Pair(41)
            Console.WriteLine(1)
            """;

        AssertRuns(Source, nameof(SendOnlyUserStructChannel_LoadsVerifiesAndRuns), "1\n");
    }

    [Fact]
    public void ChannelElementMatrix_LoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2965Matrix
            import System
            import System.Threading
            import System.Threading.Tasks

            data struct Pair(Value int32)

            struct Plain {
                var Value int32
            }

            data struct Box[T] {
                var Value T
            }

            struct Inner {
                var Value int32
            }

            struct Outer {
                var Item Inner
            }

            class RefBox(Value int32) {}

            func delayedSend(ch chan[Pair]) int32 {
                Thread.Sleep(10)
                ch <- Pair(51)
                return 0
            }

            func delayedReceive(ch chan[Pair]) int32 {
                Thread.Sleep(10)
                return (<-ch).Value
            }

            func echo[T](value T) T {
                let ch = chan[T](1)
                ch <- value
                return <-ch
            }

            async func asyncPair() int32 {
                let ch = chan[Pair](1)
                ch <- Pair(50)
                await Task.Delay(1)
                return (<-ch).Value
            }

            async func asyncSelectPair() int32 {
                let ch = chan[Pair](1)
                ch <- Pair(56)
                var result = 0
                select {
                    case let value = <-ch {
                        await Task.Delay(1)
                        result = value.Value
                    }
                }
                return result
            }

            let plainReceive = chan[Pair](1)
            plainReceive <- Pair(41)
            Console.WriteLine((<-plainReceive).Value)
            plainReceive.Close()

            let selectReceive = chan[Pair](1)
            selectReceive <- Pair(42)
            select {
                case let value = <-selectReceive { Console.WriteLine(value.Value) }
            }

            let discardReceive = chan[Pair](1)
            discardReceive <- Pair(55)
            select {
                case <-discardReceive { Console.WriteLine(55) }
            }

            let selectSend = chan[Pair](1)
            select {
                case selectSend <- Pair(43) {
                    Console.Write("")
                }
            }
            Console.WriteLine((<-selectSend).Value)

            let plainStruct = chan[Plain](1)
            plainStruct <- Plain{Value: 44}
            Console.WriteLine((<-plainStruct).Value)

            let genericStruct = chan[Box[int32]](1)
            genericStruct <- Box[int32]{Value: 45}
            Console.WriteLine((<-genericStruct).Value)

            let nestedStruct = chan[Outer](1)
            nestedStruct <- Outer{Item: Inner{Value: 46}}
            Console.WriteLine((<-nestedStruct).Item.Value)

            let nullableValue = chan[int32?](1)
            nullableValue <- 47
            Console.WriteLine((<-nullableValue) ?? -1)

            let nullablePair = chan[Pair?](1)
            nullablePair <- Pair(54)
            Console.WriteLine(((<-nullablePair) ?? Pair(-1)).Value)

            let reference = chan[RefBox](1)
            reference <- RefBox(48)
            Console.WriteLine((<-reference).Value)

            let primitive = chan[int32](1)
            primitive <- 49
            Console.WriteLine(<-primitive)

            let imported = chan[DateTime](1)
            imported <- DateTime(2020, 1, 1)
            Console.WriteLine((<-imported).Year)

            let closed = chan[Pair](1)
            closed.Close()
            Console.WriteLine((<-closed).Value)

            let closedSelect = chan[Pair](1)
            closedSelect.Close()
            select {
                case let value = <-closedSelect { Console.WriteLine(value.Value) }
            }

            let blockingReceive = Chan.Unbounded[Pair]()
            scope {
                go delayedSend(blockingReceive)
                select {
                    case let value = <-blockingReceive { Console.WriteLine(value.Value) }
                }
            }

            let blockingSend = Chan.Unbounded[Pair]()
            scope {
                go delayedReceive(blockingSend)
                select {
                    case blockingSend <- Pair(52) {
                        Console.WriteLine(52)
                    }
                }
            }

            Console.WriteLine(echo(Pair(53)).Value)
            Console.WriteLine(asyncPair().Result)
            Console.WriteLine(asyncSelectPair().Result)
            """;

        AssertRuns(
            Source,
            nameof(ChannelElementMatrix_LoadsVerifiesAndRuns),
            "41\n42\n55\n43\n44\n45\n46\n47\n54\n48\n49\n2020\n0\n0\n51\n52\n53\n50\n56\n");
    }

    private static void AssertRuns(string source, string name, string expected)
    {
        var assemblyPath = Compile(source, name);
        var assembly = EmittedFixture.Load(assemblyPath);
        Assert.NotEmpty(assembly.GetTypes());

        for (var i = 0; i < 3; i++)
        {
            Assert.Equal(expected, RunBounded(assemblyPath, name));
        }

        IlVerifier.Verify(assemblyPath);
    }

    private static string Compile(string source, string name)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2965ChannelElementSlotTests),
            name);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, name + ".dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }

        Assert.True(exitCode == 0, $"{name}: gsc failed:\n{stdout}\n{stderr}");
        return assemblyPath;
    }

    private static string RunBounded(string assemblyPath, string name)
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
            WorkingDirectory = Path.GetDirectoryName(assemblyPath),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });

        Assert.NotNull(process);
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        var exited = process.WaitForExit(10_000);
        if (!exited)
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
        }

        Assert.True(exited, $"{name}: emitted program timed out");
        var output = outputTask.GetAwaiter().GetResult();
        var error = errorTask.GetAwaiter().GetResult();
        Assert.True(process.ExitCode == 0, $"{name}: emitted program failed:\n{error}");
        return output.ReplaceLineEndings(Environment.NewLine);
    }
}
