// <copyright file="Issue821SliceToInterfaceAtArgumentSlotEmitTests.cs" company="GSharp">
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

/// Issue #821: end-to-end emit + IL-verify coverage for the slice-to-interface
/// implicit conversion applied at ordinary argument slots (static-method
/// and free-function call sites). Mirrors the binder coverage in
/// `Issue821SliceToInterfaceAtArgumentSlotBindingTests` and complements
/// the receiver-call coverage that #570/#774 already pinned.
/// @remarks These cases close the gap noted while shipping #813 — the sample's
/// `Sequences.Indexed[T](source IEnumerable[T])` shape now binds, emits
/// verifier-clean IL, and produces the expected runtime values when a
/// `[]int32` or `[]string` slice is passed at the static-call
/// argument slot.
open class Issue821SliceToInterfaceAtArgumentSlotEmitTests {
    @Fact
    func StaticGeneric_IEnumerableOfT_AcceptsSliceLiteral_RunsForInt32() {
        // The literal issue repro: `Sequences.Indexed[int32](ints)`
        // with `Indexed` declared as `func Indexed[T](source IEnumerable[T])`.
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Indexed[T](source IEnumerable[T]) sequence[(int32, T)] {
            var index = 0
            for v in source {
                yield (index, v)
                index = index + 1
            }
        }
    }
}

public var sumIdx = 0
public var sumVal = 0
let ints = []int32{10, 20, 30}
for p in Sequences.Indexed[int32](ints) {
    sumIdx = sumIdx + p.Item1
    sumVal = sumVal + p.Item2
}`
        let assembly = CompileAndRun(source)
        Assert.Equal(3, GetIntField(assembly, "sumIdx"))
        Assert.Equal(60, GetIntField(assembly, "sumVal"))
    }

    @Fact
    func StaticGeneric_IEnumerableOfT_AcceptsSliceLiteral_RunsForString() {
        // String-typed closure of the same shape — confirms the runtime
        // representation is identical for value-type and reference-type
        // element types.
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Indexed[T](source IEnumerable[T]) sequence[(int32, T)] {
            var index = 0
            for v in source {
                yield (index, v)
                index = index + 1
            }
        }
    }
}

public var sumIdx = 0
public var concat = ""
for p in Sequences.Indexed[string]([]string{"a", "b", "c"}) {
    sumIdx = sumIdx + p.Item1
    concat = concat + p.Item2
}`
        let assembly = CompileAndRun(source)
        Assert.Equal(3, GetIntField(assembly, "sumIdx"))
        Assert.Equal("abc", GetStringField(assembly, "concat"))
    }

    @Fact
    func FreeFunctionArgSlot_IEnumerableOfT_AcceptsSliceLiteral_Runs() {
        // Free-function call slot variant.
        let source = `package Probe
import System.Collections.Generic

func Count[T](source IEnumerable[T]) int32 {
    var n = 0
    for _ in source {
        n = n + 1
    }
    return n
}

public var n = Count[int32]([]int32{10, 20, 30})`
        let assembly = CompileAndRun(source)
        Assert.Equal(3, GetIntField(assembly, "n"))
    }

    @Fact
    func StaticGeneric_IListOfT_AcceptsSliceLiteral_Runs() {
        // `IList[T]` interface — slice satisfies it via the backing CLR array.
        let source = `package Probe
import System.Collections.Generic

class Sink {
    shared {
        func Take[T](source IList[T]) int32 { return source.Count }
    }
}

public var n = Sink.Take[int32]([]int32{1, 2, 3})`
        let assembly = CompileAndRun(source)
        Assert.Equal(3, GetIntField(assembly, "n"))
    }

    @Fact
    func StaticGeneric_ICollectionOfT_AcceptsSliceLiteral_Runs() {
        // `ICollection[T]` — slice satisfies it via the backing CLR array.
        let source = `package Probe
import System.Collections.Generic

class Sink {
    shared {
        func Take[T](source ICollection[T]) int32 { return source.Count }
    }
}

public var n = Sink.Take[int32]([]int32{1, 2, 3, 4})`
        let assembly = CompileAndRun(source)
        Assert.Equal(4, GetIntField(assembly, "n"))
    }

    @Fact
    func StaticGeneric_IReadOnlyListOfT_AcceptsSliceLiteral_Runs() {
        // `IReadOnlyList[T]` — slice satisfies it via the backing CLR
        // array. Returns `int32` (not an open `T`) to keep coverage on
        // the argument-slot conversion the issue is about and avoid the
        // unrelated indexer-on-open-generic emit shape.
        let source = `package Probe
import System.Collections.Generic

class Sink {
    shared {
        func Take[T](source IReadOnlyList[T]) int32 { return source.Count }
    }
}

public var n = Sink.Take[int32]([]int32{7, 8, 9})`
        let assembly = CompileAndRun(source)
        Assert.Equal(3, GetIntField(assembly, "n"))
    }

    @Fact
    func StaticGeneric_IEnumerableOfT_AcceptsSliceFromLocal_Runs() {
        // Slice held in a local variable (not just a literal) flowed into
        // an `IEnumerable[T]` static-method argument slot.
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Sum(source IEnumerable[int32]) int32 {
            var s = 0
            for v in source {
                s = s + v
            }
            return s
        }
    }
}

let ints = []int32{10, 20, 30}
public var total = Sequences.Sum(ints)`
        let assembly = CompileAndRun(source)
        Assert.Equal(60, GetIntField(assembly, "total"))
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let outPath = CompileToFile(source)
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

        private func CompileToFile(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_821_").FullName
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
