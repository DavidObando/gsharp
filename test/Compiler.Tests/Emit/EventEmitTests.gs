// <copyright file="EventEmitTests.cs" company="GSharp">
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

/// ADR-0052: compiler emit tests for event declarations.
open class EventEmitTests {
    @Fact
    func FieldLikeEvent_EmitsEventDef() {
        let source = `package MyLib
import System

class MyButton {
    public event Click func(Object, EventArgs)
}`
        let assembly = CompileToAssembly(source)
        let button = assembly.GetTypes().Single((t Type) -> t.Name == "MyButton")
        let ev EventInfo? = button.GetEvent("Click")
        Assert.NotNull(ev)
        Assert.Equal("Click", ev!!.Name)
        Assert.NotNull(ev!!.AddMethod)
        Assert.NotNull(ev!!.RemoveMethod)
        Assert.Equal("add_Click", ev!!.AddMethod!!.Name)
        Assert.Equal("remove_Click", ev!!.RemoveMethod!!.Name)
        Assert.True(ev!!.AddMethod!!.IsSpecialName)
        Assert.True(ev!!.RemoveMethod!!.IsSpecialName)
    }

    @Fact
    func FieldLikeEvent_HasBackingField() {
        let source = `package MyLib
import System

class MyButton {
    public event Click func(Object, EventArgs)
}`
        let assembly = CompileToAssembly(source)
        let button = assembly.GetTypes().Single((t Type) -> t.Name == "MyButton")
        let backingField FieldInfo? = button.GetField("Click", BindingFlags.NonPublic | BindingFlags.Instance)
        Assert.NotNull(backingField)
        // Issue #1221: the field-like event backing field is emitted as
        // `family` (protected) rather than `private` so an inherited event can
        // be raised from a derived class (the derived method reads this field on
        // `this`). It remains inaccessible to unrelated types.
        Assert.True(backingField!!.IsFamily)
    }

