// <copyright file="Issue2796NullConditionalEventRaiseEmitTests.cs" company="GSharp">
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

/// Issue #2796: the null-conditional raise form `Evt?(args)` of a
/// field-like event must short-circuit to a no-op when the backing delegate is
/// null (no subscribers), mirroring C# `Evt?.Invoke(args)`. PR #2792
/// (fix/2726) canonicalizes conventional structural event shapes
/// (`(object?, EventArgs) -> void`) and nominal `EventHandler` events
/// to the CLR `System.EventHandler`/`EventHandler<T>` delegates,
/// which routes the invocation through the CLR-delegate call path. That path
/// lacked the null guard the FunctionTypeSymbol / named-delegate paths already
/// carried, so a fresh event with no subscribers threw
/// (cref:NullReferenceException) instead of no-opping. These tests prove
/// the emitted IL verifies and runs for the zero-subscriber, subscribed,
/// unsubscribe-then-raise, and generic `EventHandler<T>` shapes.
open class Issue2796NullConditionalEventRaiseEmitTests {
    @Fact
    func NominalEventHandlerRaise_NoSubscribers_IsSafeNoOp() {
        let source = `package MyLib
import System

class Bell {
    event Rang EventHandler
    func Ring() { Rang?(this, EventArgs.Empty) }
}`
        let assembly = CompileToAssembly(source)
        let bellType = assembly.GetTypes().Single((t Type) -> t.Name == "Bell")
        let instance = Activator.CreateInstance(bellType)!!
        // No subscriber: the backing delegate is null, so raising must be a
        // no-op rather than throwing a NullReferenceException.
        let ring = bellType.GetMethod("Ring")!!
        let ex = Record.Exception(() -> ring.Invoke(instance, nil))
        Assert.Null(ex)
    }

    @Fact
    func NominalEventHandlerRaise_WithSubscriber_InvokesHandler() {
        let source = `package MyLib
import System

class Bell {
    event Rang EventHandler
    func Ring() { Rang?(this, EventArgs.Empty) }
}`
        let assembly = CompileToAssembly(source)
        let bellType = assembly.GetTypes().Single((t Type) -> t.Name == "Bell")
        let instance = Activator.CreateInstance(bellType)!!
        var hits = 0
        let ev = bellType.GetEvent("Rang")!!
        let handler EventHandler = (_ object?, _ EventArgs) -> hits++
        ev.AddEventHandler(instance, handler)
        bellType.GetMethod("Ring")!!.Invoke(instance, nil)
        Assert.Equal(1, hits)
    }

    @Fact
    func StructuralEventArgsRaise_NoSubscribers_IsSafeNoOp() {
        // A conventional structural `(object?, EventArgs) -> void` event is
        // canonicalized to nominal `System.EventHandler` by PR #2792; the raise
        // must still no-op with no subscribers (regression the fix restores).
        let source = `package MyLib
import System

class Bell {
    event Rang (object?, EventArgs) -> void
    func Ring() { Rang?(this, EventArgs.Empty) }
}`
        let assembly = CompileToAssembly(source)
        let bellType = assembly.GetTypes().Single((t Type) -> t.Name == "Bell")
        let instance = Activator.CreateInstance(bellType)!!
        let ring = bellType.GetMethod("Ring")!!
        let ex = Record.Exception(() -> ring.Invoke(instance, nil))
        Assert.Null(ex)
    }

    @Fact
    func StructuralEventArgsRaise_WithSubscriber_InvokesHandler() {
        let source = `package MyLib
import System

class Bell {
    event Rang (object?, EventArgs) -> void
    func Ring() { Rang?(this, EventArgs.Empty) }
}`
        let assembly = CompileToAssembly(source)
        let bellType = assembly.GetTypes().Single((t Type) -> t.Name == "Bell")
        let instance = Activator.CreateInstance(bellType)!!
        var hits = 0
        let ev = bellType.GetEvent("Rang")!!
        let handler EventHandler = (_ object?, _ EventArgs) -> hits++
        ev.AddEventHandler(instance, handler)
        bellType.GetMethod("Ring")!!.Invoke(instance, nil)
        Assert.Equal(1, hits)
    }

    @Fact
    func NominalEventHandlerRaise_UnsubscribeThenRaise_IsSafeNoOp() {
        // The canonical `SettingsBase.OnChange` failure mode: after the last
        // subscriber is removed the backing delegate is null again, so a
        // subsequent raise must no-op rather than NRE.
        let source = `package MyLib
import System

class Bell {
    event Rang EventHandler
    func Ring() { Rang?(this, EventArgs.Empty) }
}`
        let assembly = CompileToAssembly(source)
        let bellType = assembly.GetTypes().Single((t Type) -> t.Name == "Bell")
        let instance = Activator.CreateInstance(bellType)!!
        let ring = bellType.GetMethod("Ring")!!
        let ev = bellType.GetEvent("Rang")!!
        var hits = 0
        let handler EventHandler = (_ object?, _ EventArgs) -> hits++
        ev.AddEventHandler(instance, handler)
        ring.Invoke(instance, nil)
        Assert.Equal(1, hits)
        ev.RemoveEventHandler(instance, handler)
        let ex = Record.Exception(() -> ring.Invoke(instance, nil))
        Assert.Null(ex)
        Assert.Equal(1, hits)
    }

    @Fact
    func GenericEventHandlerRaise_NoSubscribersAndWithSubscriber_Behaves() {
        let source = `package MyLib
import System

class Bus[T EventArgs] {
    event Msg EventHandler[T]
    func Fire(a T) { Msg?(this, a) }
}`
        let assembly = CompileToAssembly(source)
        let openBus = assembly.GetTypes().Single((t Type) -> t.Name == "Bus`1")
        let closedBus = openBus.MakeGenericType(typeof(EventArgs))
        let instance = Activator.CreateInstance(closedBus)!!
        let fire = closedBus.GetMethod("Fire")!!
        // No subscriber: raising the generic event must no-op.
        let ex = Record.Exception(() -> fire.Invoke(instance, []object{EventArgs.Empty}))
        Assert.Null(ex)
        // With a subscriber the handler is invoked with the raised argument.
        var hits = 0
        let ev = closedBus.GetEvent("Msg")!!
        let handler EventHandler[EventArgs] = (_ object?, _ EventArgs) -> hits++
        ev.AddEventHandler(instance, handler)
        fire.Invoke(instance, []object{EventArgs.Empty})
        Assert.Equal(1, hits)
    }

    shared {
        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2796_emit_").FullName
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
