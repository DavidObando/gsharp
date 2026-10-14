// <copyright file="Issue641AsyncIteratorClassMemberEmitTests.cs" company="GSharp">
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

/// Issue #641: async iterator (`async func ... async sequence[T] { yield ... }`)
/// declared as a class member must:
/// 1. Nest the synthesised state-machine type inside the enclosing class (not
/// under `<Program>`) so the kickoff method retains CLR access.
/// 2. Hoist `this` into a `<>4__this` proxy field so the
/// MoveNext body can access instance members across yield/await suspension.
/// Also regression-tests sync iterators on a class and async non-iterator methods.
open class Issue641AsyncIteratorClassMemberEmitTests {
    @Fact
    func AsyncIterator_On_Class_No_Capture_Runs_Without_MethodAccessException() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Producer {
    init() {}

    async func ProduceAsync() async sequence[int32] {
        yield 1
        await Task.Delay(1)
        yield 2
    }
}

public var result = 0
let p = Producer()
let e = p.ProduceAsync().GetAsyncEnumerator()
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(3, result)
    }

    @Fact
    func AsyncIterator_On_Class_Reads_Instance_Field() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Counter(Start int32) {
    async func CountUp() async sequence[int32] {
        yield Start
        await Task.Delay(1)
        yield Start + 1
    }
}

public var result = 0
let c = Counter(10)
let e = c.CountUp().GetAsyncEnumerator()
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(21, result)
    }

    @Fact
    func AsyncIterator_On_Class_Writes_Instance_Field_No_ICE() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class CapturingExecutor {
    var Calls int32
    init() {}

    async func ProduceAsync() async sequence[int32] {
        Calls = Calls + 1
        yield 1
        await Task.Delay(1)
        yield 2
    }
}

public var result = 0
let p = CapturingExecutor()
let e = p.ProduceAsync().GetAsyncEnumerator()
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
result = result + p.Calls`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // 1 + 2 + 1 (Calls incremented once) = 4
        Assert.Equal(4, result)
    }

    @Fact
    func AsyncIterator_On_Class_Calls_Instance_Method() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Doubler(Factor int32) {
    func Apply(n int32) int32 {
        return Factor * n
    }

    async func Produce(x int32) async sequence[int32] {
        yield Apply(x)
        await Task.Delay(1)
        yield Apply(x + 1)
    }
}

public var result = 0
let d = Doubler(3)
let e = d.Produce(2).GetAsyncEnumerator()
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // Apply(2)=6, Apply(3)=9 => 15
        Assert.Equal(15, result)
    }

    @Fact
    func AsyncIterator_On_Class_Uses_Primary_Ctor_Field() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Offset(Base int32) {
    async func Generate(n int32) async sequence[int32] {
        yield Base + n
        await Task.Delay(1)
        yield Base + n + 1
    }
}

public var result = 0
let o = Offset(100)
let e = o.Generate(5).GetAsyncEnumerator()
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // 105 + 106 = 211
        Assert.Equal(211, result)
    }

    @Fact
    func AsyncIterator_On_Class_Multiple_Yield_Await_Interleaved() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Multi {
    init() {}

    async func Items() async sequence[int32] {
        yield 1
        await Task.Delay(1)
        yield 2
        await Task.Delay(1)
        yield 3
        await Task.Delay(1)
        yield 4
    }
}

public var result = 0
let m = Multi()
let e = m.Items().GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(10, result)
    }

    @Fact
    func AsyncIterator_On_Class_Early_Return() {
        // Test conditional exit from async iterator via state reaching end
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Early(Limit int32) {
    async func Items() async sequence[int32] {
        yield 1
        await Task.Delay(1)
        if Limit >= 2 {
            yield 2
        }
    }
}

public var result = 0
let e1 = Early(1)
let iter1 = e1.Items().GetAsyncEnumerator()
for iter1.MoveNextAsync().AsTask().Result {
    result = result + iter1.Current
}

let e2 = Early(5)
let iter2 = e2.Items().GetAsyncEnumerator()
for iter2.MoveNextAsync().AsTask().Result {
    result = result + iter2.Current
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // e1: yields 1 only. e2: yields 1 + 2 = 3. Total = 4
        Assert.Equal(4, result)
    }

    @Fact
    func AsyncIterator_On_Class_Returns_Non_Primitive_Element() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class StringGen(Prefix string) {
    async func Greetings() async sequence[string] {
        yield Prefix + " hello"
        await Task.Delay(1)
        yield Prefix + " world"
    }
}

public var result = ""
let g = StringGen("hi")
let e = g.Greetings().GetAsyncEnumerator()
if e.MoveNextAsync().AsTask().Result {
    result = e.Current
}
if e.MoveNextAsync().AsTask().Result {
    result = result + " " + e.Current
}`
        let assembly = CompileAndRun(source)
        let result string? = GetResult[string](assembly)
        Assert.Equal("hi hello hi world", result)
    }

    @Fact
    func AsyncIterator_State_Machine_Nested_Inside_Declaring_Class() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Yielder {
    init() {}

    async func Items() async sequence[int32] {
        yield 42
        await Task.Delay(1)
    }
}

public var result = 0
let y = Yielder()
let e = y.Items().GetAsyncEnumerator()
if e.MoveNextAsync().AsTask().Result {
    result = e.Current
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(42, result)
        // Verify state-machine type is nested under Yielder
        let yielderType Type? = assembly.GetTypes().SingleOrDefault((t Type) -> t.Name == "Yielder")
        Assert.NotNull(yielderType)
        let nestedTypes = yielderType!!.GetNestedTypes(BindingFlags.NonPublic)
        Assert.Contains(nestedTypes, (t Type) -> t.Name.Contains("<Items>d__"))
    }

    @Fact
    func SyncIterator_On_Class_Reads_Instance_Field_Regression() {
        let source = `package Probe
import System.Collections.Generic

class Repeater(Value int32) {
    func Repeat(n int32) sequence[int32] {
        var i = 0
        for i < n {
            yield Value
            i = i + 1
        }
    }
}

public var result = 0
let r = Repeater(7)
for item in r.Repeat(3) {
    result = result + item
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(21, result)
    }

    @Fact
    func AsyncNonIterator_On_Class_Captures_This_Regression() {
        let source = `package Probe
import System.Threading.Tasks

class Adder(Base int32) {
    async func Add(n int32) int32 {
        await Task.Delay(1)
        return Base + n
    }
}

public var result = 0
let a = Adder(40)
result = a.Add(2).Result`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(42, result)
    }

    @Fact
    func FreeFunctionAsyncIterator_Still_Works() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

async func Generate(start int32) async sequence[int32] {
    yield start
    await Task.Delay(1)
    yield start + 1
}

public var result = 0
let e = Generate(5).GetAsyncEnumerator()
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
if e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(11, result)
    }

    @Fact
    func SyncIterator_On_Class_No_Capture_Nests_Under_Declaring_Class() {
        let source = `package Probe
import System.Collections.Generic

class Simple {
    init() {}

    func Items() sequence[int32] {
        yield 1
        yield 2
        yield 3
    }
}

public var result = 0
let s = Simple()
for item in s.Items() {
    result = result + item
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(6, result)
        // Verify nesting
        let simpleType Type? = assembly.GetTypes().SingleOrDefault((t Type) -> t.Name == "Simple")
        Assert.NotNull(simpleType)
        let nestedTypes = simpleType!!.GetNestedTypes(BindingFlags.NonPublic)
        Assert.Contains(nestedTypes, (t Type) -> t.Name.Contains("<Items>d__"))
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_641_").FullName
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
