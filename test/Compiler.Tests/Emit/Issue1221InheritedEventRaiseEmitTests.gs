// <copyright file="Issue1221InheritedEventRaiseEmitTests.cs" company="GSharp">
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

/// Issue #1221 (follow-up to #1213): an `event` declared on a base class
/// must be raisable from a derived class. Raising an inherited event
/// (`Changed?(args)` / `Changed?.Invoke(args)`) from a derived method
/// loads the base type's backing delegate field on `this`, null-checks it,
/// and invokes it. The backing field is emitted as `family` (protected) so
/// the derived-class read verifies and runs. These tests prove the emitted IL
/// verifies and runs: a derived raise reaches a subscribed handler, a multi-level
/// (grandparent) event raises from a grandchild, and a null backing field makes
/// the raise a safe no-op.
open class Issue1221InheritedEventRaiseEmitTests {
    @Fact
    func DerivedRaisesInheritedEvent_WithHandler_InvokesHandler() {
        let source = `package MyLib

open class Base {
    event Changed (int32) -> void
}

class Derived : Base {
    func RaiseFromDerived(v int32) { Changed?(v) }
}`
        let assembly = CompileToAssembly(source)
        let derivedType = assembly.GetTypes().Single((t Type) -> t.Name == "Derived")
        let instance = Activator.CreateInstance(derivedType)!!
        var observed = 0
        let ev = derivedType.GetEvent("Changed")!!
        let handler(int32) -> void = (v int32) -> {
            observed = v
        }
        ev.AddEventHandler(instance, handler)
        derivedType.GetMethod("RaiseFromDerived")!!.Invoke(instance, []object{42})
        Assert.Equal(42, observed)
    }

    @Fact
    func DerivedRaisesInheritedEvent_NullBackingField_IsSafeNoOp() {
        let source = `package MyLib

open class Base {
    event Changed (int32) -> void
}

class Derived : Base {
    func RaiseFromDerived(v int32) { Changed?(v) }
}`
        let assembly = CompileToAssembly(source)
        let derivedType = assembly.GetTypes().Single((t Type) -> t.Name == "Derived")
        let instance = Activator.CreateInstance(derivedType)!!
        // No handler subscribed: the inherited backing delegate field is null,
        // so raising must be a no-op rather than throwing a
        // NullReferenceException (or a FieldAccessException for the base field).
        let raise = derivedType.GetMethod("RaiseFromDerived")!!
        let ex = Record.Exception(() -> raise.Invoke(instance, []object{5}))
        Assert.Null(ex)
    }

    @Fact
    func GrandchildRaisesGrandparentEvent_WithHandler_InvokesHandler() {
        let source = `package MyLib

open class A {
    event Changed (int32) -> void
}

open class B : A {
}

class C : B {
    func RaiseFromC(v int32) { Changed?(v) }
}`
        let assembly = CompileToAssembly(source)
        let cType = assembly.GetTypes().Single((t Type) -> t.Name == "C")
        let instance = Activator.CreateInstance(cType)!!
        var observed = 0
        let ev = cType.GetEvent("Changed")!!
        let handler(int32) -> void = (v int32) -> {
            observed = v
        }
        ev.AddEventHandler(instance, handler)
        cType.GetMethod("RaiseFromC")!!.Invoke(instance, []object{99})
        Assert.Equal(99, observed)
    }

    @Fact
    func DerivedRaisesInheritedEvent_QualifiedInvokeForm_InvokesHandler() {
        let source = `package MyLib

open class Base {
    event Changed (int32) -> void
}

class Derived : Base {
    func RaiseFromDerived(v int32) { this.Changed?.Invoke(v) }
}`
        let assembly = CompileToAssembly(source)
        let derivedType = assembly.GetTypes().Single((t Type) -> t.Name == "Derived")
        let instance = Activator.CreateInstance(derivedType)!!
        var observed = 0
        let ev = derivedType.GetEvent("Changed")!!
        let handler(int32) -> void = (v int32) -> {
            observed = v
        }
        ev.AddEventHandler(instance, handler)
        derivedType.GetMethod("RaiseFromDerived")!!.Invoke(instance, []object{7})
        Assert.Equal(7, observed)
    }

    @Fact
    func BaseAndDerivedRaiseSameInheritedEvent_BothReachHandler() {
        let source = `package MyLib

open class Base {
    event Changed (int32) -> void
    func RaiseFromBase(v int32) { Changed?(v) }
}

class Derived : Base {
    func RaiseFromDerived(v int32) { Changed?(v) }
}`
        let assembly = CompileToAssembly(source)
        let derivedType = assembly.GetTypes().Single((t Type) -> t.Name == "Derived")
        let instance = Activator.CreateInstance(derivedType)!!
        var observed = 0
        let ev = derivedType.GetEvent("Changed")!!
        let handler(int32) -> void = (v int32) -> {
            observed = v
        }
        ev.AddEventHandler(instance, handler)
        // The same-type raise (declared on Base) and the inherited raise (from
        // Derived) both bind to the one backing field and reach the handler.
        derivedType.GetMethod("RaiseFromBase")!!.Invoke(instance, []object{11})
        Assert.Equal(11, observed)
        derivedType.GetMethod("RaiseFromDerived")!!.Invoke(instance, []object{22})
        Assert.Equal(22, observed)
    }

    shared {
        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1221_emit_").FullName
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
