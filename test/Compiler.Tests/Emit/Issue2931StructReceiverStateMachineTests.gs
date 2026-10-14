// <copyright file="Issue2931StructReceiverStateMachineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Reflection
import GSharp.Compiler
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Issue #2931: value-type instance state machines must capture the value
/// addressed by the managed-pointer `this` argument, not the pointer bits.
open class Issue2931StructReceiverStateMachineTests {
    @Fact
    func StructIteratorReceiversRetainValueCopies() {
        const Source = `package Issue2931Sync
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
print(Box{N: 101}.receiverVals())`
        AssertRunsWithExactOutput(Source, "StructIteratorReceiversRetainValueCopies", `100
110
120
130
140
150
160
163
3
160
170
170
180
81
82
101
`)
    }

    @Fact
    func AsyncStructIteratorReceiversRetainValueCopies() {
        const Source = `package Issue2931AsyncIterator
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
}`
        AssertRunsWithExactOutput(Source, "AsyncStructIteratorReceiversRetainValueCopies", `200
201
210
211
220
220
230
231
`)
    }

    @Fact
    func AsyncStructMethodReceiversRetainValueCopies() {
        const Source = `package Issue2931AsyncMethod
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
Console.WriteLine(CBox(91).val().Result)`
        AssertRunsWithExactOutput(Source, "AsyncStructMethodReceiversRetainValueCopies", `300
310
320
91
`)
    }

    @Fact
    func NonIteratorStructReceiverControlRemainsCorrect() {
        const Source = `package Issue2931NonIteratorControl
import System

struct Box {
    var N int32
    func val() int32 -> N
}

Console.WriteLine(Box{N: 320}.val())

var box = Box{N: 330}
Console.WriteLine(box.val())`
        AssertRunsWithExactOutput(Source, "NonIteratorStructReceiverControlRemainsCorrect", `320
330
`)
    }

    @Fact
    func ClassIteratorReceiverControlRemainsCorrect() {
        const Source = `package Issue2931ClassControl
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
}`
        AssertRunsWithExactOutput(Source, "ClassIteratorReceiverControlRemainsCorrect", `400
410
`)
    }

    shared {
        private func AssertRunsWithExactOutput(source string, name string, expected string) {
            let assemblyPath = Compile(source, name)
            let assembly = EmittedFixture.Load(assemblyPath)
            Assert.NotEmpty(assembly.GetTypes())
            for var i = 0; i < 6; i++ {
                Assert.Equal(expected, RunBounded(assemblyPath, name))
            }
            IlVerifier.Verify(assemblyPath)
        }

        private func Compile(source string, name string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2931StructReceiverStateMachineTests", name)
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, name + ".dll")
            File.WriteAllText(sourcePath, source)
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
            return assemblyPath
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
