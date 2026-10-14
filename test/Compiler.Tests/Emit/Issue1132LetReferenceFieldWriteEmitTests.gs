// <copyright file="Issue1132LetReferenceFieldWriteEmitTests.cs" company="GSharp">
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

/// Issue #1132: a member write through a `let` reference-type local
/// mutates the heap object, not the (read-only) binding, so it must compile
/// AND emit correctly. These tests compile+run a snippet to prove the heap
/// mutation actually happens at runtime, not just that it binds.
open class Issue1132LetReferenceFieldWriteEmitTests {
    @Fact
    func LetClassLocal_FieldWrite_MutatesHeapObject() {
        // Acceptance #6: `let b = Box{}; b.Value = 5` mutates the heap object.
        let source = `package p
import System

class Box { var Value int32 = 0 }

func makeAndMutate() int32 {
    let b = Box{ }
    b.Value = 5
    return b.Value
}

public var result = makeAndMutate()`
        Assert.Equal(5, RunAndGetIntResult(source))
    }

    @Fact
    func LetClassLocal_CompoundAndIncrement_MutatesHeapObject() {
        // Acceptance #6: compound `+=` and `++` through a `let` class local.
        let source = `package p
import System

class Counter { var Value int32 = 0 }

func count() int32 {
    let c = Counter{ }
    c.Value += 4
    c.Value++
    return c.Value
}

public var result = count()`
        Assert.Equal(5, RunAndGetIntResult(source))
    }

    @Fact
    func LetClassLocal_PropertyWrite_MutatesHeapObject() {
        // Acceptance #6: property write through a `let` class local.
        let source = `package p
import System

class Box {
    var _v int32 = 0
    prop Value int32 {
        get { return _v }
        set { _v = value }
    }
}

func makeAndMutate() int32 {
    let b = Box{ }
    b.Value = 5
    return b.Value
}

public var result = makeAndMutate()`
        Assert.Equal(5, RunAndGetIntResult(source))
    }

    shared {
        private func RunAndGetIntResult(source string) int32 {
            let assembly = CompileToAssembly(source, target: "exe")
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return int32(resultField!!.GetValue(nil)!!)
        }

        private func CompileToAssembly(source string, target string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_1132_emit_").FullName
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
            return EmittedFixture.Load(outPath)
        }
    }
}
