// <copyright file="Issue1489GenericAsyncIteratorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #1489 — a GENERIC async iterator (both `async` and returning
/// `sequence[…]` / `IAsyncEnumerable[…]` over the function's own
/// type parameter) must synthesize a generic state machine, emit strongly-typed
/// `IAsyncEnumerable<…>` / `IAsyncEnumerator<…>` rows that
/// preserve the type parameter as a reified `Var(0)` slot, and run
/// end-to-end ilverify-clean.
///
/// Before the fix, async-iterator detection and method-builder resolution were
/// re-implemented across four <em>ClrType-only</em> predicates
/// (`AsyncIteratorRewriter`, `AsyncStateMachineRewriter`,
/// `AsyncEmitPrecheck`, and `AsyncIteratorPlan.IsEnumerable`). For a
/// generic async iterator the return type is an `AsyncSequenceTypeSymbol`
/// over an open type parameter whose `ClrType` is `null`,
/// so three of those copies failed to recognise it: the function was mis-routed
/// into the plain-async state-machine pass (where the builder could not be
/// resolved) and reported as GS0190. The fix routes every site through the
/// shared `AsyncIteratorDetection` helper and teaches
/// `SynthesizeAsyncIteratorStateMachines` to reify the SM class generic
/// over the kickoff method's type parameters — mirroring the sync generic
/// iterator path (#810/#1465) and the #1481 element-shape reification.
///
/// Every type / function / package in this file carries a unique
/// `Issue1489`-prefixed name because the name-keyed FunctionTypeSymbol
/// cache is not cleared between in-process emit tests.
open class Issue1489GenericAsyncIteratorEmitTests {
    @Fact
    func StateMachine_BareElement_IsGeneric_ImplementsAsyncEnumerableOfVar0() {
        // `async sequence[T]`: the synthesized SM class must be generic and
        // implement both IAsyncEnumerable<T> AND IAsyncEnumerator<T> closed
        // over its own Var(0) — not the type-erased <object> shape, and not
        // only the enumerator (the #1489 IsEnumerable gap dropped the
        // IAsyncEnumerable row + GetAsyncEnumerator entirely).
        let source = `package Probe
import System.Collections.Generic

class Issue1489BareRows {
    shared {
        async func BareRowsEntries[T any](items []T) sequence[T] {
            for v in items {
                yield v
            }
        }
    }
}`
        let assembly = CompileLibrary(source)
        let smType = SingleStateMachine(assembly, "<BareRowsEntries>d__")
        Assert.True(smType.IsGenericTypeDefinition)
        let typeParams = smType.GetGenericArguments()
        Assert.Single(typeParams)
        AssertImplementsGenericOf(smType, typeof(IAsyncEnumerable[_]), (args[]Type) -> args[0] == typeParams[0])
        AssertImplementsGenericOf(smType, typeof(IAsyncEnumerator[_]), (args[]Type) -> args[0] == typeParams[0])
        let currentField FieldInfo? = smType.GetField(
            "<>2__current",
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
        )
        Assert.NotNull(currentField)
        Assert.Equal(typeParams[0], currentField!!.FieldType)
        let getAsyncEnumerator MethodInfo? = smType.GetMethod(
            "GetAsyncEnumerator",
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
        )
        Assert.NotNull(getAsyncEnumerator)
        let ret = getAsyncEnumerator!!.ReturnType
        Assert.True(ret.IsGenericType && ret.GetGenericTypeDefinition() == typeof(IAsyncEnumerator[_]))
        Assert.Equal(typeParams[0], ret.GetGenericArguments()[0])
    }

