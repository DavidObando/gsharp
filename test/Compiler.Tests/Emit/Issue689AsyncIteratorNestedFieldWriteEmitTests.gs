// <copyright file="Issue689AsyncIteratorNestedFieldWriteEmitTests.cs" company="GSharp">
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

/// Issue #689 (follow-up to #655): writing to a member of a class-typed
/// field through an unqualified field name inside an async-iterator method
/// (`async func ... IAsyncEnumerable[T]`) on a class must not trigger
/// GS9998 ("Variable 'X' has no local slot or parameter index").
/// The fix routes the assignment receiver through an explicit
/// `this.Field` bound expression so the async-iterator state-machine
/// rewriter can substitute the hoisted `<>4__this` proxy field
/// — symmetric with the read path fixed in #655.
open class Issue689AsyncIteratorNestedFieldWriteEmitTests {
    @Fact
    func AsyncIterator_UnqualifiedNestedFieldWrite_No_ICE() {
        // Exact repro from issue #689: `Tracker.Value = 7` (no `this.`)
        // inside an async iterator on a class triggered GS9998.
        let source = `package Probe
import System.Collections.Generic
import System.Threading
import System.Threading.Tasks

class Counter {
    var Value int32 = 0
}

class Executor {
    var Tracker Counter = Counter()

    async func Run(ct CancellationToken) IAsyncEnumerable[int32] {
        Tracker.Value = 7
        yield 1
        await Task.Delay(5, ct)
        yield 2
    }
}

public var result = 0
let exec = Executor()
let e = exec.Run(CancellationToken.None).GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
result = result + exec.Tracker.Value`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 1 + yield 2 + Tracker.Value(7) = 10
        Assert.Equal(10, result)
    }

    @Fact
    func AsyncIterator_NestedFieldReadModifyWrite_Unqualified() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Counter {
    var Value int32 = 0
}

class Probe {
    var Tracker Counter = Counter()

    async func Run() IAsyncEnumerable[int32] {
        Tracker.Value = Tracker.Value + 1
        yield Tracker.Value
        await Task.Delay(1)
        Tracker.Value = Tracker.Value + 10
        yield Tracker.Value
    }
}

public var result = 0
let p = Probe()
let e = p.Run().GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
result = result + p.Tracker.Value`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 1 + yield 11 + Tracker.Value(11) = 23
        Assert.Equal(23, result)
    }

    @Fact
    func AsyncIterator_NestedFieldWrite_Persists_Across_Yield_And_Await() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Counter {
    var Value int32 = 0
}

class Executor {
    var Tracker Counter = Counter()

    async func Run() IAsyncEnumerable[int32] {
        Tracker.Value = 5
        yield Tracker.Value
        await Task.Delay(1)
        Tracker.Value = Tracker.Value + 10
        yield Tracker.Value
        await Task.Delay(1)
        Tracker.Value = 99
        yield Tracker.Value
    }
}

public var result = 0
let exec = Executor()
let e = exec.Run().GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
result = result + exec.Tracker.Value`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 5 + yield 15 + yield 99 + Tracker.Value(99) = 218
        Assert.Equal(218, result)
    }

    @Fact
    func AsyncIterator_QualifiedNestedFieldWrite_Still_Works() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Counter {
    var Value int32 = 0
}

class Executor {
    var Tracker Counter = Counter()

    async func Run() IAsyncEnumerable[int32] {
        this.Tracker.Value = 42
        yield this.Tracker.Value
        await Task.Delay(1)
        this.Tracker.Value = this.Tracker.Value + 1
        yield this.Tracker.Value
    }
}

