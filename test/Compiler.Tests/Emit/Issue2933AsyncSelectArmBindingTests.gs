// <copyright file="Issue2933AsyncSelectArmBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #2933: select receive bindings inside async state machines retain
/// their received values.
open class Issue2933AsyncSelectArmBindingTests {
    @Fact
    func AsyncAndSynchronousReceiveBindingsAreEqualAtRuntime() {
        const Source = `package Issue2933.Parity
import System

async func Async() int32 {
    let ch = chan[int32](1)
    ch <- 3
    var result = 0
    select {
        case let value = <-ch { result = 7 + value }
    }
    return result
}

func Sync() int32 {
    let ch = chan[int32](1)
    ch <- 3
    var result = 0
    select {
        case let value = <-ch { result = 7 + value }
    }
    return result
}

Console.WriteLine(Async().GetAwaiter().GetResult())
Console.WriteLine(Sync())`
        let output = CompileLoadAndRun(Source, "AsyncAndSynchronousReceiveBindingsAreEqualAtRuntime")
        let values = output
            .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
            .Select(int32.Parse)
            .ToArray()
        Assert.Equal(2, values.Length)
        Assert.Equal(values[1], values[0])
        Assert.Equal(10, values[0])
    }

    @Fact
    func AsyncIteratorReceiveBindingsMatchAsyncFunctionAtRuntime() {
        const Source = `package Issue2933.StateMachineKinds
import System

async func AsyncFunction() int32 {
    let ch = chan[int32](1)
    ch <- 3
    var result = 0
    select {
        case let value = <-ch { result = 7 + value }
    }
    return result
}

async func YieldInArm() async sequence[int32] {
    let ch = chan[int32](1)
    ch <- 3
    select {
        case let value = <-ch { yield 7 + value }
    }
}

async func YieldAfterArm() async sequence[int32] {
    let ch = chan[int32](1)
    ch <- 3
    var result = 0
    select {
        case let value = <-ch { result = 7 + value }
    }
    yield result
}

func First(values async sequence[int32]) int32 {
    let e = values.GetAsyncEnumerator()
    if e.MoveNextAsync().AsTask().Result { return e.Current }
    return -1
}

Console.WriteLine(AsyncFunction().GetAwaiter().GetResult())
Console.WriteLine(First(YieldInArm()))
Console.WriteLine(First(YieldAfterArm()))`
        let output = CompileLoadAndRun(Source, "AsyncIteratorReceiveBindingsMatchAsyncFunctionAtRuntime")
        let values = output
            .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
            .Select(int32.Parse)
            .ToArray()
        Assert.Equal([]int32{10, 10, 10}, values)
    }

    @Fact
    func SynchronousIteratorReceiveBindingSurvivesYieldAtRuntime() {
        const Source = `package Issue2975.YieldThenRead
import System

func Values() sequence[int32] {
    let ch = chan[int32](1)
    ch <- 33
    select {
        case let value = <-ch {
            yield 11
            yield value
            yield 22
        }
    }
}

for value in Values() {
    Console.WriteLine(value)
}`
        Assert.Equal(
            "11${Environment.NewLine}33${Environment.NewLine}22${Environment.NewLine}",
            CompileLoadAndRun(Source, "SynchronousIteratorReceiveBindingSurvivesYieldAtRuntime")
        )
    }

    @Fact
    func SynchronousIteratorReceiveBindingSurvivesLoopedYieldsAtRuntime() {
        const Source = `package Issue2975.LoopedYields
import System

func Values() sequence[int32] {
    let ch = chan[int32](1)
    ch <- 44
    select {
        case let value = <-ch {
            for i in 0 ... 2 {
                yield 100 + i
            }
            yield value
        }
    }
}

for value in Values() {
    Console.WriteLine(value)
}`
        Assert.Equal(
            "100${Environment.NewLine}101${Environment.NewLine}44${Environment.NewLine}",
            CompileLoadAndRun(Source, "SynchronousIteratorReceiveBindingSurvivesLoopedYieldsAtRuntime")
        )
    }

    @Fact
    func NestedSynchronousIteratorReceiveBindingsSurviveYieldsAtRuntime() {
        const Source = `package Issue2975.NestedSelects
import System

func Values() sequence[int32] {
    let outer = chan[int32](1)
    let inner = chan[int32](1)
    outer <- 55
    inner <- 66
    select {
        case let outerValue = <-outer {
            yield 1
            select {
                case let innerValue = <-inner {
                    yield 2
                    yield innerValue
                }
            }
            yield outerValue
        }
    }
}

for value in Values() {
    Console.WriteLine(value)
}`
        Assert.Equal(
            "1${Environment.NewLine}2${Environment.NewLine}66${Environment.NewLine}55${Environment.NewLine}",
            CompileLoadAndRun(Source, "NestedSynchronousIteratorReceiveBindingsSurviveYieldsAtRuntime")
        )
    }

    @Theory
    @MemberData("SelectShapes")
    func RequestedSelectShapesLoadAndRun(name string, expectedOutput string, source string) {
        Assert.Equal(expectedOutput, CompileLoadAndRun(source, name))
    }

    @Fact
    func SiblingAsyncBindingFormsRemainCorrect() {
        const Source = `package Issue2933.SiblingBindings
import System
import System.Collections.Generic
import System.Threading.Tasks

async func Run() string {
    await Task.Yield()

    var rangeResult = 0
    let values = List[int32]{2, 3}
    for value in values { rangeResult += value }

    var patternResult = 0
    switch object("abc") {
        case value is string { patternResult = value.Length }
        default { patternResult = -1 }
    }

    var catchResult = 0
    try { throw Exception("xy") }
    catch (ex Exception) { catchResult = ex.Message.Length }

    return rangeResult.ToString() + "," +
        patternResult.ToString() + "," +
        catchResult.ToString()
}
Console.WriteLine(Run().GetAwaiter().GetResult())`
        Assert.Equal("5,3,2${Environment.NewLine}", CompileLoadAndRun(Source, "SiblingAsyncBindingFormsRemainCorrect"))
    }

