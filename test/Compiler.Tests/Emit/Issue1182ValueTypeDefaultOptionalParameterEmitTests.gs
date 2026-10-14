// <copyright file="Issue1182ValueTypeDefaultOptionalParameterEmitTests.cs" company="GSharp">
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

/// Issue #1182 — emit + IL-verify coverage for a value-type `default(T)`
/// (and the zero-value `T()` form) used as an optional-parameter default.
/// When the argument is omitted at a call site, the emitter must materialize
/// the type's all-zero value (verifiable IL), matching C#.
///
/// Covers a BCL value type (`TimeSpan`), a primitive (`int32`), and a
/// user `data struct`, plus a regression guard that an explicitly-supplied
/// argument still overrides the default.
open class Issue1182ValueTypeDefaultOptionalParameterEmitTests {
    @Fact
    func Primitive_DefaultOf_Omitted_MaterializesZero() {
        let source = `package Probe

func F(x int32 = default(int32)) int32 {
    return x
}

public var result = F()`
        let assembly = CompileAndRun(source)
        Assert.Equal(0, GetField[int32](assembly, "result"))
    }

    @Fact
    func Primitive_DefaultOf_Supplied_OverridesDefault() {
        let source = `package Probe

func F(x int32 = default(int32)) int32 {
    return x
}

public var result = F(42)`
        let assembly = CompileAndRun(source)
        Assert.Equal(42, GetField[int32](assembly, "result"))
    }

    @Fact
    func BclValueType_DefaultOf_Omitted_MaterializesAllZero() {
        let source = `package Probe
import System

func F(t TimeSpan = default(TimeSpan)) int64 {
    return t.Ticks
}

public var result = F()`
        let assembly = CompileAndRun(source)
        Assert.Equal(0L, GetField[int64](assembly, "result"))
    }

    @Fact
    func BclValueType_ZeroValueConstructorForm_Omitted_MaterializesAllZero() {
        let source = `package Probe
import System

class C {
    var T TimeSpan
    init(t TimeSpan = TimeSpan()) { T = t }
}

public var result = C().T.Ticks`
        let assembly = CompileAndRun(source)
        Assert.Equal(0L, GetField[int64](assembly, "result"))
    }

    @Fact
    func UserStruct_DefaultOf_Omitted_MaterializesAllZero() {
        let source = `package Probe

data struct Point {
    var X int32
    var Y int32
}

func F(p Point = default(Point)) int32 {
    return p.X + p.Y
}

public var result = F()`
        let assembly = CompileAndRun(source)
        Assert.Equal(0, GetField[int32](assembly, "result"))
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_1182_").FullName
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
