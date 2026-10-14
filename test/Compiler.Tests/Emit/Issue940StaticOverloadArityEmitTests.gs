// <copyright file="Issue940StaticOverloadArityEmitTests.cs" company="GSharp">
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

/// Issue #940 — emit + IL-verify coverage for static (`shared`) user-type
/// method overload resolution.
///
/// The reported symptom was a BINDER refusal
/// (`GS0144: Function 'Round' requires 1 arguments but was given 2.`) when
/// a `shared` method had multiple overloads: the static-call path
/// (`ExpressionBinder.BindUserTypeStaticCall`) took the FIRST by-name
/// match via `StructSymbol.TryGetStaticMethod` and then arity-checked it,
/// so any call to an overload other than the first failed. Instance-method
/// overloads on the same type already resolved correctly.
///
/// The fix builds the full static method GROUP through the ADR-0112 canonical
/// member-resolution layer and runs `OverloadResolver` — identical to the
/// instance-method path. These tests cover the shapes the fix unblocks:
/// - the exact repro (calling the 2-arg overload from inside the 1-arg one),
/// - overloads differing by parameter TYPE at the same arity,
/// - a static overload set combined with a default/optional parameter.
open class Issue940StaticOverloadArityEmitTests {
    @Fact
    func SharedStatic_OverloadsByArity_ResolvesTwoArgFromOneArg() {
        let source = `package Probe

class Geometry {
    shared {
        func Round(value float64) float64 { return Geometry.Round(value, 2) }
        func Round(value float64, digits int32) float64 { return System.Math.Round(value, digits) }
    }
}

public var result = Geometry.Round(1.234)`
        let assembly = CompileAndRun(source)
        Assert.Equal(1.23, GetResult[float64](assembly), 3)
    }

    @Fact
    func SharedStatic_OverloadsByParameterType_ResolveCorrectOverload() {
        let source = `package Probe

class Fmt {
    shared {
        func Describe(value int32) string { return "int:${value}" }
        func Describe(value string) string { return "str:${value}" }
    }
}

public var fromInt = Fmt.Describe(42)
public var fromString = Fmt.Describe("hi")`
        let assembly = CompileAndRun(source)
        Assert.Equal("int:42", GetField[string](assembly, "fromInt"))
        Assert.Equal("str:hi", GetField[string](assembly, "fromString"))
    }

    @Fact
    func SharedStatic_OverloadSetWithOptionalParameter_ResolvesAndDefaults() {
        let source = `package Probe

class Calc {
    shared {
        func Scale(value int32) int32 { return value }
        func Scale(value int32, factor int32, offset int32 = 100) int32 {
            return (value * factor) + offset
        }
    }
}

public var single = Calc.Scale(7)
public var defaultedOffset = Calc.Scale(2, 3)
public var allSupplied = Calc.Scale(2, 3, 1)`
        let assembly = CompileAndRun(source)
        Assert.Equal(7, GetField[int32](assembly, "single"))
        Assert.Equal(106, GetField[int32](assembly, "defaultedOffset"))
        Assert.Equal(7, GetField[int32](assembly, "allSupplied"))
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_940_").FullName
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

        private func GetResult[T](assembly Assembly) T -> GetField[T](assembly, "result")

        private func GetField[T](assembly Assembly, name string) T {
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let resultField FieldInfo? = program.GetField(name, BindingFlags.Public | BindingFlags.Static)
            return T(resultField!!.GetValue(nil)!!)
        }
    }
}