    @Fact
    func StateMachine_MapElement_ImplementsAsyncEnumerableOfReifiedDictionary() {
        // `async sequence[map[string, T]]`: the SM must list a generic
        // IAsyncEnumerable<Dictionary<string, T>> closed over its own Var(0).
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Issue1489MapRows {
    shared {
        async func MapRowsEntries[T any](items []T) sequence[map[string, T]] {
            for v in items {
                await Task.Delay(1)
                let m = map[string, T]{}
                yield m
            }
        }
    }
}`
        let assembly = CompileLibrary(source)
        let smType = SingleStateMachine(assembly, "<MapRowsEntries>d__")
        Assert.True(smType.IsGenericTypeDefinition)
        let typeParams = smType.GetGenericArguments()
        Assert.Single(typeParams)
        AssertImplementsGenericOf(
            smType,
            typeof(IAsyncEnumerable[_]),
            (args[]Type) -> {
                let element = args[0]
                return element.IsGenericType && element.GetGenericTypeDefinition() == typeof(Dictionary[_, _]) &&
                    element.GetGenericArguments()[0] == typeof(string) &&
                    element.GetGenericArguments()[1] == typeParams[0]
            }
        )
        let currentField FieldInfo? = smType.GetField(
            "<>2__current",
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
        )
        Assert.NotNull(currentField)
        let fieldType = currentField!!.FieldType
        Assert.True(fieldType.IsGenericType && fieldType.GetGenericTypeDefinition() == typeof(Dictionary[_, _]))
        Assert.Equal(typeof(string), fieldType.GetGenericArguments()[0])
        Assert.Equal(typeParams[0], fieldType.GetGenericArguments()[1])
    }

    @Fact
    func StateMachine_FunctionElement_ImplementsAsyncEnumerableOfReifiedFunc() {
        // `async sequence[(T) -> int32]`: the SM must list a generic
        // IAsyncEnumerable<Func<T, int>> closed over its own Var(0).
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Issue1489FuncRows {
    shared {
        async func FuncRowsEntries[T any](items []T) sequence[(T) -> int32] {
            for v in items {
                await Task.Delay(1)
                yield func(x T) int32 { return 0 }
            }
        }
    }
}`
        let assembly = CompileLibrary(source)
        let smType = SingleStateMachine(assembly, "<FuncRowsEntries>d__")
        Assert.True(smType.IsGenericTypeDefinition)
        let typeParams = smType.GetGenericArguments()
        Assert.Single(typeParams)
        AssertImplementsGenericOf(
            smType,
            typeof(IAsyncEnumerable[_]),
            (args[]Type) -> {
                let element = args[0]
                return element.IsGenericType && element.GetGenericTypeDefinition() == typeof(Func[_, _]) &&
                    element.GetGenericArguments()[0] == typeParams[0] &&
                    element.GetGenericArguments()[1] == typeof(int32)
            }
        )
    }

    @Fact
    func BareElement_RunsEndToEnd_WithStronglyTypedIntValues() {
        // The #1489 repro: `async func gen[T](x T) sequence[T]` consumed via
        // `await for`. The yielded values must be strongly-typed int32 and the
        // body actually suspends on an await between yields.
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Issue1489BareRun {
    shared {
        async func BareRunEntries[T any](items []T) sequence[T] {
            for v in items {
                await Task.Delay(1)
                yield v
            }
        }
    }
}

public var total = 0
public var count = 0
async func Issue1489BareRunMain() {
    await for n in Issue1489BareRun.BareRunEntries[int32]([]int32{5, 9, 14}) {
        total = total + n
        count = count + 1
    }
}
Issue1489BareRunMain().Wait()`
        let assembly = CompileAndRun(source)
        Assert.Equal(3, GetIntField(assembly, "count"))
        Assert.Equal(28, GetIntField(assembly, "total"))
    }

    @Fact
    func BareElement_RunsEndToEnd_WithStronglyTypedStringValues() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Issue1489BareRunStr {
    shared {
        async func BareRunStrEntries[T any](items []T) sequence[T] {
            for v in items {
                await Task.Delay(1)
                yield v
            }
        }
    }
}

public var concat = ""
async func Issue1489BareRunStrMain() {
    await for s in Issue1489BareRunStr.BareRunStrEntries[string]([]string{"a", "b", "c"}) {
        concat = concat + s
    }
}
Issue1489BareRunStrMain().Wait()`
        let assembly = CompileAndRun(source)
        Assert.Equal("abc", GetStringField(assembly, "concat"))
    }

    @Fact
    func MapElement_RunsEndToEnd_WithStronglyTypedIntValues() {
        // Consuming `MapRun[int32]` must surface `map[string, int32]` elements
        // whose indexer returns a strongly-typed int32 (not T), proving the
        // closed call-site substitution descends into the map.
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Issue1489MapRun {
    shared {
        async func MapRunEntries[T any](items []T) sequence[map[string, T]] {
            for v in items {
                await Task.Delay(1)
                let m = map[string, T]{"key": v}
                yield m
            }
        }
    }
}

public var total = 0
async func Issue1489MapRunMain() {
    await for d in Issue1489MapRun.MapRunEntries[int32]([]int32{5, 9, 14}) {
        total = total + d["key"]
    }
}
Issue1489MapRunMain().Wait()`
        let assembly = CompileAndRun(source)
        Assert.Equal(28, GetIntField(assembly, "total"))
    }

    @Fact
    func FunctionElement_RunsEndToEnd() {
        // A generic async iterator yielding `func(T) -> int32` values must emit,
        // verify, and the yielded delegates must be invokable at runtime.
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Issue1489FuncRun {
    shared {
        async func FuncRunEntries[T any](items []T) sequence[(T) -> int32] {
            for v in items {
                await Task.Delay(1)
                yield func(x T) int32 { return 11 }
            }
        }
    }
}

public var total = 0
async func Issue1489FuncRunMain() {
    await for f in Issue1489FuncRun.FuncRunEntries[int32]([]int32{1, 2, 3}) {
        total = total + f(0)
    }
}
Issue1489FuncRunMain().Wait()`
        let assembly = CompileAndRun(source)
        Assert.Equal(33, GetIntField(assembly, "total"))
    }

