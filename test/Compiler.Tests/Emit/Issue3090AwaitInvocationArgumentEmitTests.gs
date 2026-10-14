// <copyright file="Issue3090AwaitInvocationArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Native compiler coverage for issue #3090 await call arguments.
class Issue3090AwaitInvocationArgumentEmitTests {
    @Fact
    func BareAwaitNamedArgument_PreservesReceiverSourceOrderAndMapping() {
        const Source = `package P
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

run().Wait()`
        let assembly = CompileToAssembly(Source)
        let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let trace FieldInfo? = program.GetField("trace", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal("RIPCO:job:0:2:3", cast[string](trace!!.GetValue(nil)!!))
    }

    @Fact
    func RefAndOutArguments_WithNestedAwait_RemainValid() {
        const Source = `package P
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
result = run().Result`
        let assembly = CompileToAssembly(Source)
        let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let result FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal(77, int32(result!!.GetValue(nil)!!))
    }

    @Fact
    func ConditionalAccess_NestedAwait_StaysInsideNullShortCircuit() {
        const Source = `package P
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

run().Wait()`
        let assembly = CompileToAssembly(Source)
        let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let trace FieldInfo? = program.GetField("trace", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal("DO1CO2", cast[string](trace!!.GetValue(nil)!!))
    }

    shared {
        private func CompileToAssembly(source string) Assembly {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue3090-native", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(
                exitCode == 0,
                "gsc failed:${Environment.NewLine}stdout:${Environment.NewLine}$stdout" +
                    "${Environment.NewLine}stderr:${Environment.NewLine}$stderr"
            )
            IlVerifier.Verify(outputPath)
            return EmittedFixture.Load(outputPath)
        }
    }
}
