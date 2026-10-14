// <copyright file="Issue813TupleSequenceReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #813 — emit + IL-verify coverage for iterators whose element
/// type is a value tuple (e.g. `sequence[(int32, T)]` /
/// `IEnumerable[(T, T)]`). The fix lives across four touchpoints:
/// - Parser — `yield (a, b)` at statement start is parsed as a yield-statement (tuple literal) when the
/// parens enclose a top-level comma.
/// - Binder — `SubstituteType` descends through `TupleTypeSymbol.ElementTypes`.
/// - Symbols — `TypeSymbol.ContainsTypeParameter` recognises tuple elements so wrapping
/// `ImportedTypeSymbol.HasTypeParameterArgument` reports correctly.
/// - Emit — `IsValueTypeSymbol` / `GetElementTypeToken` /
/// `StateMachineEmitter.ContainsOuterMethodTypeParameter` and `MethodBodyPlanner.ContainsTypeParameter`
/// all honour tuple element types, plus the unification engine (`TryUnify`) descends into tuples so
/// generic-method specs build correctly.
open class Issue813TupleSequenceReturnEmitTests {
    @Fact
    func Indexed_OpenGeneric_SequenceTupleIntT_RunsForInt32() {
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Indexed[T any](source IEnumerable[T]) sequence[(int32, T)] {
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
for p in Sequences.Indexed[int32]([]int32{10, 20, 30}) {
    var idx = p.Item1
    var val = p.Item2
    sumIdx = sumIdx + idx
    sumVal = sumVal + val
}`
        let assembly = CompileAndRun(source)
        // indexes 0+1+2 = 3, values 10+20+30 = 60
        Assert.Equal(3, GetIntField(assembly, "sumIdx"))
        Assert.Equal(60, GetIntField(assembly, "sumVal"))
    }

    @Fact
    func Indexed_OpenGeneric_SequenceTupleIntT_RunsForString() {
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Indexed[T any](source IEnumerable[T]) sequence[(int32, T)] {
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
    func Indexed_OpenGeneric_IEnumerableTupleIntT_RunsForInt32() {
        // Mirror of the sequence-returning case against the explicit
        // `IEnumerable[(int32, T)]` spelling. The kickoff method's
        // signature must encode that exact return shape so a closed
        // `Indexed[int32]` call site flows through the iterator
        // protocol uniformly.
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Indexed[T any](source IEnumerable[T]) IEnumerable[(int32, T)] {
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
for p in Sequences.Indexed[int32]([]int32{5, 10, 15, 20}) {
    sumIdx = sumIdx + p.Item1
    sumVal = sumVal + p.Item2
}`
        let assembly = CompileAndRun(source)
        // indexes 0+1+2+3 = 6, values 5+10+15+20 = 50
        Assert.Equal(6, GetIntField(assembly, "sumIdx"))
        Assert.Equal(50, GetIntField(assembly, "sumVal"))
    }

    @Fact
    func Pairwise_OpenGeneric_SequenceTupleTT_RunsForInt32() {
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Pairwise[T any](source IEnumerable[T]) sequence[(T, T)] {
            var first = true
            var prev = default(T)
            for v in source {
                if !first {
                    yield (prev, v)
                }
                prev = v
                first = false
            }
        }
    }
}

public var pairCount = 0
public var sumFirst = 0
public var sumSecond = 0
for p in Sequences.Pairwise[int32]([]int32{1, 2, 3, 4}) {
    pairCount = pairCount + 1
    sumFirst = sumFirst + p.Item1
    sumSecond = sumSecond + p.Item2
}`
        let assembly = CompileAndRun(source)
        // pairs (1,2)(2,3)(3,4): 3 pairs; firsts=1+2+3=6, seconds=2+3+4=9
        Assert.Equal(3, GetIntField(assembly, "pairCount"))
        Assert.Equal(6, GetIntField(assembly, "sumFirst"))
        Assert.Equal(9, GetIntField(assembly, "sumSecond"))
    }

    @Fact
    func Pairwise_OpenGeneric_SequenceTupleTT_RunsForString() {
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Pairwise[T any](source IEnumerable[T]) sequence[(T, T)] {
            var first = true
            var prev = default(T)
            for v in source {
                if !first {
                    yield (prev, v)
                }
                prev = v
                first = false
            }
        }
    }
}

public var concatFirst = ""
public var concatSecond = ""
for p in Sequences.Pairwise[string]([]string{"a", "b", "c"}) {
    concatFirst = concatFirst + p.Item1
    concatSecond = concatSecond + p.Item2
}`
        let assembly = CompileAndRun(source)
        // pairs ("a","b")("b","c"): firsts=a+b=ab, seconds=b+c=bc
        Assert.Equal("ab", GetStringField(assembly, "concatFirst"))
        Assert.Equal("bc", GetStringField(assembly, "concatSecond"))
    }

    @Fact
    func Triples_OpenGeneric_SequenceTupleIntTU_RunsForInt32String() {
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Triples[T any, U any](left IEnumerable[T], right IEnumerable[U]) sequence[(int32, T, U)] {
            var index = 0
            var rIter = right.GetEnumerator()
            for v in left {
                if rIter.MoveNext() {
                    yield (index, v, rIter.Current)
                }
                index = index + 1
            }
        }
    }
}

