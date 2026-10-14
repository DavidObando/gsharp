// <copyright file="Issue2965ChannelElementSlotTests.cs" company="GSharp">
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

/// Issue #2965: channel signatures, locals, and member references must retain
/// same-compilation value-type element identities instead of erasing them to
/// (cref:object).
open class Issue2965ChannelElementSlotTests {
    @Fact
    func SendOnlyUserStructChannel_LoadsVerifiesAndRuns() {
        const Source = `package Issue2965SendOnly
import System

data struct Pair(Value int32)

let ch = chan[Pair](1)
ch <- Pair(41)
Console.WriteLine(1)`
        AssertRuns(Source, "SendOnlyUserStructChannel_LoadsVerifiesAndRuns", "1\n")
    }

    @Fact
    func ChannelElementMatrix_LoadsVerifiesAndRuns() {
        const Source = `package Issue2965Matrix
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
Console.WriteLine(asyncSelectPair().Result)`
        AssertRuns(Source, "ChannelElementMatrix_LoadsVerifiesAndRuns", `41
42
55
43
44
45
46
47
54
48
49
2020
0
0
51
52
53
50
56
`)
    }

    shared {
        private func AssertRuns(source string, name string, expected string) {
            let assemblyPath = Compile(source, name)
            let assembly = EmittedFixture.Load(assemblyPath)
            Assert.NotEmpty(assembly.GetTypes())
            for var i = 0; i < 3; i++ {
                Assert.Equal(expected, RunBounded(assemblyPath, name))
            }
            IlVerifier.Verify(assemblyPath)
        }

        private func Compile(source string, name string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2965ChannelElementSlotTests", name)
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
            let exited = process!!.WaitForExit(10_000)
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
