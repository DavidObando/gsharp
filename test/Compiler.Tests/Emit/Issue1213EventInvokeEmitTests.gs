// <copyright file="Issue1213EventInvokeEmitTests.cs" company="GSharp">
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

/// Issue #1213: an `event` member declared on a class must be referenceable
/// in expression position (bare and `this.`-qualified) inside the declaring
/// type so the canonical raise pattern `MyEvent?.Invoke(args)` binds and
/// emits. Inside the type an event read resolves to its private backing delegate
/// field; the null-conditional invoke lowers to a null-check plus a delegate
/// `Invoke`. These tests prove the emitted IL verifies and runs: a null
/// backing field makes the raise a safe no-op, and a subscribed handler is
/// invoked with the raised arguments.
open class Issue1213EventInvokeEmitTests {
    @Fact
    func BareEventRaise_NullBackingField_IsSafeNoOp() {
        let source = `package MyLib

class Counter {
    event Bumped (int32) -> void
    func Raise(n int32) { Bumped?.Invoke(n) }
}`
        let assembly = CompileToAssembly(source)
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let instance = Activator.CreateInstance(counterType)!!
        // No handler subscribed: the backing delegate field is null, so raising
        // must be a no-op rather than throwing a NullReferenceException.
        let raise = counterType.GetMethod("Raise")!!
        let ex = Record.Exception(() -> raise.Invoke(instance, []object{5}))
        Assert.Null(ex)
    }

    @Fact
    func BareEventRaise_WithHandler_InvokesHandler() {
        let source = `package MyLib

class Counter {
    event Bumped (int32) -> void
    func Raise(n int32) { Bumped?.Invoke(n) }
}`
        let assembly = CompileToAssembly(source)
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let instance = Activator.CreateInstance(counterType)!!
        var total = 0
        let ev = counterType.GetEvent("Bumped")!!
        let handler(int32) -> void = (n int32) -> {
            total += n
        }
        ev.AddEventHandler(instance, handler)
        counterType.GetMethod("Raise")!!.Invoke(instance, []object{7})
        Assert.Equal(7, total)
    }

    @Fact
    func QualifiedEventRaise_WithHandler_InvokesHandler() {
        let source = `package MyLib

class Counter {
    event Bumped (int32) -> void
    func RaiseQualified(n int32) { this.Bumped?.Invoke(n) }
}`
        let assembly = CompileToAssembly(source)
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let instance = Activator.CreateInstance(counterType)!!
        var total = 0
        let ev = counterType.GetEvent("Bumped")!!
        let handler(int32) -> void = (n int32) -> {
            total += n
        }
        ev.AddEventHandler(instance, handler)
        counterType.GetMethod("RaiseQualified")!!.Invoke(instance, []object{3})
        Assert.Equal(3, total)
    }

    @Fact
    func EventNilCheck_ReflectsSubscriptionState() {
        let source = `package MyLib

class Counter {
    event Bumped (int32) -> void
    func HasSub() bool { return Bumped != nil }
}`
        let assembly = CompileToAssembly(source)
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let instance = Activator.CreateInstance(counterType)!!
        let hasSub = counterType.GetMethod("HasSub")!!
        Assert.False(bool(hasSub.Invoke(instance, nil)!!))
        let ev = counterType.GetEvent("Bumped")!!
        let handler(int32) -> void = (_ int32) -> { }
        ev.AddEventHandler(instance, handler)
        Assert.True(bool(hasSub.Invoke(instance, nil)!!))
    }

    @Fact
    func MultiArgVoidEventRaise_PassesAllArguments() {
        let source = `package MyLib

class Emitter {
    event Notify (int32, string) -> void
    func Fire(n int32, s string) { Notify?.Invoke(n, s) }
}`
        let assembly = CompileToAssembly(source)
        let emitterType = assembly.GetTypes().Single((t Type) -> t.Name == "Emitter")
        let instance = Activator.CreateInstance(emitterType)!!
        var seenInt = 0
        var seenStr string? = nil
        let ev = emitterType.GetEvent("Notify")!!
        let handler(int32, string) -> void = (n int32, s string) -> {
            seenInt = n
            seenStr = s
        }
        ev.AddEventHandler(instance, handler)
        emitterType.GetMethod("Fire")!!.Invoke(instance, []object{42, "hi"})
        Assert.Equal(42, seenInt)
        Assert.Equal("hi", seenStr)
    }

    shared {
        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1213_emit_").FullName
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
