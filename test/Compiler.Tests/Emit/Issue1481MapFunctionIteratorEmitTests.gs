// <copyright file="Issue1481MapFunctionIteratorEmitTests.cs" company="GSharp">
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

/// Issue #1481 — a generic iterator whose element type is built from a
/// `map[K, T]` or a function type (`func(T) -> int32`) must emit
/// strongly-typed `IEnumerable<…>` / `IEnumerator<…>`
/// interface rows that preserve the iterator's type parameter as a reified
/// `Var(0)` slot — not the type-erased `<object>` shape.
///
/// Before the fix, the emit layer re-implemented the "does this type
/// structurally reference a type parameter?" walk three separate times, and
/// the two emit-layer copies omitted `MapTypeSymbol` /
/// `FunctionTypeSymbol`. A generic iterator yielding `map[string, T]`
/// could not even be emitted (the signature encoder threw
/// "Cannot encode signature for type 'map[string,T]'"). The fix:
///
/// - Consolidates the three walks into the single canonical `TypeSymbol.AnyTypeParameter` walker
/// (covered by the Core-side unit tests).
/// - Teaches the signature encoder to reify a null-ClrType `map[K, V]` as `GENERICINST Dictionary`2<K,
/// V>`, with a matching reified body construction (`GetMapCtorReference` / `GetMapSetItemReference`).
/// - Recognises that `map` / function reference values widen to `object` as a no-op in the non-generic
/// `IEnumerator.Current` getter.
/// - Substitutes through `map[K, V]` at a closed generic call site so the consuming `for`-loop binds
/// the strongly-typed element.
/// Every user type in this file carries a unique `Issue1481`-prefixed
/// name because the name-keyed function-type cache is not cleared between
/// in-process emit tests.
open class Issue1481MapFunctionIteratorEmitTests {
    @Fact
    func StateMachineClass_MapElement_ImplementsIEnumerableOfReifiedDictionary() {
        // `sequence[map[string, T]]`: the synthesized SM class must list a
        // generic `IEnumerable<Dictionary<string, T>>` interface closed over
        // its own Var(0), not the type-erased `IEnumerable<object>` shape.
        let source = `package Probe
import System.Collections.Generic

class Issue1481MapRows {
    shared {
        func MapRowsEntries[T any](items []T) sequence[map[string, T]] {
            for v in items {
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
        AssertImplementsEnumerableOf(
            smType,
            (i Type) -> {
                if !i.IsGenericType || i.GetGenericTypeDefinition() != typeof(Dictionary[_, _]) {
                    return false
                }
                let dictArgs = i.GetGenericArguments()
                return dictArgs[0] == typeof(string) && dictArgs[1] == typeParams[0]
            }
        )
        // The `<>2__current` field and get_Current must agree with the rows.
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
    func StateMachineClass_FunctionElement_ImplementsIEnumerableOfReifiedFunc() {
        // `sequence[(T) -> int32]`: the SM must list a generic
        // `IEnumerable<Func<T, int>>` interface closed over its own Var(0).
        let source = `package Probe
import System.Collections.Generic

class Issue1481FuncRows {
    shared {
        func FuncRowsEntries[T any](items []T) sequence[(T) -> int32] {
            for v in items {
                yield func(x T) int32 { return 0 }
            }
        }
    }
}`
        let assembly = CompileLibrary(source)
        let smType = SingleStateMachine(assembly, "<FuncRowsEntries>d__")
        let typeParams = smType.GetGenericArguments()
        Assert.Single(typeParams)
        AssertImplementsEnumerableOf(
            smType,
            (i Type) -> {
                if !i.IsGenericType || i.GetGenericTypeDefinition() != typeof(Func[_, _]) {
                    return false
                }
                let funcArgs = i.GetGenericArguments()
                return funcArgs[0] == typeParams[0] && funcArgs[1] == typeof(int32)
            }
        )
    }

    @Fact
    func StateMachineClass_MapOfListElement_PreservesTypeParameter_AndVerifies() {
        // ADR-0087 requires nested arguments to retain the state machine's type parameter.
        let source = `package Probe
import System.Collections.Generic

class Issue1481MapListRows {
    shared {
        func MapListEntries[T any](items []T) sequence[map[string, List[T]]] {
            for v in items {
                let m = map[string, List[T]]{}
                yield m
            }
        }
    }
}`
        let assembly = CompileLibrary(source)
        let smType = SingleStateMachine(assembly, "<MapListEntries>d__")
        let typeParameter = Assert.Single(smType.GetGenericArguments())
        AssertImplementsEnumerableOf(
            smType,
            (i Type) -> {
                if !i.IsGenericType || i.GetGenericTypeDefinition() != typeof(Dictionary[_, _]) {
                    return false
                }
                let dictArgs = i.GetGenericArguments()
                if dictArgs[0] != typeof(string) {
                    return false
                }
                return dictArgs[1].IsGenericType && dictArgs[1].GetGenericTypeDefinition() == typeof(List[_]) &&
                    dictArgs[1].GetGenericArguments()[0] == typeParameter
            }
        )
    }

    @Fact
    func MapIterator_RunsEndToEnd_WithStronglyTypedIntValues() {
        // Consuming a closed `MapRun[int32]` must surface `map[string, int32]`
        // elements whose indexer returns a strongly-typed `int32` (not `T`),
        // proving the closed call-site substitution descends into the map.
        let source = `package Probe
import System.Collections.Generic

class Issue1481MapRun {
    shared {
        func MapRunEntries[T any](items []T) sequence[map[string, T]] {
            for v in items {
                let m = map[string, T]{"key": v}
                yield m
            }
        }
    }
}

public var total = 0
public var count = 0
for d in Issue1481MapRun.MapRunEntries[int32]([]int32{5, 9, 14}) {
    total = total + d["key"]
    count = count + 1
}`
        let assembly = CompileAndRun(source)
        Assert.Equal(3, GetIntField(assembly, "count"))
        Assert.Equal(28, GetIntField(assembly, "total"))
    }

    @Fact
    func MapIterator_RunsEndToEnd_WithStronglyTypedStringValues() {
        let source = `package Probe
import System.Collections.Generic

class Issue1481MapRunStr {
    shared {
        func MapRunStrEntries[T any](items []T) sequence[map[string, T]] {
            for v in items {
                let m = map[string, T]{"key": v}
                yield m
            }
        }
    }
}

public var concat = ""
for d in Issue1481MapRunStr.MapRunStrEntries[string]([]string{"a", "b", "c"}) {
    concat = concat + d["key"]
}`
        let assembly = CompileAndRun(source)
        Assert.Equal("abc", GetStringField(assembly, "concat"))
    }

    @Fact
    func FunctionIterator_RunsEndToEnd() {
        // A generic iterator yielding `func(T) -> int32` values must emit and
        // verify, and the yielded delegates must be invokable at runtime.
        let source = `package Probe
import System.Collections.Generic

class Issue1481FuncRun {
    shared {
        func FuncRunEntries[T any](items []T) sequence[(T) -> int32] {
            for v in items {
                yield func(x T) int32 { return 11 }
            }
        }
    }
}

public var total = 0
for f in Issue1481FuncRun.FuncRunEntries[int32]([]int32{1, 2, 3}) {
    total = total + f(0)
}`
        let assembly = CompileAndRun(source)
        Assert.Equal(33, GetIntField(assembly, "total"))
    }

    shared {
        private func SingleStateMachine(assembly Assembly, prefix string) Type -> assembly.GetTypes().Single(
            (t Type) -> t.IsNested && t.Name.StartsWith(prefix, StringComparison.Ordinal)
        )

        private func AssertImplementsEnumerableOf(smType Type, elementMatches(Type) -> bool) {
            let ok = smType.GetInterfaces().Any(
                (i Type) -> i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable[_]) &&
                    elementMatches(i.GetGenericArguments()[0])
            )
            Assert.True(
                ok,
                "State machine '${smType.FullName}' must implement the expected reified IEnumerable<…> row. " +
                    "Actual interfaces: ${string.Join(", ", smType.GetInterfaces().Select((i Type) -> i.FullName))}"
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
            let tempDir = Directory.CreateTempSubdirectory("gs_1481_").FullName
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
