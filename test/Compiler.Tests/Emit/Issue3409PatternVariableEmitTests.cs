// <copyright file="Issue3409PatternVariableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Runtime and IL verification for ADR-0166 pattern variables in boolean
/// <c>is</c> expressions (issue #3409).
/// </summary>
public sealed class Issue3409PatternVariableEmitTests
{
    [Fact]
    public void IssueExample_NestedDesignationAndContinuation_RunsWithoutSpills()
    {
        const string Source = """
            package Issue3409.Example
            import System

            class StructSymbol {
                prop IsClass bool { get; init; }
            }
            class Receiver {
                prop Type object? { get; init; }
            }
            class FieldAccess {
                prop Receiver Receiver? { get; init; }
            }

            func HasHeapReceiver(fa FieldAccess) bool {
                if fa.Receiver is { Type: StructSymbol s } && s.IsClass {
                    return true
                }
                return false
            }

            Console.WriteLine(HasHeapReceiver(FieldAccess{Receiver: Receiver{Type: StructSymbol{IsClass: true}}}))
            Console.WriteLine(HasHeapReceiver(FieldAccess{Receiver: Receiver{Type: StructSymbol{IsClass: false}}}))
            Console.WriteLine(HasHeapReceiver(FieldAccess{Receiver: Receiver{Type: "not a symbol"}}))
            Console.WriteLine(HasHeapReceiver(FieldAccess{Receiver: nil}))
            """;

        var result = CompileAndRun(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal(
            string.Join(Environment.NewLine, ["True", "False", "False", "False", string.Empty]),
            result.Stdout);
    }

    [Fact]
    public void PatternVariableMatrix_VerifiesAndRuns()
    {
        const string Source = """
            package Issue3409
            import System
            import System.Threading.Tasks
            import System.Collections.Generic

            open class Animal { }
            class Dog : Animal {
                prop Name string { get; init; }
                func Bark() string { return Name + ":woof" }
            }
            class Box {
                prop Value object? { get; init; }
            }
            open class Shape { }
            class Circle : Shape { prop Radius int32 { get; init; } }
            class Square : Shape { prop Side int32 { get; init; } }

            func Describe(value object) string {
                if value is string text && text.Length > 3 {
                    return "long string " + text
                }
                if value is Dog { Name: "Rex" } rex {
                    return "the dog " + rex.Bark()
                }
                if !(value is Dog dog) {
                    return "not a dog"
                }
                return "dog " + dog.Name
            }

            func Nested(box Box) string {
                if box is { Value: Dog d } && d.Name.Length > 0 {
                    return d.Bark()
                }
                return "none"
            }

            func Ternary(value object) string {
                return value is int32 n ? "int " + n.ToString() : "other"
            }

            func IfExpression(value object) string {
                return if value is string s { s } else { "no" }
            }

            func Guarded(values []object) int32 {
                var count = 0
                for v in values {
                    if v !is string s {
                        continue
                    }
                    count += s.Length
                }
                return count
            }

            func OrChain(value object) string {
                if !(value is string s) || s.Length == 0 {
                    return "empty"
                }
                return "s=" + s
            }

            func ElseBranch(value object) string {
                if value is not int32 n {
                    return "no"
                } else {
                    return "n=" + n.ToString()
                }
            }

            func ExitingElse(value object) string {
                if value is string s { } else { return "no" }
                return "yes " + s
            }

            func Captured(value object) () -> string {
                if value is string s {
                    return () -> s + "!"
                }
                return () -> "none"
            }

            func Loop(queue Queue[object]) int32 {
                var total = 0
                for queue.Count > 0 && queue.Dequeue() is int32 n {
                    total += n
                }
                return total
            }

            async func AsyncUse(value object) Task[string] {
                if value is string s {
                    await Task.Yield()
                    return s + "?"
                }
                return "-"
            }

            func Slice(values []int32) int32 {
                if values is [1, ..rest] && rest.Length > 0 {
                    return rest[0]
                }
                return -1
            }

            func NullableInput(value string?) int32 {
                if value is { Length: > 0 } text {
                    return text.Length
                }
                return 0
            }

            func NullableValue(value int32?) int32 {
                if value is { } v {
                    return v + 1
                }
                return -1
            }

            func Area(shape Shape) int32 {
                switch shape {
                    case Circle c { return 3 * c.Radius * c.Radius }
                    case Square { Side: > 0 } sq when sq.Side is int32 side { return side * side }
                    default { return 0 }
                }
            }

            func AreaExpression(shape Shape) int32 {
                return switch shape {
                    case Circle c: 3 * c.Radius * c.Radius
                    case Square sq: sq.Side * sq.Side
                    default: -1
                }
            }

            Console.WriteLine(Describe("hello"))
            Console.WriteLine(Describe(Dog{Name: "Rex"}))
            Console.WriteLine(Describe(Dog{Name: "Buddy"}))
            Console.WriteLine(Describe(42))
            Console.WriteLine(Nested(Box{Value: Dog{Name: "Fido"}}))
            Console.WriteLine(Nested(Box{Value: 5}))
            Console.WriteLine(Nested(Box{Value: nil}))
            Console.WriteLine(Ternary(7))
            Console.WriteLine(Ternary("x"))
            Console.WriteLine(IfExpression("k"))
            Console.WriteLine(Guarded([]object{"ab", 3, "cde"}))
            Console.WriteLine(OrChain("hey"))
            Console.WriteLine(OrChain(""))
            Console.WriteLine(OrChain(1))
            Console.WriteLine(ElseBranch(5))
            Console.WriteLine(ElseBranch("x"))
            Console.WriteLine(ExitingElse("ok"))
            Console.WriteLine(ExitingElse(1))
            Console.WriteLine(Captured("yo")())
            Console.WriteLine(Captured(1)())
            let q = Queue[object]()
            q.Enqueue(1)
            q.Enqueue(2)
            q.Enqueue("stop")
            q.Enqueue(9)
            Console.WriteLine(Loop(q))
            Console.WriteLine(AsyncUse("a").Result)
            Console.WriteLine(AsyncUse(1).Result)
            Console.WriteLine(Slice([]int32{1, 5, 6}))
            Console.WriteLine(Slice([]int32{2, 5}))
            Console.WriteLine(NullableInput("abc"))
            Console.WriteLine(NullableInput(nil))
            Console.WriteLine(NullableValue(41))
            Console.WriteLine(NullableValue(nil))
            Console.WriteLine(Area(Circle{Radius: 2}))
            Console.WriteLine(Area(Square{Side: 3}))
            Console.WriteLine(AreaExpression(Square{Side: 4}))
            """;

        var result = CompileAndRun(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal(
            string.Join(Environment.NewLine,
            [
                "long string hello",
                "the dog Rex:woof",
                "dog Buddy",
                "not a dog",
                "Fido:woof",
                "none",
                "none",
                "int 7",
                "other",
                "k",
                "5",
                "s=hey",
                "empty",
                "empty",
                "n=5",
                "no",
                "yes ok",
                "no",
                "yo!",
                "none",
                "3",
                "a?",
                "-",
                "5",
                "-1",
                "3",
                "0",
                "42",
                "-1",
                "12",
                "9",
                "16",
                string.Empty,
            ]),
            result.Stdout);
    }

    [Fact]
    public void TypeParameterSource_BoxesBeforeTypeTest_VerifiesAndRuns()
    {
        // Oahu gate regression (PR #3417): `value is IDisposable d` over a
        // bare `T` must box before `isinst`, in a plain method, a switch arm,
        // and an async state machine.
        const string Source = """
            package Issue3409.Generic
            import System
            import System.Threading.Tasks

            class Resource : IDisposable {
                shared { var Disposed int32 }
                func Dispose() { Resource.Disposed += 1 }
            }

            func Close[T](value T) string {
                if value is IDisposable disposable {
                    disposable.Dispose()
                    return "closed"
                }
                if value is { } present {
                    return "kept " + present.ToString()
                }
                return "nil"
            }

            func Kind[T](value T) string {
                switch value {
                    case IDisposable d { return "disposable" }
                    case string s { return "text " + s }
                    default { return "other" }
                }
            }

            async func CloseAsync[T](value T) Task[string] {
                await Task.Yield()
                if value is IDisposable disposable {
                    disposable.Dispose()
                    return "closed async"
                }
                return "kept async"
            }

            func Describe[T](value T?) string {
                if value is string text {
                    return "text " + text
                }
                return "none"
            }

            Console.WriteLine(Close(Resource{}))
            Console.WriteLine(Close(42))
            Console.WriteLine(Close[string?](nil))
            Console.WriteLine(Kind(Resource{}))
            Console.WriteLine(Kind("hi"))
            Console.WriteLine(Kind(3.5))
            Console.WriteLine(CloseAsync(Resource{}).Result)
            Console.WriteLine(CloseAsync(1).Result)
            Console.WriteLine(Describe[string]("t"))
            Console.WriteLine(Describe[string](nil))
            Console.WriteLine(Resource.Disposed)
            """;

        var result = CompileAndRun(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal(
            string.Join(Environment.NewLine,
            [
                "closed",
                "kept 42",
                "nil",
                "disposable",
                "text hi",
                "other",
                "closed async",
                "kept async",
                "text t",
                "none",
                "2",
                string.Empty,
            ]),
            result.Stdout);
    }

    internal static (int ExitCode, string Stdout) CompileAndRun(string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3409PatternVariableEmitTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExitCode;
            try
            {
                compileExitCode = Program.Main(
                [
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100,GS0286",
                    sourcePath,
                ]);
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            Assert.True(
                compileExitCode == 0,
                $"gsc failed (exit {compileExitCode}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outputPath);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
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
            Assert.True(
                process.ExitCode == 0,
                $"sample exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return (process.ExitCode, stdout.ReplaceLineEndings(Environment.NewLine));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
