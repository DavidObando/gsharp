// <copyright file="Issue810OpenGenericIteratorEmitTests.cs" company="GSharp">
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

/// Issue #810: Emit coverage for open generic iterator.
/// Traceability: issue #798.
open class Issue810OpenGenericIteratorEmitTests {
    @Fact
    func Empty_OpenGeneric_IEnumerableT_RunsForInt32AndString() {
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Empty[T any]() IEnumerable[T] {
            for v in []T{} {
                yield v
            }
        }
    }
}

public var intCount = 0
for x in Sequences.Empty[int32]() {
    intCount = intCount + 1
}

public var strCount = 0
for s in Sequences.Empty[string]() {
    strCount = strCount + 1
}`
        let assembly = CompileAndRun(source)
        Assert.Equal(0, GetIntField(assembly, "intCount"))
        Assert.Equal(0, GetIntField(assembly, "strCount"))
    }

    @Fact
    func Empty_OpenGeneric_SequenceT_RunsForInt32AndString() {
        let source = `package Probe

class Sequences {
    shared {
        func Empty[T any]() sequence[T] {
            for v in []T{} {
                yield v
            }
        }
    }
}

public var intCount = 0
for x in Sequences.Empty[int32]() {
    intCount = intCount + 1
}

public var strCount = 0
for s in Sequences.Empty[string]() {
    strCount = strCount + 1
}`
        let assembly = CompileAndRun(source)
        Assert.Equal(0, GetIntField(assembly, "intCount"))
        Assert.Equal(0, GetIntField(assembly, "strCount"))
    }

    @Fact
    func Of_OpenGeneric_VariadicT_IEnumerableT_SumsValues() {
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Of[T any](values []T) IEnumerable[T] {
            for v in values {
                yield v
            }
        }
    }
}

public var sum = 0
for x in Sequences.Of[int32]([]int32{1, 2, 3, 4, 5}) {
    sum = sum + x
}`
        let assembly = CompileAndRun(source)
        Assert.Equal(15, GetIntField(assembly, "sum"))
    }

    @Fact
    func Of_OpenGeneric_VariadicT_SequenceT_RunsForString() {
        let source = `package Probe

class Sequences {
    shared {
        func Of[T any](values []T) sequence[T] {
            for v in values {
                yield v
            }
        }
    }
}

public var concat = ""
for s in Sequences.Of[string]([]string{"a", "b", "c"}) {
    concat = concat + s
}`
        let assembly = CompileAndRun(source)
        Assert.Equal("abc", GetStringField(assembly, "concat"))
    }

    @Fact
    func Range_ClosedInt32_NoOuterTypeParam_StillWorks() {
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Range(start int32, count int32) IEnumerable[int32] {
            var i = 0
            for i < count {
                yield start + i
                i = i + 1
            }
        }
    }
}

public var sum = 0
for x in Sequences.Range(10, 5) {
    sum = sum + x
}`
        let assembly = CompileAndRun(source)
        // 10+11+12+13+14 = 60
        Assert.Equal(60, GetIntField(assembly, "sum"))
    }

    @Fact
    func Iterate_OpenGeneric_InfiniteWithTake() {
        let source = `package Probe
import System.Collections.Generic
import System.Linq

class Sequences {
    shared {
        func Iterate[T any](seed T, next func(T) T) IEnumerable[T] {
            var current = seed
            for true {
                yield current
                current = next(current)
            }
        }
    }
}

public var sum = 0
for x in Sequences.Iterate[int32](1, func(v int32) int32 { return v + 1 }).Take(5) {
    sum = sum + x
}`
        let assembly = CompileAndRun(source)
        // 1+2+3+4+5 = 15
        Assert.Equal(15, GetIntField(assembly, "sum"))
    }

    @Fact
    func Repeat_OpenGeneric_InfiniteWithTake() {
        let source = `package Probe
import System.Collections.Generic
import System.Linq

class Sequences {
    shared {
        func Repeat[T any](value T) IEnumerable[T] {
            for true {
                yield value
            }
        }
    }
}

public var sum = 0
for x in Sequences.Repeat[int32](7).Take(4) {
    sum = sum + x
}`
        let assembly = CompileAndRun(source)
        Assert.Equal(28, GetIntField(assembly, "sum"))
    }

    @Fact
    func StateMachineClass_HasGenericParameter_MirroringOuterMethod() {
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Empty[T any]() IEnumerable[T] {
            for v in []T{} {
                yield v
            }
        }
    }
}`
        let assembly = CompileLibrary(source)
        // The synthesized iterator state-machine class is nested
        // inside the host <Program> (or the Sequences class). We look
        // for any private nested type whose name starts with
        // "<Empty>d__".
        let smType = assembly
            .GetTypes()
            .Where((t Type) -> t.IsNested && t.Name.StartsWith("<Empty>d__", StringComparison.Ordinal))
            .Single()
        Assert.True(
            smType.IsGenericTypeDefinition,
            "State machine type '${smType.FullName}' must be a generic type definition (carry a GenericParam row)."
        )
        let typeParams = smType.GetGenericArguments()
        Assert.Single(typeParams)
        Assert.Equal("T", typeParams[0].Name)
        // It must implement IEnumerable<T> closed over its own type
        // parameter (Var(0)), NOT over Object.
        let implementsIEnumerableOfT = smType.GetInterfaces().Any(
            (i Type) -> i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable[_]) &&
                i.GetGenericArguments()[0] == typeParams[0]
        )
        Assert.True(
            implementsIEnumerableOfT,
            "State machine '${smType.FullName}' must implement IEnumerable<!0> (its own VAR(0)), not IEnumerable<object>."
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
            let tempDir = Directory.CreateTempSubdirectory("gs_810_").FullName
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
