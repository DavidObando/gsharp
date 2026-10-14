// <copyright file="Issue936StaticOptionalParameterEmitTests.cs" company="GSharp">
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

/// Issue #936 / ADR-0063 — emit + IL-verify coverage for default/optional
/// parameter values on static (`shared`) user-type method calls.
///
/// The reported symptom was a BINDER refusal
/// (`GS0144: Function 'Req' requires 1 arguments but was given 0.`)
/// when a `shared` method declaring a default parameter value was
/// called while omitting that argument. Instance methods already honored
/// the declared default; the static-call path
/// (`ExpressionBinder.BindUserTypeStaticCall`) refused the call on a
/// strict arity check and never synthesized the omitted default.
///
/// These tests cover the end-to-end PE-emission path with
/// `ilverify` for the shapes the binder fix unblocks:
/// - single trailing optional parameter omitted,
/// - required + multiple optional parameters with a mix of supplied and
/// omitted trailing arguments,
/// - all optional parameters supplied explicitly (regression guard).
open class Issue936StaticOptionalParameterEmitTests {
    @Fact
    func SharedStatic_SingleOptional_Omitted_UsesDefault() {
        let source = `package Probe

class Greeter {
    shared {
        func Greeting(title string = "Book") string {
            return "Hello ${title}"
        }
    }
}

public var result = Greeter.Greeting()`
        let assembly = CompileAndRun(source)
        let result = GetResult[string](assembly)
        Assert.Equal("Hello Book", result)
    }

    @Fact
    func SharedStatic_RequiredPlusOptionals_OmittedTrailing_UsesDefaults() {
        let source = `package Probe

class Greeter {
    shared {
        func Make(prefix string, title string = "Book", count int32 = 3) string {
            return "${prefix}:${title}:${count}"
        }
    }
}

public var allDefaults = Greeter.Make("A")
public var oneSupplied = Greeter.Make("B", "Mag")
public var allSupplied = Greeter.Make("C", "Cd", 9)`
        let assembly = CompileAndRun(source)
        Assert.Equal("A:Book:3", GetField[string](assembly, "allDefaults"))
        Assert.Equal("B:Mag:3", GetField[string](assembly, "oneSupplied"))
        Assert.Equal("C:Cd:9", GetField[string](assembly, "allSupplied"))
    }

    @Fact
    func SharedStatic_NumericOptional_Omitted_UsesDefault() {
        let source = `package Probe

class Calc {
    shared {
        func Add(a int32, b int32 = 40) int32 {
            return a + b
        }
    }
}

public var result = Calc.Add(2)`
        let assembly = CompileAndRun(source)
        Assert.Equal(42, GetResult[int32](assembly))
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_936_").FullName
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
