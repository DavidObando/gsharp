// <copyright file="NamedDelegateEmitTests.cs" company="GSharp">
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

/// ADR-0059 / issue #255: compiler emit tests for named delegate type
/// declarations.
open class NamedDelegateEmitTests {
    @Fact
    func NamedDelegate_EmitsSealedMulticastDelegateTypeDef() {
        let source = `package MyLib

delegate MyHandler(a int32, b int32) int32;`
        let assembly = CompileToAssembly(source)
        let handler = assembly.GetTypes().Single((t Type) -> t.Name == "MyHandler")
        Assert.True(handler.IsSealed, "${handler.FullName} should be sealed")
        Assert.True(handler.IsClass, "${handler.FullName} should be a class")
        Assert.NotNull(handler.BaseType)
        Assert.Equal("System.MulticastDelegate", handler.BaseType!!.FullName)
    }

    @Fact
    func NamedDelegate_EmitsRuntimeCtorWithObjectAndIntPtr() {
        let source = `package MyLib

delegate MyHandler(a int32, b int32) int32;`
        let assembly = CompileToAssembly(source)
        let handler = assembly.GetTypes().Single((t Type) -> t.Name == "MyHandler")
        let ctor = handler.GetConstructors(BindingFlags.Public | BindingFlags.Instance).Single()
        Assert.True(ctor.IsSpecialName)
        let implFlags = ctor.GetMethodImplementationFlags()
        Assert.True(
            (implFlags & MethodImplAttributes.Runtime) == MethodImplAttributes.Runtime,
            "Delegate .ctor must have MethodImplAttributes.Runtime"
        )
        let parms = ctor.GetParameters()
        Assert.Equal(2, parms.Length)
        Assert.Equal(typeof(object), parms[0].ParameterType)
        Assert.Equal(typeof(nint), parms[1].ParameterType)
    }

    @Fact
    func NamedDelegate_EmitsRuntimeInvokeMatchingSignature() {
        let source = `package MyLib

delegate MyHandler(a int32, b int32) int32;`
        let assembly = CompileToAssembly(source)
        let handler = assembly.GetTypes().Single((t Type) -> t.Name == "MyHandler")
        let invoke MethodInfo? = handler.GetMethod("Invoke", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(invoke)
        Assert.True(invoke!!.IsVirtual)
        Assert.False(invoke!!.IsAbstract)
        let implFlags = invoke!!.GetMethodImplementationFlags()
        Assert.True(
            (implFlags & MethodImplAttributes.Runtime) == MethodImplAttributes.Runtime,
            "Delegate Invoke must have MethodImplAttributes.Runtime"
        )
        Assert.Equal(typeof(int32), invoke!!.ReturnType)
        let parms = invoke!!.GetParameters()
        Assert.Equal(2, parms.Length)
        Assert.Equal(typeof(int32), parms[0].ParameterType)
        Assert.Equal(typeof(int32), parms[1].ParameterType)
        Assert.Equal("a", parms[0].Name)
        Assert.Equal("b", parms[1].Name)
    }

    @Fact
    func VoidNamedDelegate_InvokeReturnsVoid() {
        let source = `package MyLib

delegate Greeter(name string);`
        let assembly = CompileToAssembly(source)
        let greeter = assembly.GetTypes().Single((t Type) -> t.Name == "Greeter")
        let invoke = greeter.GetMethod("Invoke")!!
        Assert.Equal(typeof(Void), invoke.ReturnType)
        Assert.Single(invoke.GetParameters())
        Assert.Equal(typeof(string), invoke.GetParameters()[0].ParameterType)
    }

    shared {
        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_named_delegate_emit_").FullName
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
