// <copyright file="InlineStructEqualsEmitTests.cs" company="GSharp">
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

/// Issue #420 (P3-10): the inline-struct `Equals(object)` emitter in
/// `ReflectionMetadataEmitter` uses the `unbox` IL opcode, which is
/// legal only for value-type targets. These tests pin down the current
/// value-type contract by exercising `Equals(object)` on a compiled
/// inline struct and verifying the resulting type is in fact a value type, so
/// the assumption documented at the emit site cannot drift silently.
open class InlineStructEqualsEmitTests {
    @Fact
    func InlineStruct_EqualsObject_ReturnsTrueForSameValue() {
        let source = `package MyLib
import System

inline struct UserId(value int32)`
        let assembly = CompileToAssembly(source)
        let userId = assembly.GetTypes().Single((t Type) -> t.Name == "UserId")
        // The unbox opcode used by the synthesized Equals(object) is only valid
        // for value types — guard the assumption from the production code here.
        Assert.True(userId.IsValueType, "UserId inline struct must be emitted as a value type.")
        let a = MakeUserId(userId, 42)
        let b = MakeUserId(userId, 42)
        let c = MakeUserId(userId, 7)
        let equalsObject MethodInfo? = userId.GetMethod("Equals", []Type{typeof(object)})
        Assert.NotNull(equalsObject)
        Assert.True(bool(equalsObject!!.Invoke(a, []object{b})!!))
        Assert.False(bool(equalsObject!!.Invoke(a, []object{c})!!))
        Assert.False(bool(equalsObject!!.Invoke(a, []object? {nil})!!))
        Assert.False(bool(equalsObject!!.Invoke(a, []object{"not a UserId"})!!))
    }

    @Fact
    func InlineStruct_EqualsObject_HasObjectParameter() {
        let source = `package MyLib
import System

inline struct UserId(value int32)`
        let assembly = CompileToAssembly(source)
        let userId = assembly.GetTypes().Single((t Type) -> t.Name == "UserId")
        let equalsObject MethodInfo? = userId.GetMethod("Equals", []Type{typeof(object)})
        Assert.NotNull(equalsObject)
        Assert.Equal(typeof(bool), equalsObject!!.ReturnType)
        Assert.Equal(typeof(object), equalsObject!!.GetParameters().Single().ParameterType)
    }

    shared {
        private func MakeUserId(userId Type, value int32) object {
            // Inline structs do not expose a public parameterized constructor we
            // can invoke via reflection — construct via the default ctor and set
            // the backing field directly.
            let instance = Activator.CreateInstance(userId)!!
            let field = userId.GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).Single()
            field.SetValue(instance, value)
            return instance
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_inline_equals_").FullName
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
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
