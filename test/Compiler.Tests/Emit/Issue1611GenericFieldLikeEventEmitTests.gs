// <copyright file="Issue1611GenericFieldLikeEventEmitTests.cs" company="GSharp">
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

/// Issue #1611 regression tests: field-like event add/remove accessors on a
/// generic type previously loaded their backing field with a bare FieldDef
/// token even though the accessor body runs on a constructed (self-)generic
/// receiver. ECMA-335 requires such member refs to go through the self-TypeSpec,
/// exactly like the auto-property fix for issue #989. Invoking add/remove on a
/// constructed generic instance used to throw `InvalidOperationException`
/// at runtime ("containing type is not fully instantiated").
open class Issue1611GenericFieldLikeEventEmitTests {
    @Fact
    func GenericFieldLikeEvent_InstanceAddRemove_RunsWithoutCrash() {
        let source = `package Gh1611Instance
import System

class Holder1611A[T] {
    public event Changed func()
}`
        let assembly = CompileToAssembly(source)
        let openType = assembly.GetTypes().Single((t Type) -> t.Name == "Holder1611A`1")
        let closedType = openType.MakeGenericType(typeof(int32))
        let instance = Activator.CreateInstance(closedType)!!
        let ev = closedType.GetEvent("Changed")!!
        var invoked = false
        let handler() -> void = () -> {
            invoked = true
        }
        // Invoking add_Changed on a constructed generic instance is exactly
        // where the bare-FieldDef token used to crash with
        // InvalidOperationException ("containing type is not fully instantiated").
        ev.AddEventHandler(instance, handler)
        let backingField FieldInfo? = closedType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance)
        var del Delegate? = backingField!!.GetValue(instance) as Delegate
        Assert.NotNull(del)
        del!!.DynamicInvoke()
        Assert.True(invoked)
        invoked = false
        ev.RemoveEventHandler(instance, handler)
        del = backingField!!.GetValue(instance) as Delegate
        Assert.Null(del)
        Assert.False(invoked)
    }

    @Fact
    func GenericFieldLikeEvent_StaticAddRemove_RunsWithoutCrash() {
        let source = `package Gh1611Static
import System

class Holder1611B[T] {
    shared {
        public event Changed func()
    }
}`
        let assembly = CompileToAssembly(source)
        let openType = assembly.GetTypes().Single((t Type) -> t.Name == "Holder1611B`1")
        let closedType = openType.MakeGenericType(typeof(int32))
        let ev = closedType.GetEvent("Changed")!!
        var invoked = false
        let handler() -> void = () -> {
            invoked = true
        }
        // Static add/remove on a constructed generic type: same bare-FieldDef
        // (ldsfld/ldsflda) crash as the instance case above.
        ev.AddMethod!!.Invoke(nil, []object{handler})
        let backingField FieldInfo? = closedType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Static)
        var del Delegate? = backingField!!.GetValue(nil) as Delegate
        Assert.NotNull(del)
        del!!.DynamicInvoke()
        Assert.True(invoked)
        invoked = false
        ev.RemoveMethod!!.Invoke(nil, []object{handler})
        del = backingField!!.GetValue(nil) as Delegate
        Assert.Null(del)
        Assert.False(invoked)
    }

    shared {
        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1611_").FullName
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
            return EmittedFixture.Load(outPath)
        }
    }
}
