// <copyright file="Issue655AsyncIteratorFieldAccessEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Threading.Tasks
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #655: reading a class field from inside an async-yield iterator
/// (`async func ... IAsyncEnumerable[T]`) must not trigger GS9998
/// ("Variable 'X' has no local slot or parameter index").
/// The async-iterator state-machine must capture `this` and proxy
/// all field reads/writes through the captured proxy field.
open class Issue655AsyncIteratorFieldAccessEmitTests {
    @Fact
    func AsyncIterator_FieldRead_As_MethodCallReceiver_No_ICE() {
        // Exact repro from issue #655: Counter.Enter() triggers GS9998.
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Counter {
    var Value int32
    func Enter() { Value++ }
}

class Probe {
    var Counter Counter = Counter()

    async func GetAsync() IAsyncEnumerable[int32] {
        Counter.Enter()
        yield 1
        await Task.Delay(1)
        yield 2
    }
}

public var result = 0
let p = Probe()
let e = p.GetAsync().GetAsyncEnumerator()
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
result = result + p.Counter.Value`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 1 + yield 2 + Counter.Value (incremented once by Enter()) = 4
        Assert.Equal(4, result)
    }

    @Fact
    func AsyncIterator_FieldRead_After_Yield_And_Await() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Sensor {
    var Reading int32

    async func Measure() IAsyncEnumerable[int32] {
        Reading = 10
        yield Reading
        await Task.Delay(1)
        Reading = Reading + 5
        yield Reading
    }
}

public var result = 0
let s = Sensor()
let e = s.Measure().GetAsyncEnumerator()
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 10 + yield 15 = 25
        Assert.Equal(25, result)
    }

    @Fact
    func AsyncIterator_FieldWrite_Before_And_After_FirstYield() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Tracker {
    var Writes int32

    async func Track() IAsyncEnumerable[int32] {
        Writes = 1
        yield Writes
        await Task.Delay(1)
        Writes = 2
        yield Writes
        Writes = 3
    }
}

public var result = 0
let t = Tracker()
let e = t.Track().GetAsyncEnumerator()
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
// Drain the iterator to completion
e.MoveNextAsync().AsTask().Wait()
result = result + t.Writes`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 1 + yield 2 + Writes(3) = 6
        Assert.Equal(6, result)
    }

    @Fact
    func AsyncIterator_FieldAccess_MethodCallOnField_Multiple_Calls() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Accumulator {
    var Total int32
    func Add(n int32) { Total = Total + n }
}

class Worker {
    var Acc Accumulator = Accumulator()

    async func Process() IAsyncEnumerable[int32] {
        Acc.Add(10)
        yield 1
        await Task.Delay(1)
        Acc.Add(20)
        yield 2
        Acc.Add(30)
        yield 3
    }
}

public var result = 0
let w = Worker()
let e = w.Process().GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
result = result + w.Acc.Total`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 1+2+3 + Acc.Total(10+20+30) = 6 + 60 = 66
        Assert.Equal(66, result)
    }

    @Fact
    func AsyncIterator_FieldIncrement_Inside_Iterator() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Sequencer {
    var Step int32

    async func Generate() IAsyncEnumerable[int32] {
        Step++
        yield Step
        await Task.Delay(1)
        Step++
        yield Step
        Step++
        yield Step
    }
}

public var result = 0
let s = Sequencer()
let e = s.Generate().GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 1 + yield 2 + yield 3 = 6
        Assert.Equal(6, result)
    }

    @Fact
    func AsyncIterator_MultipleFieldAccesses_Across_Yields_And_Awaits() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class State {
    var A int32
    var B int32

    async func Compute() IAsyncEnumerable[int32] {
        A = 1
        B = 2
        yield A + B
        await Task.Delay(1)
        A = A + B
        yield A
        await Task.Delay(1)
        B = A + B
        yield B
    }
}

public var result = 0
let s = State()
let e = s.Compute().GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield (1+2)=3 + yield A(1+2)=3 + yield B(3+2)=5 = 11
        Assert.Equal(11, result)
    }

    @Fact
    func AsyncIterator_FieldRead_In_ValuePosition() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Config {
    var Scale int32

    init(s int32) {
        Scale = s
    }

    async func Generate() IAsyncEnumerable[int32] {
        let s = Scale
        yield s
        await Task.Delay(1)
        let s2 = Scale * 2
        yield s2
    }
}

public var result = 0
let c = Config(5)
let e = c.Generate().GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 5 + yield 10 = 15
        Assert.Equal(15, result)
    }

    @Fact
    func AsyncIterator_AsyncSequence_FieldAccess_No_ICE() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Counter {
    var Value int32
    func Enter() { Value++ }
}

class Probe {
    var Counter Counter = Counter()

    async func GetAsync() async sequence[int32] {
        Counter.Enter()
        yield 1
        await Task.Delay(1)
        Counter.Enter()
        yield 2
    }
}

public var result = 0
let p = Probe()
let e = p.GetAsync().GetAsyncEnumerator()
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
result = result + p.Counter.Value`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 1 + yield 2 + Counter.Value (incremented twice) = 5
        Assert.Equal(5, result)
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_655_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            let assembly = EmittedFixture.Load(outPath)
            // Run the entry point
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return assembly
        }

        private func GetResult[T](assembly Assembly) T {
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
            return T(resultField!!.GetValue(nil)!!)
        }
    }
}
