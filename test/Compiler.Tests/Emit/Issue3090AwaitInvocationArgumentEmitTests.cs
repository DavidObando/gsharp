// <copyright file="Issue3090AwaitInvocationArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Native compiler coverage for issue #3090 await call arguments.</summary>
public sealed class Issue3090AwaitInvocationArgumentEmitTests
{
    [Fact]
    public void BareAwaitNamedArgument_PreservesReceiverSourceOrderAndMapping()
    {
        const string Source = """
            package P
            import System.Threading.Tasks

            public var trace = ""

            class Queue {
                async func EnqueueAsync(job string, priority int32, dueAt int32, ct int32) {
                    await Task.CompletedTask
                    trace = trace + "O:$job:$priority:$dueAt:$ct"
                }
            }

            func getQueue() Queue {
                trace = trace + "R"
                return Queue()
            }

            func mark(label string, value int32) int32 {
                trace = trace + label
                return value
            }

            async func inner(label string, value int32) int32 {
                await Task.CompletedTask
                trace = trace + label
                return value
            }

            async func run() {
                await getQueue().EnqueueAsync(
                    "job",
                    dueAt: await inner("I", 2),
                    priority: mark("P", 0),
                    ct: mark("C", 3))
            }

            run().Wait()
            """;

        Assembly assembly = CompileToAssembly(Source);
        Type program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        MethodInfo entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        FieldInfo trace = program.GetField("trace", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(
            null,
            entry.GetParameters().Length == 0
                ? null
                : new object[] { Array.Empty<string>() });

        Assert.Equal("RIPCO:job:0:2:3", (string)trace!.GetValue(null)!);
    }

    [Fact]
    public void RefAndOutArguments_WithNestedAwait_RemainValid()
    {
        const string Source = """
            package P
            import System.Threading.Tasks

            func inner() Task[int32] {
                return Task.FromResult(7)
            }

            func setRef(ref slot int32, value int32) Task {
                slot = value
                return Task.CompletedTask
            }

            func setOut(out slot int32, value int32) Task {
                slot = value
                return Task.CompletedTask
            }

            async func run() int32 {
                var a = 0
                var b int32
                await setRef(ref a, value: await inner())
                await setOut(out b, value: await inner())
                return a * 10 + b
            }

            public var result = 0
            result = run().Result
            """;

        Assembly assembly = CompileToAssembly(Source);
        Type program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        MethodInfo entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        FieldInfo result = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(
            null,
            entry.GetParameters().Length == 0
                ? null
                : new object[] { Array.Empty<string>() });

        Assert.Equal(77, (int)result!.GetValue(null)!);
    }

    [Fact]
    public void ConditionalAccess_NestedAwait_StaysInsideNullShortCircuit()
    {
        const string Source = """
            package P
            import System.Threading.Tasks

            public var trace = ""

            class Receiver {
                var Next Receiver?

                init(next Receiver?) {
                    Next = next
                }

                async func ReceiveAsync(value int32) {
                    await Task.CompletedTask
                    trace = trace + "O$value"
                }
            }

            async func inner(label string, value int32) int32 {
                await Task.CompletedTask
                trace = trace + label
                return value
            }

            async func direct(recv Receiver?) {
                let task = recv?.ReceiveAsync(value: await inner("D", 1))
                if task != nil {
                    await task!!
                }
            }

            async func chained(recv Receiver?) {
                let task = recv?.Next!!.ReceiveAsync(value: await inner("C", 2))
                if task != nil {
                    await task!!
                }
            }

            async func run() {
                let leaf = Receiver(nil)
                let root = Receiver(leaf)
                await direct(nil)
                await chained(nil)
                await direct(root)
                await chained(root)
            }

            run().Wait()
            """;

        Assembly assembly = CompileToAssembly(Source);
        Type program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        MethodInfo entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        FieldInfo trace = program.GetField("trace", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(
            null,
            entry.GetParameters().Length == 0
                ? null
                : new object[] { Array.Empty<string>() });

        Assert.Equal("DO1CO2", (string)trace!.GetValue(null)!);
    }

    private static Assembly CompileToAssembly(string source)
    {
        string directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue3090-native",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string sourcePath = Path.Combine(directory, "test.gs");
        string outputPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        TextWriter previousOut = Console.Out;
        TextWriter previousError = Console.Error;
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
            $"gsc failed:{Environment.NewLine}stdout:{Environment.NewLine}{stdout}" +
            $"{Environment.NewLine}stderr:{Environment.NewLine}{stderr}");
        IlVerifier.Verify(outputPath);
        return EmittedFixture.Load(outputPath);
    }
}
