// <copyright file="Issue1240ParameterShadowsFieldEmitTests.cs" company="GSharp">
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

/// Issue #1240 — emit + IL-verify coverage proving that a method/constructor
/// parameter named like an instance field (or property) shadows that member for
/// unqualified (bare) reads, matching C# semantics. The member remains reachable
/// via `this.`. These tests execute the emitted IL and assert that the
/// PARAMETER value is the one observed, not the field/property value.
open class Issue1240ParameterShadowsFieldEmitTests {
    @Fact
    func Method_BareParam_ShadowsField_ReturnsParameter() {
        let source = `package Probe

class C {
    var iv int32
    init() {
        iv = 100
    }
    func M(iv int32) int32 {
        return iv
    }
}

public var result = C().M(7)`
        let assembly = CompileAndRun(source)
        Assert.Equal(7, GetField[int32](assembly, "result"))
    }

    @Fact
    func Method_ThisField_AndBareParam_AreDistinct() {
        // `this.iv` (field = 100) + bare `iv` (parameter = 7) = 107.
        let source = `package Probe

class C {
    var iv int32
    init() {
        iv = 100
    }
    func M(iv int32) int32 {
        return this.iv + iv
    }
}

public var result = C().M(7)`
        let assembly = CompileAndRun(source)
        Assert.Equal(107, GetField[int32](assembly, "result"))
    }

    @Fact
    func Constructor_BareParam_ShadowsField_AssignsFromParameter() {
        // `this.iv = iv` stores the parameter into the field; Get() reads it back.
        let source = `package Probe

class C {
    var iv int32
    init(iv int32) {
        this.iv = iv
    }
    func Get() int32 {
        return this.iv
    }
}

public var result = C(5).Get()`
        let assembly = CompileAndRun(source)
        Assert.Equal(5, GetField[int32](assembly, "result"))
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_1240_").FullName
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