    @Fact
    func FieldLikeEvent_AddRemove_WorksAtRuntime() {
        let source = `package MyLib
import System

class Notifier {
    public event Changed func()
}`
        let assembly = CompileToAssembly(source)
        let notifierType = assembly.GetTypes().Single((t Type) -> t.Name == "Notifier")
        let instance = Activator.CreateInstance(notifierType)!!
        let ev = notifierType.GetEvent("Changed")!!
        var invoked = false
        let handler() -> void = () -> {
            invoked = true
        }
        ev.AddEventHandler(instance, handler)
        // Raise by reading the backing field and invoking
        let backingField FieldInfo? = notifierType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance)
        var del Delegate? = backingField!!.GetValue(instance) as Delegate
        Assert.NotNull(del)
        del!!.DynamicInvoke()
        Assert.True(invoked)
        // Remove handler
        invoked = false
        ev.RemoveEventHandler(instance, handler)
        del = backingField!!.GetValue(instance) as Delegate
        Assert.Null(del)
    }

    @Fact
    func Event_MultipleHandlers() {
        let source = `package MyLib
import System

class Emitter {
    public event Ping func()
}`
        let assembly = CompileToAssembly(source)
        let emitterType = assembly.GetTypes().Single((t Type) -> t.Name == "Emitter")
        let instance = Activator.CreateInstance(emitterType)!!
        let ev = emitterType.GetEvent("Ping")!!
        var count = 0
        let h1() -> void = () -> count++
        let h2() -> void = () -> {
            count += 10
        }
        ev.AddEventHandler(instance, h1)
        ev.AddEventHandler(instance, h2)
        let backingField FieldInfo? = emitterType.GetField("Ping", BindingFlags.NonPublic | BindingFlags.Instance)
        let del Delegate? = backingField!!.GetValue(instance) as Delegate
        del!!.DynamicInvoke()
        Assert.Equal(11, count)
    }

    @Fact
    func InterfaceEvent_EmitsAbstractAccessors() {
        let source = `package MyLib

interface IObservable {
    event Changed func()
}`
        let assembly = CompileToAssembly(source)
        let iface = assembly.GetTypes().Single((t Type) -> t.Name == "IObservable")
        let ev EventInfo? = iface.GetEvent("Changed")
        Assert.NotNull(ev)
        Assert.NotNull(ev!!.AddMethod)
        Assert.NotNull(ev!!.RemoveMethod)
        Assert.True(ev!!.AddMethod!!.IsAbstract)
        Assert.True(ev!!.RemoveMethod!!.IsAbstract)
    }

    @Fact
    func RaiseAccessor_EmitsRaiseMethod() {
        let source = `package MyLib
import System

class Notifier {
    public event Changed func() {
        add { }
        remove { }
        raise { }
    }
}`
        let assembly = CompileToAssembly(source)
        let notifierType = assembly.GetTypes().Single((t Type) -> t.Name == "Notifier")
        let ev EventInfo? = notifierType.GetEvent("Changed")
        Assert.NotNull(ev)
        Assert.NotNull(ev!!.RaiseMethod)
        Assert.Equal("raise_Changed", ev!!.RaiseMethod!!.Name)
        Assert.True(ev!!.RaiseMethod!!.IsSpecialName)
    }

    @Fact
    func RaiseAccessor_MatchesHandlerParams() {
        let source = `package MyLib
import System

class Emitter {
    public event Notify func(int32, string) {
        add { }
        remove { }
        raise { }
    }
}`
        let assembly = CompileToAssembly(source)
        let emitterType = assembly.GetTypes().Single((t Type) -> t.Name == "Emitter")
        let ev EventInfo? = emitterType.GetEvent("Notify")
        Assert.NotNull(ev)
        Assert.NotNull(ev!!.RaiseMethod)
        let raiseParams = ev!!.RaiseMethod!!.GetParameters()
        Assert.Equal(2, raiseParams.Length)
        Assert.Equal(typeof(int32), raiseParams[0].ParameterType)
        Assert.Equal(typeof(string), raiseParams[1].ParameterType)
    }

    @Fact
    func StaticEvent_EmitsStaticAccessors() {
        let source = `package MyLib
import System

class EventBus {
    shared {
        public event OnNotify func()
    }
}`
        let assembly = CompileToAssembly(source)
        let busType = assembly.GetTypes().Single((t Type) -> t.Name == "EventBus")
        let ev EventInfo? = busType.GetEvent("OnNotify")
        Assert.NotNull(ev)
        Assert.NotNull(ev!!.AddMethod)
        Assert.NotNull(ev!!.RemoveMethod)
        Assert.True(ev!!.AddMethod!!.IsStatic)
        Assert.True(ev!!.RemoveMethod!!.IsStatic)
    }

    @Fact
    func StaticEvent_AddRemove_WorksAtRuntime() {
        let source = `package MyLib
import System

class Bus {
    shared {
        public event Ping func()
    }
}`
        let assembly = CompileToAssembly(source)
        let busType = assembly.GetTypes().Single((t Type) -> t.Name == "Bus")
        let ev = busType.GetEvent("Ping")!!
        var invoked = false
        let handler() -> void = () -> {
            invoked = true
        }
        ev.AddMethod!!.Invoke(nil, []object{handler})
        // Read backing field and invoke
        let backingField FieldInfo? = busType.GetField("Ping", BindingFlags.NonPublic | BindingFlags.Static)
        var del Delegate? = backingField!!.GetValue(nil) as Delegate
        Assert.NotNull(del)
        del!!.DynamicInvoke()
        Assert.True(invoked)
        // Remove
        invoked = false
        ev.RemoveMethod!!.Invoke(nil, []object{handler})
        del = backingField!!.GetValue(nil) as Delegate
        Assert.Null(del)
    }

    @Fact
    func StaticEvent_WithRaiseAccessor_Emits() {
        let source = `package MyLib
import System

class Hub {
    shared {
        public event Alert func() {
            add { }
            remove { }
            raise { }
        }
    }
}`
        let assembly = CompileToAssembly(source)
        let hubType = assembly.GetTypes().Single((t Type) -> t.Name == "Hub")
        let ev EventInfo? = hubType.GetEvent("Alert")
        Assert.NotNull(ev)
        Assert.NotNull(ev!!.RaiseMethod)
        Assert.Equal("raise_Alert", ev!!.RaiseMethod!!.Name)
        Assert.True(ev!!.RaiseMethod!!.IsStatic)
        Assert.True(ev!!.RaiseMethod!!.IsSpecialName)
    }

    @Fact
    func Issue503_CapturingLambda_SubscribedToEventHandlerEvent_Works() {
        // Issue #503: a function literal that captures any outer variable,
        // when bound to an event with `+=`, used to fall through to the
        // standard EmitExpression path. That path produced an
        // Action<object, EventArgs> delegate (the default for the function
        // type) and tried to feed it to add_X(EventHandler), yielding
        // unverifiable IL — observed as a silent MSB4181 in dotnet build.
        //
        // After the fix, the function literal is redirected to the event's
        // declared delegate type, so capturing closures bind correctly and
        // raising the event runs the closure body.
        let source = `package MyLib
import System

class Source {
    public event Changed EventHandler
    init() { }
}`
        let assembly = CompileToAssembly(source)
        let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "Source")
        let instance = Activator.CreateInstance(sourceType)!!
        let ev = sourceType.GetEvent("Changed")!!
        var counter = 0
        let handler EventHandler = (s object?, e EventArgs) -> counter++
        ev.AddEventHandler(instance, handler)
        let backingField FieldInfo? = sourceType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance)
        var del Delegate? = backingField!!.GetValue(instance) as Delegate
        Assert.NotNull(del)
        // Simulate the capturing-lambda scenario by Dynamic-Invoking via the
        // EventHandler signature — the IL produced by gsc would otherwise be
        // invalid before the fix lands.
        del!!.DynamicInvoke(instance, EventArgs.Empty)
        Assert.Equal(1, counter)
        ev.RemoveEventHandler(instance, handler)
        del = backingField!!.GetValue(instance) as Delegate
        Assert.Null(del)
    }

    @Fact
    func Issue503_CapturingLambda_SubscribedToEventHandlerEvent_FromGSharpClass() {
        // End-to-end: a G# class subscribes a capturing lambda to a CLR
        // EventHandler event declared on another G# class, then raises the
        // event by invoking the backing delegate. The captured counter must
        // observe the side effect of the handler. Before the fix, gsc would
        // emit an Action<object, EventArgs> handler that fails IL
        // verification (silent MSB4181 in build pipelines).
        let source = `package MyLib
import System

class Counter {
    var Value int32
    init() { Value = 0 }
    func Increment() { Value = Value + 1 }
}

class Source {
    public event Changed EventHandler
    init() { }
}

class Probe {
    var Counter Counter
    var Src Source
    init() {
        Counter = Counter()
        Src = Source()
        var c = Counter
        Src.Changed += func(sender object, e EventArgs) {
            c.Increment()
        }
    }
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "Source")
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let probe = Activator.CreateInstance(probeType)!!
        let src = probeType.GetField("Src")!!.GetValue(probe)!!
        let counter = probeType.GetField("Counter")!!.GetValue(probe)!!
        let backingField FieldInfo? = sourceType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance)
        let del Delegate? = backingField!!.GetValue(src) as Delegate
        Assert.NotNull(del)
        del!!.DynamicInvoke(src, EventArgs.Empty)
        del!!.DynamicInvoke(src, EventArgs.Empty)
        del!!.DynamicInvoke(src, EventArgs.Empty)
        let value = int32(counterType.GetField("Value")!!.GetValue(counter)!!)
        Assert.Equal(3, value)
    }

    @Fact
    func Issue503_NonCapturingLambda_SubscribedToEventHandlerEvent_StillWorks() {
        // Regression guard for the non-capturing case the issue mentioned as
        // "working today". After fixing the delegate-type override the
        // non-capturing path goes through the same code, so make sure it
        // still produces verifiable IL and a functional subscription.
        let source = `package MyLib
import System

class Notifier {
    public event Fired EventHandler
    init() { }
}

class Probe {
    var N Notifier
    init() {
        N = Notifier()
        N.Fired += func(sender object, e EventArgs) {
            var x = 1
        }
    }
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let notifierType = assembly.GetTypes().Single((t Type) -> t.Name == "Notifier")
        let probe = Activator.CreateInstance(probeType)!!
        let n = probeType.GetField("N")!!.GetValue(probe)!!
        let backingField FieldInfo? = notifierType.GetField("Fired", BindingFlags.NonPublic | BindingFlags.Instance)
        let del Delegate? = backingField!!.GetValue(n) as Delegate
        Assert.NotNull(del)
        Assert.IsType[EventHandler](del)
        del!!.DynamicInvoke(n, EventArgs.Empty)
    }

    @Fact
    func Issue503_CapturingLambda_CapturesClassInstance_HoldsReference() {
        // The closure must hold a reference to the captured class instance,
        // not a value-typed snapshot, so that mutations on the captured
        // instance after subscription are observable when the handler fires.
        let source = `package MyLib
import System

class Counter {
    var Value int32
    init() { Value = 0 }
    func Bump() { Value = Value + 1 }
}

class Source {
    public event Changed EventHandler
    init() { }
}

class Probe {
    var Counter Counter
    var Src Source
    init() {
        Counter = Counter()
        Src = Source()
        var c = Counter
        Src.Changed += func(sender object, e EventArgs) {
            c.Bump()
        }
    }
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "Source")
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let probe = Activator.CreateInstance(probeType)!!
        let counter = probeType.GetField("Counter")!!.GetValue(probe)!!
        let src = probeType.GetField("Src")!!.GetValue(probe)!!
        // Mutate the captured instance after subscription — the closure must
        // see the same object (reference semantics).
        counterType.GetMethod("Bump")!!.Invoke(counter, Array.Empty[object]())
        Assert.Equal(1, int32(counterType.GetField("Value")!!.GetValue(counter)!!))
        let backingField FieldInfo? = sourceType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance)
        let del Delegate? = cast[Delegate](backingField!!.GetValue(src)!!)
        del!!.DynamicInvoke(src, EventArgs.Empty)
        Assert.Equal(2, int32(counterType.GetField("Value")!!.GetValue(counter)!!))
    }

    @Fact
    func Issue503_CapturingLambda_SubscribedToClrEvent_EmitsVerifiable() {
        // CLR-event variant of the regression: subscribing a capturing
        // lambda to an imported BCL event (AppDomain.ProcessExit, declared
        // as System.EventHandler). The original Oahu repro was this exact
        // shape — the event lives on an imported class, so the binder takes
        // the BoundClrEventSubscriptionExpression path. The closure rewrite
        // and delegate-target resolution must still produce verifiable IL.
        let source = `package MyLib
import System

var hits int32 = 0
var domain = AppDomain.CurrentDomain
domain.ProcessExit += func(sender object, e EventArgs) {
    hits = hits + 1
}`
        // Compiling alone covers the IL-verification regression. We do not
        // actually trigger ProcessExit at test time.
        let assembly = CompileToAssembly(source)
        Assert.NotNull(assembly)
    }

    @Fact
    func Issue503_ChainedReceiver_CapturingLambda_SubscribesAndFires() {
        // Follow-up to Issue #503: subscribing to an event reached through a
        // chained member access (`obj.Inner.Event += ...`). The parser emits
        // right-associative accessor syntax for `O.Inner.Changed`, so the
        // event-subscription binder must normalize the chain before
        // pattern-matching the event member. Before the fix this produced
        // GS0158 "Cannot find member +=" against the inner accessor.
        let source = `package MyLib
import System

class Counter {
    var Value int32
    init() { Value = 0 }
    func Bump() { Value = Value + 1 }
}

class Inner {
    public event Changed EventHandler
    init() { }
}

class Outer {
    var Inner Inner
    init() { Inner = Inner() }
}

class Probe {
    var Counter Counter
    var O Outer
    init() {
        Counter = Counter()
        O = Outer()
        var c = Counter
        O.Inner.Changed += func(s object, e EventArgs) {
            c.Bump()
        }
    }
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let innerType = assembly.GetTypes().Single((t Type) -> t.Name == "Inner")
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let probe = Activator.CreateInstance(probeType)!!
        let outer = probeType.GetField("O")!!.GetValue(probe)!!
        let inner = outer.GetType().GetField("Inner")!!.GetValue(outer)!!
        let counter = probeType.GetField("Counter")!!.GetValue(probe)!!
        let backingField FieldInfo? = innerType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance)
        let del Delegate? = cast[Delegate](backingField!!.GetValue(inner)!!)
        del!!.DynamicInvoke(inner, EventArgs.Empty)
        del!!.DynamicInvoke(inner, EventArgs.Empty)
        Assert.Equal(2, int32(counterType.GetField("Value")!!.GetValue(counter)!!))
    }

    @Fact
    func Issue503_ChainedReceiver_NonCapturingLambda_Subscribes() {
        // Non-capturing variant of the chained-receiver subscription — must
        // bind through the same normalization path without regressing.
        let source = `package MyLib
import System

class Inner {
    public event Fired EventHandler
    init() { }
}

class Outer {
    var Inner Inner
    init() { Inner = Inner() }
}

class Probe {
    var O Outer
    init() {
        O = Outer()
        O.Inner.Fired += func(s object, e EventArgs) {
            var x = 1
        }
    }
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let innerType = assembly.GetTypes().Single((t Type) -> t.Name == "Inner")
        let probe = Activator.CreateInstance(probeType)!!
        let outer = probeType.GetField("O")!!.GetValue(probe)!!
        let inner = outer.GetType().GetField("Inner")!!.GetValue(outer)!!
        let backingField FieldInfo? = innerType.GetField("Fired", BindingFlags.NonPublic | BindingFlags.Instance)
        let del Delegate? = cast[Delegate](backingField!!.GetValue(inner)!!)
        Assert.IsType[EventHandler](del)
        del!!.DynamicInvoke(inner, EventArgs.Empty)
    }

    @Fact
    func Issue503_ChainedReceiver_Unsubscribe_Removes() {
        // The chained-receiver fix must apply symmetrically to `-=`: after
        // unsubscribing, the backing delegate must no longer hold the
        // handler and the captured counter must not advance when the event
        // is raised.
        let source = `package MyLib
import System

class Counter {
    var Value int32
    init() { Value = 0 }
    func Bump() { Value = Value + 1 }
}

class Inner {
    public event Changed EventHandler
    init() { }
}

class Outer {
    var Inner Inner
    init() { Inner = Inner() }
}

class Probe {
    var Counter Counter
    var O Outer
    var Handler EventHandler
    init() {
        Counter = Counter()
        O = Outer()
        var c = Counter
        Handler = func(s object, e EventArgs) {
            c.Bump()
        }
        O.Inner.Changed += Handler
    }

    func Detach() {
        O.Inner.Changed -= Handler
    }
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let innerType = assembly.GetTypes().Single((t Type) -> t.Name == "Inner")
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let probe = Activator.CreateInstance(probeType)!!
        let outer = probeType.GetField("O")!!.GetValue(probe)!!
        let inner = outer.GetType().GetField("Inner")!!.GetValue(outer)!!
        let counter = probeType.GetField("Counter")!!.GetValue(probe)!!
        let backingField FieldInfo? = innerType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance)
        // Fire once to confirm subscription works.
        let del Delegate? = cast[Delegate](backingField!!.GetValue(inner)!!)
        del!!.DynamicInvoke(inner, EventArgs.Empty)
        Assert.Equal(1, int32(counterType.GetField("Value")!!.GetValue(counter)!!))
        // Detach and verify the backing delegate is now null.
        probeType.GetMethod("Detach")!!.Invoke(probe, Array.Empty[object]())
        let afterDetach Delegate? = backingField!!.GetValue(inner) as Delegate
        Assert.Null(afterDetach)
    }

    @Fact
    func Issue503_MethodGroup_ThisQualified_SubscribesToUserEvent() {
        // `src.Changed += this.OnHit`: the right-hand side is an instance
        // method group accessed through `this`. The event-subscription
        // binder must recognize the accessor pattern, capture `this` as the
        // delegate target, and route the group through method-group →
        // delegate conversion against the event's declared type.
        let source = `package MyLib
import System

class Source {
    public event Changed EventHandler
    init() { }
}

class Probe {
    var Src Source
    var Hits int32
    init() {
        Src = Source()
        Hits = 0
        Src.Changed += this.OnHit
    }

    func OnHit(sender object, e EventArgs) {
        Hits = Hits + 1
    }
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "Source")
        let probe = Activator.CreateInstance(probeType)!!
        let src = probeType.GetField("Src")!!.GetValue(probe)!!
        let backingField FieldInfo? = sourceType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance)
        let del Delegate? = cast[Delegate](backingField!!.GetValue(src)!!)
        Assert.IsType[EventHandler](del)
        del!!.DynamicInvoke(src, EventArgs.Empty)
        del!!.DynamicInvoke(src, EventArgs.Empty)
        Assert.Equal(2, int32(probeType.GetField("Hits")!!.GetValue(probe)!!))
    }

    @Fact
    func Issue503_MethodGroup_BareName_SubscribesToUserEvent() {
        // `src.Changed += OnHit` (bare name inside the declaring class)
        // must bind as the implicit-`this` instance method group, mirroring
        // the C# rule. Before the fix, the bare name surfaced as GS0125
        // "Variable doesn't exist" because instance methods aren't visible
        // as variables.
        let source = `package MyLib
import System

class Source {
    public event Changed EventHandler
    init() { }
}

class Probe {
    var Src Source
    var Hits int32
    init() {
        Src = Source()
        Hits = 0
        Src.Changed += OnHit
    }

    func OnHit(sender object, e EventArgs) {
        Hits = Hits + 1
    }
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "Source")
        let probe = Activator.CreateInstance(probeType)!!
        let src = probeType.GetField("Src")!!.GetValue(probe)!!
        let backingField FieldInfo? = sourceType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance)
        let del Delegate? = cast[Delegate](backingField!!.GetValue(src)!!)
        Assert.IsType[EventHandler](del)
        del!!.DynamicInvoke(src, EventArgs.Empty)
        Assert.Equal(1, int32(probeType.GetField("Hits")!!.GetValue(probe)!!))
    }

    @Fact
    func Issue503_MethodGroup_UnsubscribeFromUserEvent_Removes() {
        // Symmetric `-=` for instance method groups on user events: after
        // detaching, the backing delegate must drop to null and raising the
        // event must not increment the hit counter.
        let source = `package MyLib
import System

class Source {
    public event Changed EventHandler
    init() { }
}

class Probe {
    var Src Source
    var Hits int32
    init() {
        Src = Source()
        Hits = 0
        Src.Changed += this.OnHit
    }

    func Detach() {
        Src.Changed -= this.OnHit
    }

    func OnHit(sender object, e EventArgs) {
        Hits = Hits + 1
    }
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "Source")
        let probe = Activator.CreateInstance(probeType)!!
        let src = probeType.GetField("Src")!!.GetValue(probe)!!
        let backingField FieldInfo? = sourceType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance)
        let del Delegate? = cast[Delegate](backingField!!.GetValue(src)!!)
        del!!.DynamicInvoke(src, EventArgs.Empty)
        Assert.Equal(1, int32(probeType.GetField("Hits")!!.GetValue(probe)!!))
        probeType.GetMethod("Detach")!!.Invoke(probe, Array.Empty[object]())
        let afterDetach Delegate? = backingField!!.GetValue(src) as Delegate
        Assert.Null(afterDetach)
    }

    @Fact
    func Issue503_MethodGroup_OnClrEvent_EmitsVerifiable() {
        // The method-group conversion must work uniformly for CLR-declared
        // events. AppDomain.ProcessExit (System.EventHandler) is a stable
        // BCL event we can subscribe to at runtime without firing it; the
        // compile/IL-verify path covers the regression even when ProcessExit
        // never fires during the test.
        let source = `package MyLib
import System

class Probe {
    init() {
        AppDomain.CurrentDomain.ProcessExit += this.OnExit
    }

    func Detach() {
        AppDomain.CurrentDomain.ProcessExit -= this.OnExit
    }

    func OnExit(sender object, e EventArgs) { }
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let probe = Activator.CreateInstance(probeType)!!
        try {
            // Best-effort detach so we don't leave a handler attached to
            // ProcessExit across the test process lifetime.
            probeType.GetMethod("Detach")!!.Invoke(probe, Array.Empty[object]())
        } catch {
            // ignored — the registration alone exercises the verifier

        }
    }

    @Fact
    func Adr0112A5_InheritedInstanceEvent_SubscribesThroughDerivedReceiver() {
        // ADR-0112 A5: instance event subscription on an explicit receiver now
        // routes through TypeMemberModel.TryGetEvent, which walks the base
        // chain. An instance event declared on an `open class` base must
        // resolve when subscribed through a derived receiver. Before A5 the
        // single-level `userStruct.Events` lookup fell through to an error.
        let source = `package MyLib
import System

class A5InhCounter {
    var Value int32
    init() { Value = 0 }
    func Bump() { Value = Value + 1 }
}

open class A5InhBase {
    public event A5InhChanged EventHandler
    init() { }
}

class A5InhDerived : A5InhBase {
    init() { }
}

class A5InhProbe {
    var Counter A5InhCounter
    var D A5InhDerived
    init() {
        Counter = A5InhCounter()
        D = A5InhDerived()
        var c = Counter
        D.A5InhChanged += func(s object, e EventArgs) {
            c.Bump()
        }
    }
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "A5InhProbe")
        let baseType = assembly.GetTypes().Single((t Type) -> t.Name == "A5InhBase")
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "A5InhCounter")
        let probe = Activator.CreateInstance(probeType)!!
        let derived = probeType.GetField("D")!!.GetValue(probe)!!
        let counter = probeType.GetField("Counter")!!.GetValue(probe)!!
        // The backing field is declared on the base type.
        let backingField FieldInfo? = baseType.GetField("A5InhChanged", BindingFlags.NonPublic | BindingFlags.Instance)
        let del Delegate? = cast[Delegate](backingField!!.GetValue(derived)!!)
        Assert.NotNull(del)
        del!!.DynamicInvoke(derived, EventArgs.Empty)
        del!!.DynamicInvoke(derived, EventArgs.Empty)
        Assert.Equal(2, int32(counterType.GetField("Value")!!.GetValue(counter)!!))
    }

    @Fact
    func Adr0112A5_ImmediateInstanceEvent_SubscribesUnchanged() {
        // ADR-0112 A5 parity: subscribing to an event declared directly on the
        // receiver's own type must still bind and fire (no behavior change).
        let source = `package MyLib
import System

class A5ImmCounter {
    var Value int32
    init() { Value = 0 }
    func Bump() { Value = Value + 1 }
}

class A5ImmSource {
    public event A5ImmChanged EventHandler
    init() { }
}

class A5ImmProbe {
    var Counter A5ImmCounter
    var Src A5ImmSource
    init() {
        Counter = A5ImmCounter()
        Src = A5ImmSource()
        var c = Counter
        Src.A5ImmChanged += func(s object, e EventArgs) {
            c.Bump()
        }
    }
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "A5ImmProbe")
        let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "A5ImmSource")
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "A5ImmCounter")
        let probe = Activator.CreateInstance(probeType)!!
        let src = probeType.GetField("Src")!!.GetValue(probe)!!
        let counter = probeType.GetField("Counter")!!.GetValue(probe)!!
        let backingField FieldInfo? = sourceType.GetField(
            "A5ImmChanged",
            BindingFlags.NonPublic | BindingFlags.Instance
        )
        let del Delegate? = cast[Delegate](backingField!!.GetValue(src)!!)
        del!!.DynamicInvoke(src, EventArgs.Empty)
        Assert.Equal(1, int32(counterType.GetField("Value")!!.GetValue(counter)!!))
    }

    @Fact
    func Adr0112A5_StaticEvent_SubscribesUnchanged() {
        // ADR-0112 A5 parity: static event subscription (Issue #263) now routes
        // through TypeMemberModel.TryGetStaticEvent (single-level, first-by-name)
        // and must bind and fire exactly as before.
        let source = `package MyLib
import System

class A5StatCounter {
    var Value int32
    init() { Value = 0 }
    func Bump() { Value = Value + 1 }
}

class A5StatBus {
    shared {
        public event A5StatPing EventHandler
    }
    var Counter A5StatCounter
    init() {
        Counter = A5StatCounter()
        var c = Counter
        A5StatBus.A5StatPing += func(s object, e EventArgs) {
            c.Bump()
        }
    }
}`
        let assembly = CompileToAssembly(source)
        let busType = assembly.GetTypes().Single((t Type) -> t.Name == "A5StatBus")
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "A5StatCounter")
        let probe = Activator.CreateInstance(busType)!!
        let counter = busType.GetField("Counter")!!.GetValue(probe)!!
        let backingField FieldInfo? = busType.GetField("A5StatPing", BindingFlags.NonPublic | BindingFlags.Static)
        let del Delegate? = cast[Delegate](backingField!!.GetValue(nil)!!)
        del!!.DynamicInvoke(busType, EventArgs.Empty)
        Assert.Equal(1, int32(counterType.GetField("Value")!!.GetValue(counter)!!))
    }

    shared {
        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_event_emit_").FullName
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
