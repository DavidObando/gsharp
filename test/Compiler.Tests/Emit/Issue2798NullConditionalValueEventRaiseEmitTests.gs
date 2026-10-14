// <copyright file="Issue2798NullConditionalValueEventRaiseEmitTests.cs" company="GSharp">
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

/// Issue #2798: the null-conditional raise form `Evt?(args)` of a
/// field-like event whose delegate <b>returns a value</b> must short-circuit to
/// the correct optional/null result when the backing delegate is null (no
/// subscribers), mirroring C# `Evt?.Invoke(args)`. PR #2797 (issue #2796)
/// fixed the `void`-returning raise on both the nominal CLR-delegate path
/// (`OverloadResolver.CallBinding`) and the structural
/// (cref:Symbols.FunctionTypeSymbol) path
/// (`OverloadResolver.Invocations.BuildIndirectDelegateCall`), but both
/// guarded only the `void` result and emitted an unconditional
/// `callvirt Invoke` for value-returning delegates — NRE-ing on a fresh
/// event with no subscribers.
///
/// This fix generalizes the established nullable-delegate invocation result-slot
/// lowering (the same lowering `TryBindNullableDelegateInvocation` uses for
/// nullable delegate properties, issue #2772) to both paths so a null receiver
/// yields `null`/`default`, the receiver is evaluated once, and a
/// non-null delegate invokes normally. These tests cover nominal
/// `Func<...>` and structural function delegates, reference- and
/// value-returning shapes, zero-subscriber / subscribed / unsubscribe-then-call
/// cases, side-effectful argument single-evaluation and short-circuit, natural
/// `??` fallback consumption (including value-type null coalescing), runtime
/// behavior, metadata, and ILVerify.
open class Issue2798NullConditionalValueEventRaiseEmitTests {
    @Fact
    func NominalFuncValueReturn_NoSubscribers_YieldsNullFallback() {
        // Nominal CLR `Func<int, int>` event, value-returning. With no
        // subscribers the null-conditional raise must produce a null optional
        // whose `?? -1` fallback yields -1 rather than throwing NRE.
        let source = `package MyLib
import System

class Poll {
    event Ask Func[int32,int32]
    func Run() int32 {
        var r = Ask?(5)
        return r ?? -1
    }
}`
        let poll = CompilePollType(source, out _)
        let instance = Activator.CreateInstance(poll)!!
        let run = poll.GetMethod("Run")!!
        Assert.Equal(-1, run.Invoke(instance, nil))
    }

    @Fact
    func NominalFuncValueReturn_WithSubscriber_InvokesAndReturnsValue() {
        let source = `package MyLib
import System

class Poll {
    event Ask Func[int32,int32]
    func Run() int32 {
        var r = Ask?(5)
        return r ?? -1
    }
}`
        let poll = CompilePollType(source, out _)
        let instance = Activator.CreateInstance(poll)!!
        let run = poll.GetMethod("Run")!!
        Subscribe(poll, instance, "IntDoubler")
        Assert.Equal(10, run.Invoke(instance, nil))
    }

    @Fact
    func StructuralFunctionValueReturn_NoSubscribers_YieldsNullFallback() {
        // Structural `(int32) -> int32` event routes through
        // BuildIndirectDelegateCall. The value-returning raise must yield the
        // null fallback with no subscribers.
        let source = `package MyLib

class Poll {
    event Ask (int32) -> int32
    func Run() int32 {
        var r = Ask?(5)
        return r ?? -1
    }
}`
        let poll = CompilePollType(source, out _)
        let instance = Activator.CreateInstance(poll)!!
        let run = poll.GetMethod("Run")!!
        Assert.Equal(-1, run.Invoke(instance, nil))
    }

    @Fact
    func StructuralFunctionValueReturn_WithSubscriber_InvokesAndReturnsValue() {
        let source = `package MyLib

class Poll {
    event Ask (int32) -> int32
    func Run() int32 {
        var r = Ask?(5)
        return r ?? -1
    }
}`
        let poll = CompilePollType(source, out _)
        let instance = Activator.CreateInstance(poll)!!
        let run = poll.GetMethod("Run")!!
        Subscribe(poll, instance, "IntDoubler")
        Assert.Equal(10, run.Invoke(instance, nil))
    }

    @Fact
    func NominalFuncReferenceReturn_ZeroSubscriberAndSubscribed_Behaves() {
        // Reference-returning shape: the null branch leaves `ldnull` (a valid
        // Nullable<ref>), no value-type result slot involved.
        let source = `package MyLib
import System

class Poll {
    event Ask Func[string,string]
    func Run() string {
        var r = Ask?("hi")
        return r ?? "none"
    }
}`
        let poll = CompilePollType(source, out _)
        let instance = Activator.CreateInstance(poll)!!
        let run = poll.GetMethod("Run")!!
        Assert.Equal("none", run.Invoke(instance, nil))
        Subscribe(poll, instance, "StringShout")
        Assert.Equal("HI", run.Invoke(instance, nil))
    }