    @Fact
    func MixedYieldAndAwait_SuspendsBetweenYields_AccumulatesCorrectly() {
        // The body interleaves awaits and yields (and awaits AFTER the final
        // yield), exercising real suspension/resume across the generic SM.
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Issue1489Mixed {
    shared {
        async func MixedEntries[T any](a T, b T, c T) sequence[T] {
            await Task.Delay(1)
            yield a
            await Task.Delay(1)
            yield b
            await Task.Delay(1)
            yield c
            await Task.Delay(1)
        }
    }
}

public var total = 0
public var count = 0
async func Issue1489MixedMain() {
    await for n in Issue1489Mixed.MixedEntries[int32](4, 8, 16) {
        total = total + n
        count = count + 1
    }
}
Issue1489MixedMain().Wait()`
        let assembly = CompileAndRun(source)
        Assert.Equal(3, GetIntField(assembly, "count"))
        Assert.Equal(28, GetIntField(assembly, "total"))
    }

    @Fact
    func GenericAsyncIterator_InGenericClass_ClassAndMethodTypeParameters() {
        // The most complex shape: an async iterator method declaring its own
        // type parameter V, nested inside a GENERIC class Holder[U]. The SM is
        // reified over [U, V] (enclosing class TP first, then method TP).
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Issue1489Holder[U any] {
    async func Produce[V any](items []V) sequence[V] {
        for v in items {
            await Task.Delay(1)
            yield v
        }
    }
}

public var total = 0
async func Issue1489HolderMain() {
    let h = Issue1489Holder[string]()
    await for n in h.Produce[int32]([]int32{4, 5, 6}) {
        total = total + n
    }
}
Issue1489HolderMain().Wait()`
        let assembly = CompileAndRun(source)
        Assert.Equal(15, GetIntField(assembly, "total"))
    }

    @Fact
    func Control_NonGenericAsyncIterator_StillRuns() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Issue1489NonGeneric {
    shared {
        async func Nums() sequence[int32] {
            yield 1
            await Task.Delay(1)
            yield 2
        }
    }
}

public var sum = 0
async func Issue1489NonGenericMain() {
    await for n in Issue1489NonGeneric.Nums() {
        sum = sum + n
    }
}
Issue1489NonGenericMain().Wait()`
        let assembly = CompileAndRun(source)
        Assert.Equal(3, GetIntField(assembly, "sum"))
    }

    @Fact
    func Control_SyncGenericIterator_StillRuns() {
        let source = `package Probe
import System.Collections.Generic

class Issue1489SyncGeneric {
    shared {
        func Entries[T any](items []T) sequence[T] {
            for v in items {
                yield v
            }
        }
    }
}

public var total = 0
for n in Issue1489SyncGeneric.Entries[int32]([]int32{7, 8, 9}) {
    total = total + n
}`
        let assembly = CompileAndRun(source)
        Assert.Equal(24, GetIntField(assembly, "total"))
    }

    shared {
        private func SingleStateMachine(assembly Assembly, prefix string) Type -> assembly.GetTypes().Single(
            (t Type) -> t.IsNested && t.Name.StartsWith(prefix, StringComparison.Ordinal)
        )

        private func AssertImplementsGenericOf(smType Type, openInterface Type, argsMatch([]Type) -> bool) {
            let ok = smType.GetInterfaces().Any(
                (i Type) -> i.IsGenericType && i.GetGenericTypeDefinition() == openInterface &&
                    argsMatch(i.GetGenericArguments())
            )
            Assert.True(
                ok,
                "State machine '${smType.FullName}' must implement the expected reified " +
                    "${openInterface.Name} row. Actual interfaces: " +
                    string.Join(", ", smType.GetInterfaces().Select((i Type) -> i.FullName))
            )
        }

        private func CompileAndRun(source string) Assembly {
            let outPath = CompileToFile(source, target: "exe")
            let assembly = EmittedFixture.Load(outPath)
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

        private func CompileLibrary(source string) Assembly {
            let outPath = CompileToFile(source, target: "library")
            return EmittedFixture.Load(outPath)
        }

        private func CompileToFile(source string, target string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1489_").FullName
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
                    []string{"/out:" + outPath, "/target:" + target, "/targetframework:net10.0", srcPath}
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
            return outPath
        }

        private func GetIntField(assembly Assembly, name string) int32 {
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let field FieldInfo? = program.GetField(name, BindingFlags.Public | BindingFlags.Static)
            return int32(field!!.GetValue(nil)!!)
        }

        private func GetStringField(assembly Assembly, name string) string? {
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let field FieldInfo? = program.GetField(name, BindingFlags.Public | BindingFlags.Static)
            return cast[string](field!!.GetValue(nil)!!)
        }
    }
}
