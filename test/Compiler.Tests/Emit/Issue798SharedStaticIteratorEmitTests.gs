// <copyright file="Issue798SharedStaticIteratorEmitTests.cs" company="GSharp">
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

/// Issue #798 / ADR-0084 §L5 — emit + IL-verify coverage for the
/// shared-static-iterator binding path enabled by the binder fix.
///
/// The reported symptom was a BINDER refusal (`GS0136`) and a
/// CFG crash (`GS9998`) when `yield` appeared in a method
/// inside a `shared` block. These tests cover the end-to-end
/// PE-emission path with `ilverify` for the spellings the
/// binder fix unblocks at IL level:
/// - `IEnumerable[int32]` shared-static iterator,
/// - `sequence[int32]` shared-static iterator,
/// - `IAsyncEnumerable[int32]` shared-static async iterator,
/// - `async sequence[int32]` shared-static async iterator.
///
/// Generic-iterator IL emission
/// (`shared func F[T any]() IEnumerable[T]`) surfaces a deeper,
/// pre-existing emitter gap: the synthesized state-machine class is
/// not made generic over the outer method's type parameters, so its
/// hoisted fields' signatures reference a method-generic slot that
/// doesn't exist on the SM class. That gap is tracked as a follow-up;
/// binder-level acceptance of the generic shapes is covered in
/// `Issue798SharedStaticIteratorBindingTests`.
open class Issue798SharedStaticIteratorEmitTests {
    @Fact
    func SharedStatic_IEnumerableInt_EmitAndRun() {
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Of(a int32, b int32, c int32) IEnumerable[int32] {
            yield a
            yield b
            yield c
        }
    }
}

public var result = 0
for x in Sequences.Of(10, 20, 12) {
    result = result + x
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(42, result)
    }

    @Fact
    func SharedStatic_SequenceInt_EmitAndRun() {
        let source = `package Probe

class Sequences {
    shared {
        func Of(a int32, b int32, c int32) sequence[int32] {
            yield a
            yield b
            yield c
        }
    }
}

public var result = 0
for x in Sequences.Of(1, 2, 3) {
    result = result + x
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(6, result)
    }

    @Fact
    func SharedStatic_AsyncIEnumerableInt_EmitAndRun() {
        let source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Sequences {
    shared {
        async func Of(a int32, b int32) IAsyncEnumerable[int32] {
            yield a
            await Task.Delay(1)
            yield b
        }
    }
}

public var result = 0
let e = Sequences.Of(10, 32).GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(42, result)
    }

    @Fact
    func SharedStatic_AsyncSequenceInt_EmitAndRun() {
        // ADR-0041: `async func ... sequence[T]` resolves to
        // AsyncSequenceTypeSymbol. Issue #798 ensured the binder +
        // lowering predicates accept its symbolic form alongside
        // IAsyncEnumerable[T] / IAsyncEnumerator[T].
        let source = `package Probe
import System.Threading.Tasks

class Sequences {
    shared {
        async func Of(a int32, b int32) sequence[int32] {
            yield a
            await Task.Delay(1)
            yield b
        }
    }
}

public var result = 0
let e = Sequences.Of(100, 23).GetAsyncEnumerator()
for e.MoveNextAsync().AsTask().Result {
    result = result + e.Current
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(123, result)
    }

    @Fact
    func Issue798_SharedStatic_Empty_NonGeneric_EmitAndRun() {
        // The literal `Sequences.Empty[T]` from the issue requires
        // generic-iterator IL emission (a state machine made generic
        // over the outer method's type parameters), which is a
        // separate, pre-existing emitter gap not in scope for issue
        // #798's binder fix. Verify the issue's shape at a concrete
        // instantiation; binder-level acceptance of the open T form
        // is covered in the binder tests.
        let source = `package Probe
import System.Collections.Generic

class Sequences {
    shared {
        func Empty() IEnumerable[int32] {
            for v in []int32{} {
                yield v
            }
        }

        func Of(v int32) IEnumerable[int32] {
            yield v
        }
    }
}

public var result = 0
for x in Sequences.Empty() {
    result = result + x
}
for y in Sequences.Of(7) {
    result = result + y
}
for z in Sequences.Of(35) {
    result = result + z
}`
        let assembly = CompileAndRun(source)
        let result = GetResult[int32](assembly)
        Assert.Equal(42, result)
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_798_").FullName
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
