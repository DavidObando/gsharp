// <copyright file="Issue2931StructReceiverStateMachineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2931: value-type instance state machines must capture the value
/// addressed by the managed-pointer <c>this</c> argument, not the pointer bits.
/// </summary>
public class Issue2931StructReceiverStateMachineTests
{
    [Fact]
    public void StructIteratorReceiversRetainValueCopies()
    {
        const string Source = """
            package Issue2931Sync
            import System

            struct Box {
                var N int32
                func vals() sequence[int32] { yield N }

                func runSyncClosure() int32 {
                    var read = func() int32 { return N }
                    return read()
                }

                func runAsyncClosure() int32 {
                    var read = async func() int32 { return N }
                    return read().Result
                }
            }

            func (box Box) receiverVals() sequence[int32] { yield box.N }

            struct Holder {
                var B Box
            }

            struct Inner {
                var N int32
            }

            struct Nested {
                var Value Inner
                func vals() sequence[int32] { yield Value.N }
            }

            class Cell(N int32) {}

            struct WithReference {
                var C Cell
                func vals() sequence[int32] { yield C.N }
            }

            struct GenericBox[T] {
                var Value T
                func vals() sequence[T] { yield Value }
            }

            struct Pair {
                var A int32
                var B int32

                func vals() sequence[int32] {
                    yield A
                    A = A + B
                    yield A
                    yield B
                }
            }

            struct OuterIterator {
                var B Box

                func vals() sequence[int32] {
                    for value in B.vals() {
                        yield value
                    }
                }
            }

            func print(values sequence[int32]) {
                for value in values {
                    Console.WriteLine(value)
                }
            }

            print(Box{N: 100}.vals())

            var local = Box{N: 110}
            print(local.vals())

            var holder = Holder{B: Box{N: 120}}
            print(holder.B.vals())

            print(Nested{Value: Inner{N: 130}}.vals())
            print(WithReference{C: Cell(140)}.vals())
            print(GenericBox[int32]{Value: 150}.vals())

            var pair = Pair{A: 160, B: 3}
            print(pair.vals())
            Console.WriteLine(pair.A)

            let repeated = Box{N: 170}.vals()
            print(repeated)
            print(repeated)

            print(OuterIterator{B: Box{N: 180}}.vals())
            Console.WriteLine(Box{N: 81}.runSyncClosure())
            Console.WriteLine(Box{N: 82}.runAsyncClosure())
            print(Box{N: 101}.receiverVals())
            """;

        AssertRunsWithExactOutput(
            Source,
            nameof(StructIteratorReceiversRetainValueCopies),
            "100\n110\n120\n130\n140\n150\n160\n163\n3\n160\n170\n170\n180\n81\n82\n101\n");
    }

    [Fact]
    public void AsyncStructIteratorReceiversRetainValueCopies()
    {
        const string Source = """
            package Issue2931AsyncIterator
            import System
            import System.Threading.Tasks

            struct Box {
                var N int32

                async func vals() async sequence[int32] {
                    yield N
                    await Task.Delay(1)
                    yield N + 1
                }
            }

            struct GenericBox[T] {
                var Value T

                async func vals() async sequence[T] {
                    yield Value
                    await Task.Delay(1)
                    yield Value
                }
            }

            class ClassBox(N int32) {
                async func vals() async sequence[int32] {
                    yield N
                    await Task.Delay(1)
                    yield N + 1
                }
            }

            let temporary = Box{N: 200}.vals().GetAsyncEnumerator()
            for temporary.MoveNextAsync().AsTask().Result {
                Console.WriteLine(temporary.Current)
            }

            var box = Box{N: 210}
            let local = box.vals().GetAsyncEnumerator()
            for local.MoveNextAsync().AsTask().Result {
                Console.WriteLine(local.Current)
            }

            let generic = GenericBox[int32]{Value: 220}.vals().GetAsyncEnumerator()
            for generic.MoveNextAsync().AsTask().Result {
                Console.WriteLine(generic.Current)
            }

            let classControl = ClassBox(230).vals().GetAsyncEnumerator()
            for classControl.MoveNextAsync().AsTask().Result {
                Console.WriteLine(classControl.Current)
            }
            """;

        AssertRunsWithExactOutput(
            Source,
            nameof(AsyncStructIteratorReceiversRetainValueCopies),
            "200\n201\n210\n211\n220\n220\n230\n231\n");
    }

    [Fact]
    public void AsyncStructMethodReceiversRetainValueCopies()
    {
        const string Source = """
            package Issue2931AsyncMethod
            import System
            import System.Threading.Tasks

            struct Box {
                var N int32

                async func val() int32 {
                    await Task.Delay(1)
                    return N
                }
            }

            struct GenericBox[T] {
                var Value T

                async func val() T {
                    await Task.Delay(1)
                    return Value
                }
            }

            class CBox(N int32) {
                async func val() int32 {
                    await Task.Delay(1)
                    return N
                }
            }

            Console.WriteLine(Box{N: 300}.val().Result)

            var box = Box{N: 310}
            Console.WriteLine(box.val().Result)
            Console.WriteLine(GenericBox[int32]{Value: 320}.val().Result)
            Console.WriteLine(CBox(91).val().Result)
            """;

        AssertRunsWithExactOutput(
            Source,
            nameof(AsyncStructMethodReceiversRetainValueCopies),
            "300\n310\n320\n91\n");
    }

    [Fact]
    public void NonIteratorStructReceiverControlRemainsCorrect()
    {
        const string Source = """
            package Issue2931NonIteratorControl
            import System

            struct Box {
                var N int32
                func val() int32 -> N
            }

            Console.WriteLine(Box{N: 320}.val())

            var box = Box{N: 330}
            Console.WriteLine(box.val())
            """;

        AssertRunsWithExactOutput(
            Source,
            nameof(NonIteratorStructReceiverControlRemainsCorrect),
            "320\n330\n");
    }

    [Fact]
    public void ClassIteratorReceiverControlRemainsCorrect()
    {
        const string Source = """
            package Issue2931ClassControl
            import System

            class Box(N int32) {
                func vals() sequence[int32] { yield N }
            }

            for value in Box(400).vals() {
                Console.WriteLine(value)
            }

            let box = Box(410)
            for value in box.vals() {
                Console.WriteLine(value)
            }
            """;

        AssertRunsWithExactOutput(
            Source,
            nameof(ClassIteratorReceiverControlRemainsCorrect),
            "400\n410\n");
    }

    private static void AssertRunsWithExactOutput(string source, string name, string expected)
    {
        var assemblyPath = Compile(source, name);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());

        for (var i = 0; i < 6; i++)
        {
            Assert.Equal(expected, RunBounded(assemblyPath, name));
        }

        IlVerifier.Verify(assemblyPath);
    }

    private static string Compile(string source, string name)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2931StructReceiverStateMachineTests), name);
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
        var exited = process.WaitForExit(30_000);
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
