// <copyright file="Issue1319OptionalDefaultCallSiteEmitTests.cs" company="GSharp">
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

/// Issue #1319 — end-to-end emit + IL-verify + execute coverage proving that an
/// omitted trailing optional argument on a user-defined <em>instance</em> method
/// or constructor is materialized from the captured default value in the
/// generated IL (so the value is actually passed at runtime). Before the fix the
/// binder rejected such call sites with GS0144; the emit side never received a
/// synthesized default argument.
open class Issue1319OptionalDefaultCallSiteEmitTests {
    @Fact
    func InstanceMethod_OmittedOptional_PassesDefaultAtRuntime() {
        let source = `package Probe

class C {
    func F(x int32 = 7) int32 { return x }
}

public var result = C().F()`
        let assembly = CompileAndRun(source)
        Assert.Equal(7, GetField[int32](assembly, "result"))
    }

    @Fact
    func InstanceMethod_SuppliedOptional_OverridesDefaultAtRuntime() {
        let source = `package Probe

class C {
    func F(x int32 = 7) int32 { return x }
}

public var result = C().F(5)`
        let assembly = CompileAndRun(source)
        Assert.Equal(5, GetField[int32](assembly, "result"))
    }

    @Fact
    func InstanceMethod_MultipleTrailingOptionals_OmitTwo_PassesDefaults() {
        let source = `package Probe

class C {
    func F(a int32, b int32 = 1, c int32 = 2) int32 { return a + b + c }
}

public var result = C().F(10)`
        let assembly = CompileAndRun(source)
        Assert.Equal(13, GetField[int32](assembly, "result"))
    }

    @Fact
    func InstanceMethod_MultipleTrailingOptionals_OmitOne_PassesDefault() {
        let source = `package Probe

class C {
    func F(a int32, b int32 = 1, c int32 = 2) int32 { return a + b + c }
}

public var result = C().F(10, 20)`
        let assembly = CompileAndRun(source)
        Assert.Equal(32, GetField[int32](assembly, "result"))
    }

    @Fact
    func Constructor_OmittedOptional_PassesDefaultAtRuntime() {
        let source = `package Probe

class C {
    var X int32
    init(x int32 = 100) { X = x }
}

public var result = C().X`
        let assembly = CompileAndRun(source)
        Assert.Equal(100, GetField[int32](assembly, "result"))
    }

    @Fact
    func InstanceMethod_StringDefault_OmittedOptional_PassesDefaultAtRuntime() {
        let source = `package Probe

class C {
    func Tag(s string = "hello") string { return s }
}

public var result = C().Tag()`
        let assembly = CompileAndRun(source)
        Assert.Equal("hello", GetField[string](assembly, "result"))
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_1319_").FullName
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

        private func GetField[T](assembly Assembly, name string) T {
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let resultField FieldInfo? = program.GetField(name, BindingFlags.Public | BindingFlags.Static)
            return T(resultField!!.GetValue(nil)!!)
        }
    }
}