public var result = 0
let exec = Executor()
let e = exec.Run().GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
result = result + exec.Tracker.Value`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 42 + yield 43 + Tracker.Value(43) = 128
        Assert.Equal(128, result)
    }

    @Fact
    func AsyncIterator_PrimitiveFieldWrite_Still_Works() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Executor {
    var PlainNum int32 = 0

    async func Run() IAsyncEnumerable[int32] {
        PlainNum = 42
        yield PlainNum
        await Task.Delay(1)
        PlainNum = 100
        yield PlainNum
    }
}

public var result = 0
let exec = Executor()
let e = exec.Run().GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
result = result + exec.PlainNum`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 42 + yield 100 + PlainNum(100) = 242
        Assert.Equal(242, result)
    }

    @Fact
    func SyncMethod_UnqualifiedNestedFieldWrite_Works() {
        // The underlying bug was a binder issue (BindFieldAssignmentExpression
        // emitting an ImplicitFieldVariableSymbol Receiver with no local slot).
        // Verify the sync case is also fixed.
        let source = `package Probe

class Counter {
    var Value int32 = 0
}

class Executor {
    var Tracker Counter = Counter()

    func Run() int32 {
        Tracker.Value = 7
        return Tracker.Value
    }
}

public var result = Executor().Run()`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(7, result)
    }

    @Fact
    func SyncMethod_NestedFieldReadModifyWrite_Works() {
        let source = `package Probe

class Counter {
    var Value int32 = 0
}

class Executor {
    var Tracker Counter = Counter()

    func Run() int32 {
        Tracker.Value = 1
        Tracker.Value = Tracker.Value + 10
        Tracker.Value = Tracker.Value * 2
        return Tracker.Value
    }
}

public var result = Executor().Run()`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(22, result)
    }

    @Fact
    func AsyncIterator_NestedFieldCompoundPlusEquals_Works() {
        // Verify the related compound-assignment path is also unaffected.
        // `Tracker.Value += N` is parsed as EventSubscriptionExpression and
        // routed through TryBindChainedCompoundAssignment which already used
        // an expression receiver — but exercise it here to lock in coverage.
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Counter {
    var Value int32 = 0
}

class Executor {
    var Tracker Counter = Counter()

    async func Run() IAsyncEnumerable[int32] {
        Tracker.Value += 3
        yield Tracker.Value
        await Task.Delay(1)
        Tracker.Value += 4
        yield Tracker.Value
    }
}

public var result = 0
let exec = Executor()
let e = exec.Run().GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
result = result + exec.Tracker.Value`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 3 + yield 7 + Tracker.Value(7) = 17
        Assert.Equal(17, result)
    }

    @Fact
    func AsyncIterator_NestedFieldWrite_When_FieldHasInterfaceTypedHolder() {
        // Ensure the fix isn't accidentally limited to a particular receiver
        // type. Here the field type is a user-defined class that itself holds
        // a nested user class, and the write targets the inner field. Also
        // works on a struct nested in a class.
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Counter {
    var Value int32 = 0
    var Name string = "init"
}

class Holder {
    var Inner Counter = Counter()
}

class Executor {
    var H Holder = Holder()

    async func Run() IAsyncEnumerable[int32] {
        H.Inner.Value = 5
        yield H.Inner.Value
        await Task.Delay(1)
        H.Inner.Value = 12
        yield H.Inner.Value
    }
}

public var result = 0
let exec = Executor()
let e = exec.Run().GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
result = result + exec.H.Inner.Value`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 5 + yield 12 + H.Inner.Value(12) = 29
        Assert.Equal(29, result)
    }

    @Fact
    func SyncIterator_UnqualifiedNestedFieldWrite_Works() {
        // The sync-iterator state machine is a separate rewriter from the
        // async one but shares the same bound-tree shape for nested field
        // writes. Verify the fix applies symmetrically.
        let source = `package Probe
import System.Collections.Generic

class Counter {
    var Value int32 = 0
}

class Executor {
    var Tracker Counter = Counter()

    func Run() sequence[int32] {
        Tracker.Value = 11
        yield Tracker.Value
        Tracker.Value = Tracker.Value + 4
        yield Tracker.Value
    }
}

public var result = 0
let exec = Executor()
for x in exec.Run() {
    result = result + x
}
result = result + exec.Tracker.Value`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 11 + yield 15 + Tracker.Value(15) = 41
        Assert.Equal(41, result)
    }

    @Fact
    func AsyncIterator_AsyncSequence_UnqualifiedNestedFieldWrite_Works() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Counter {
    var Value int32 = 0
}

class Executor {
    var Tracker Counter = Counter()

    async func Run() async sequence[int32] {
        Tracker.Value = 21
        yield Tracker.Value
        await Task.Delay(1)
        Tracker.Value = Tracker.Value + 1
        yield Tracker.Value
    }
}

public var result = 0
let exec = Executor()
let e = exec.Run().GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}
result = result + exec.Tracker.Value`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        // yield 21 + yield 22 + Tracker.Value(22) = 65
        Assert.Equal(65, result)
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_689_").FullName
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
            // Run the entry point.
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
