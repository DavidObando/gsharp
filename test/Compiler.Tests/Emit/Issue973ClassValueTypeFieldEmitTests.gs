// <copyright file="Issue973ClassValueTypeFieldEmitTests.cs" company="GSharp">
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

/// Issue #973 — emit + IL-verify + runtime coverage for a `class` that
/// declares a field whose type is a user value type (`struct` or
/// `data struct`).
///
/// The reported symptom was an internal emit crash
/// (`GS9998: InvalidOperationException: Struct 'S' has no emitted TypeDef.`)
/// when a `class` field referenced a user `struct`: classes are
/// emitted before structs, so when the class field signature was encoded the
/// struct's TypeDef row had not yet been registered. A second, order-sensitive
/// symptom (`GS0113: Type 'S' doesn't exist.`) appeared when the struct was
/// declared AFTER the class, because struct/class names were declared and their
/// bodies bound in a single source-order pass.
///
/// The fix has two parts:
/// - Emit: pre-reserve every user TypeDefinitionHandle before any member
/// signature is encoded, so a forward-referenced type resolves regardless
/// of relative emission order.
/// - Bind: declare every struct/class type-name shell first, then bind their
/// bodies, so a field type can forward-reference a type declared later.
///
/// These tests cover the shapes the fix unblocks, asserting the program
/// compiles, passes IL verification, emits the struct as a real value-type
/// field of the class, and round-trips a value at runtime — for both
/// declaration orders and for `data struct` fields.
open class Issue973ClassValueTypeFieldEmitTests {
    @Fact
    func ClassWithStructField_StructBeforeClass_CompilesVerifiesAndRoundTrips() {
        let source = `package Probe

struct S {
    var X int32
}

class C {
    var Field S
    init(f S) { Field = f }
}

public var value = C(S{ X: 7 }).Field.X`
        let assembly = CompileVerifyAndRun(source)
        Assert.Equal(7, GetField[int32](assembly, "value"))
        AssertFieldIsValueType(assembly, className: "C", fieldName: "Field", fieldTypeName: "S")
    }

    @Fact
    func ClassWithStructField_StructAfterClass_CompilesVerifiesAndRoundTrips() {
        let source = `package Probe

class C {
    var Field S
    init(f S) { Field = f }
}

struct S {
    var X int32
}

public var value = C(S{ X: 9 }).Field.X`
        let assembly = CompileVerifyAndRun(source)
        Assert.Equal(9, GetField[int32](assembly, "value"))
        AssertFieldIsValueType(assembly, className: "C", fieldName: "Field", fieldTypeName: "S")
    }

    @Fact
    func ClassWithDataStructField_CompilesVerifiesAndRoundTrips() {
        let source = `package Probe

data struct S {
    var X int32
}

class C {
    var Field S
    init(f S) { Field = f }
}

public var value = C(S{ X: 42 }).Field.X`
        let assembly = CompileVerifyAndRun(source)
        Assert.Equal(42, GetField[int32](assembly, "value"))
        AssertFieldIsValueType(assembly, className: "C", fieldName: "Field", fieldTypeName: "S")
    }

    @Fact
    func ClassWithForwardReferencedClassField_CompilesAndRoundTrips() {
        let source = `package Probe

class A {
    var Inner B
    init(b B) { Inner = b }
}

class B {
    var X int32
    init(x int32) { X = x }
}

public var value = A(B(5)).Inner.X`
        let assembly = CompileVerifyAndRun(source)
        Assert.Equal(5, GetField[int32](assembly, "value"))
    }

    shared {
        private func CompileVerifyAndRun(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_973_").FullName
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

        private func AssertFieldIsValueType(
            assembly Assembly,
            className string,
            fieldName string,
            fieldTypeName string
        ) {
            let classType = assembly.GetTypes().Single((t Type) -> t.Name == className)
            Assert.True(classType.IsClass, "'$className' should be emitted as a reference type.")
            let field FieldInfo? = classType.GetField(fieldName, BindingFlags.Public | BindingFlags.Instance)
            Assert.NotNull(field)
            Assert.Equal(fieldTypeName, field!!.FieldType.Name)
            Assert.True(field!!.FieldType.IsValueType, "field '$fieldName' should be a value type ('$fieldTypeName').")
        }
    }
}