public var sumIdx = 0
public var sumLeft = 0
public var concatRight = ""
for t in Sequences.Triples[int32, string]([]int32{10, 20, 30}, []string{"a", "b", "c"}) {
    sumIdx = sumIdx + t.Item1
    sumLeft = sumLeft + t.Item2
    concatRight = concatRight + t.Item3
}`
        let assembly = CompileAndRun(source)
        Assert.Equal(3, GetIntField(assembly, "sumIdx"))
        Assert.Equal(60, GetIntField(assembly, "sumLeft"))
        Assert.Equal("abc", GetStringField(assembly, "concatRight"))
    }

    @Fact
    func NestedTuple_OpenGeneric_SequenceOfIntAndPair_RunsForInt32String() {
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Nested[T any, U any](left IEnumerable[T], right IEnumerable[U]) sequence[(int32, (T, U))] {
            var index = 0
            var rIter = right.GetEnumerator()
            for v in left {
                if rIter.MoveNext() {
                    yield (index, (v, rIter.Current))
                }
                index = index + 1
            }
        }
    }
}

public var sumIdx = 0
public var sumLeft = 0
public var concatRight = ""
for t in Sequences.Nested[int32, string]([]int32{10, 20, 30}, []string{"a", "b", "c"}) {
    sumIdx = sumIdx + t.Item1
    var inner = t.Item2
    sumLeft = sumLeft + inner.Item1
    concatRight = concatRight + inner.Item2
}`
        let assembly = CompileAndRun(source)
        Assert.Equal(3, GetIntField(assembly, "sumIdx"))
        Assert.Equal(60, GetIntField(assembly, "sumLeft"))
        Assert.Equal("abc", GetStringField(assembly, "concatRight"))
    }

    @Fact
    func StateMachineClass_TupleElement_ImplementsIEnumerableOfValueTuple() {
        // Smoke test: the synthesized SM class for an iterator with a
        // `(int32, T)` element must list a generic
        // `IEnumerable<ValueTuple<int32, T>>` interface implementation
        // closed over its own Var(0), not the type-erased
        // `IEnumerable<object>` shape.
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Indexed[T any](source IEnumerable[T]) IEnumerable[(int32, T)] {
            var index = 0
            for v in source {
                yield (index, v)
                index = index + 1
            }
        }
    }
}`
        let assembly = CompileLibrary(source)
        let smType = assembly
            .GetTypes()
            .Where((t Type) -> t.IsNested && t.Name.StartsWith("<Indexed>d__", StringComparison.Ordinal))
            .Single()
        Assert.True(smType.IsGenericTypeDefinition)
        let typeParams = smType.GetGenericArguments()
        Assert.Single(typeParams)
        // Find IEnumerable<ValueTuple<int, T>> closed over the SM's own
        // VAR(0) — i.e. the second type argument of the inner
        // ValueTuple must be ReferenceEqual to typeParams[0].
        let hasTupleEnumerable = smType.GetInterfaces().Any(
            (i Type) -> {
                if !i.IsGenericType || i.GetGenericTypeDefinition() != typeof(IEnumerable[_]) {
                    return false
                }
                let arg = i.GetGenericArguments()[0]
                if !arg.IsGenericType || arg.GetGenericTypeDefinition() != typeof(ValueTuple[_, _]) {
                    return false
                }
                let tupleArgs = arg.GetGenericArguments()
                return tupleArgs[0] == typeof(int32) && tupleArgs[1] == typeParams[0]
            }
        )
        Assert.True(
            hasTupleEnumerable,
            "State machine '${smType.FullName}' must implement IEnumerable<ValueTuple<int,!0>>. " +
                "Actual interfaces: ${string.Join(", ", smType.GetInterfaces().Select((i Type) -> i.FullName))}"
        )
    }

    shared {
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
            let tempDir = Directory.CreateTempSubdirectory("gs_813_").FullName
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