    @Fact
    func StructuralFunctionReferenceReturn_ZeroSubscriberAndSubscribed_Behaves() {
        let source = `package MyLib

class Poll {
    event Ask (string) -> string
    func Run() string {
        var r = Ask?("hi")
        return r ?? "none"
    }
}`
        let poll = CompilePollType(source, out _)
        let instance = Activator.CreateInstance(poll)!!
        let run = poll.GetMethod("Run")!!
        Assert.Equal("none", run.Invoke(instance, nil))
        Subscribe(poll, instance, "StringShout")
        Assert.Equal("HI", run.Invoke(instance, nil))
    }

    @Fact
    func ValueReturn_BareResult_IsNilWhenNoSubscribers() {
        // Without a `??` fallback the null-conditional result is a genuine
        // optional; `r == nil` must be true with no subscribers and false once
        // a subscriber is attached.
        let source = `package MyLib
import System

class Poll {
    event Ask Func[int32,int32]
    func IsNil() bool {
        var r = Ask?(5)
        return r == nil
    }
}`
        let poll = CompilePollType(source, out _)
        let instance = Activator.CreateInstance(poll)!!
        let isNil = poll.GetMethod("IsNil")!!
        Assert.Equal(true, isNil.Invoke(instance, nil))
        Subscribe(poll, instance, "IntDoubler")
        Assert.Equal(false, isNil.Invoke(instance, nil))
    }

    @Fact
    func ValueReturn_UnsubscribeThenCall_YieldsNullFallbackAgain() {
        // After the last subscriber is removed the backing delegate is null
        // again, so a subsequent value-returning raise must yield the null
        // fallback rather than NRE (the SettingsBase.OnChange failure mode,
        // value-returning variant).
        let source = `package MyLib
import System

class Poll {
    event Ask Func[int32,int32]
    func Run() int32 {
        var r = Ask?(5)
        return r ?? -1
    }
}`
        let poll = CompilePollType(source, out _)
        let instance = Activator.CreateInstance(poll)!!
        let run = poll.GetMethod("Run")!!
        let ev = poll.GetEvent("Ask")!!
        let handler = Delegate.CreateDelegate(
            ev.EventHandlerType!!,
            typeof(Issue2798NullConditionalValueEventRaiseEmitTests).GetMethod("IntDoubler")!!
        )
        ev.AddEventHandler(instance, handler)
        Assert.Equal(10, run.Invoke(instance, nil))
        ev.RemoveEventHandler(instance, handler)
        Assert.Equal(-1, run.Invoke(instance, nil))
    }

    @Fact
    func ValueReturn_SideEffectfulArgument_EvaluatedOnceAndShortCircuits() {
        // The raised argument must be evaluated exactly once on the non-null
        // path and not at all when the receiver is null (C# `Evt?.Invoke(arg)`
        // short-circuit). `Bump()` increments an observable counter.
        let source = `package MyLib
import System

class Poll {
    var counter int32
    event Ask Func[int32,int32]
    func Bump() int32 {
        counter = counter + 1
        return counter
    }
    func Count() int32 { return counter }
    func Run() int32 {
        var r = Ask?(Bump())
        return r ?? -1
    }
}`
        let poll = CompilePollType(source, out _)
        let instance = Activator.CreateInstance(poll)!!
        let run = poll.GetMethod("Run")!!
        let count = poll.GetMethod("Count")!!
        // No subscriber: the argument (Bump) must NOT be evaluated.
        Assert.Equal(-1, run.Invoke(instance, nil))
        Assert.Equal(0, count.Invoke(instance, nil))
        // Subscribed: the argument is evaluated exactly once (counter -> 1),
        // and the doubled result (2) is returned.
        Subscribe(poll, instance, "IntDoubler")
        Assert.Equal(2, run.Invoke(instance, nil))
        Assert.Equal(1, count.Invoke(instance, nil))
    }

    shared {
        /// Doubles its argument; bound to `Func<int, int>` / `(int32) -> int32` events.
        func IntDoubler(x int32) int32 -> x * 2

        /// Uppercases its argument; bound to `Func<string, string>` / `(string) -> string` events.
        func StringShout(s string) string -> s.ToUpperInvariant()

        private func Subscribe(pollType Type, instance object, handlerMethodName string) {
            let ev = pollType.GetEvent("Ask")!!
            let handler = Delegate.CreateDelegate(
                ev.EventHandlerType!!,
                typeof(Issue2798NullConditionalValueEventRaiseEmitTests).GetMethod(handlerMethodName)!!
            )
            ev.AddEventHandler(instance, handler)
        }

        private func CompilePollType(source string, out assembly Assembly) Type {
            assembly = CompileToAssembly(source)
            return assembly.GetTypes().Single((t Type) -> t.Name == "Poll")
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2798_emit_").FullName
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