    shared {
        /// Gets requested async-select runtime shapes.
        func SelectShapes() sequence[[]object] {
            yield Case("MultipleAndDefault", "14,5\n", `package Issue2933.MultipleAndDefault
import System

async func Run() string {
    let empty = chan[int32](1)
    let ready = chan[int32](1)
    ready <- 4
    var selected = 0
    select {
        case let ignored = <-empty { selected = -100 }
        case let value = <-ready { selected = 10 + value }
        default { selected = -200 }
    }

    var fallback = 0
    select {
        case let ignored = <-empty { fallback = -100 }
        default { fallback = 5 }
    }
    return selected.ToString() + "," + fallback.ToString()
}
Console.WriteLine(Run().GetAwaiter().GetResult())`)
            yield Case("SendArm", "10\n", `package Issue2933.SendArm
import System

async func Run() int32 {
    let ch = chan[int32](1)
    var result = 0
    select {
        case ch <- 3 { result = 7 }
        default { result = -100 }
    }
    return result + <-ch
}
Console.WriteLine(Run().GetAwaiter().GetResult())`)
            yield Case("LoopAndNested", "6,7\n", `package Issue2933.LoopAndNested
import System

async func Run() string {
    let ch = chan[int32](1)
    var total = 0
    for i in 0 ... 3 {
        ch <- i + 1
        select { case let value = <-ch { total += value } }
    }

    let outer = chan[int32](1)
    let inner = chan[int32](1)
    outer <- 3
    inner <- 4
    var nested = 0
    select {
        case let first = <-outer {
            select {
                case let second = <-inner { nested = first + second }
            }
        }
    }
    return total.ToString() + "," + nested.ToString()
}
Console.WriteLine(Run().GetAwaiter().GetResult())`)
            yield Case("AsyncLambdaAndCapture", "3,3\n", `package Issue2933.AsyncLambdaAndCapture
import System

let run = async () -> {
    let ch = chan[int32](1)
    ch <- 3
    var direct = 0
    var captured = 0
    select {
        case let value = <-ch {
            direct = value
            let read = () -> value
            captured = read()
        }
    }
    return direct.ToString() + "," + captured.ToString()
}
Console.WriteLine(run().GetAwaiter().GetResult())`)
            yield Case("AwaitAfterRead", "6\n", `package Issue2933.AwaitAfterRead
import System
import System.Threading.Tasks

async func Run() int32 {
    let ch = chan[int32](1)
    ch <- 3
    var result = 0
    select {
        case let value = <-ch {
            result = value
            await Task.Yield()
            result += value
        }
    }
    return result
}
Console.WriteLine(Run().GetAwaiter().GetResult())`)
            yield Case("ReferenceAndStruct", "3,31\n", `package Issue2933.ReferenceAndStruct
import System

async func Run() string {
    let refs = chan[string?](1)
    let structs = chan[DateTime](1)
    refs <- "abc"
    structs <- DateTime(2026, 7, 31)
    var refResult = 0
    var structResult = 0
    select {
        case let value = <-refs {
            if value == nil { refResult = -1 }
            else { refResult = value.Length }
        }
    }
    select {
        case let value = <-structs { structResult = value.Day }
    }
    return refResult.ToString() + "," + structResult.ToString()
}
Console.WriteLine(Run().GetAwaiter().GetResult())`)
            yield Case("Unbuffered", "4\n", `package Issue2933.Unbuffered
import System

async func Run() int32 {
    let ch = Chan.Unbounded[int32]()
    ch <- 4
    var result = 0
    select { case let value = <-ch { result = value } }
    return result
}
Console.WriteLine(Run().GetAwaiter().GetResult())`)
            yield Case("ClosedChannelResetsBinding", "30\n", `package Issue2933.ClosedChannel
import System

async func Run() int32 {
    let ch = chan[int32](1)
    ch <- 3
    ch.Close()
    var result = 0
    for i in 0 ... 2 {
        select {
            case let value = <-ch { result = result * 10 + value }
        }
    }
    return result
}
Console.WriteLine(Run().GetAwaiter().GetResult())`)
        }

        private func Case(name string, expectedOutput string, source string)[]object -> []object{
            name,
            expectedOutput,
            source
        }

        private func CompileLoadAndRun(source string, name string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2933AsyncSelectArmBindingTests", name)
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            File.Delete(assemblyPath)
            File.Delete(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            Assert.True(exitCode == 0, ("$name" + `: gsc failed:
` + "$stdout" + `
` + "$stderr"))
            let assembly = EmittedFixture.Load(assemblyPath)
            Assert.NotEmpty(assembly.GetTypes())
            return RunBounded(assemblyPath, name)
        }

        private func RunBounded(assemblyPath string, name string) string {
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
                    },
                    WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            Assert.NotNull(process)
            let outputTask = process!!.StandardOutput.ReadToEndAsync()
            let errorTask = process!!.StandardError.ReadToEndAsync()
            let exited = process!!.WaitForExit(30_000)
            if !exited {
                process!!.Kill(entireProcessTree: true)
                process!!.WaitForExit()
            }
            Assert.True(exited, "$name: emitted program timed out")
            let output = outputTask.GetAwaiter().GetResult()
            let error = errorTask.GetAwaiter().GetResult()
            Assert.True(process!!.ExitCode == 0, ("$name" + `: emitted program failed:
` + "$error"))
            return output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
