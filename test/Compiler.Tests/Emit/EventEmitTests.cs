// <copyright file="EventEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0052: compiler emit tests for event declarations.
/// </summary>
public class EventEmitTests
{
    [Fact]
    public void FieldLikeEvent_EmitsEventDef()
    {
        var source = """
            package MyLib
            import System

            class MyButton {
                public event Click func(Object, EventArgs)
            }
            """;

        var assembly = CompileToAssembly(source);
        var button = assembly.GetTypes().Single(t => t.Name == "MyButton");
        var ev = button.GetEvent("Click");

        Assert.NotNull(ev);
        Assert.Equal("Click", ev!.Name);
        Assert.NotNull(ev.AddMethod);
        Assert.NotNull(ev.RemoveMethod);
        Assert.Equal("add_Click", ev.AddMethod!.Name);
        Assert.Equal("remove_Click", ev.RemoveMethod!.Name);
        Assert.True(ev.AddMethod.IsSpecialName);
        Assert.True(ev.RemoveMethod.IsSpecialName);
    }

    [Fact]
    public void FieldLikeEvent_HasBackingField()
    {
        var source = """
            package MyLib
            import System

            class MyButton {
                public event Click func(Object, EventArgs)
            }
            """;

        var assembly = CompileToAssembly(source);
        var button = assembly.GetTypes().Single(t => t.Name == "MyButton");
        var backingField = button.GetField("Click", BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(backingField);

        // Issue #1221: the field-like event backing field is emitted as
        // `family` (protected) rather than `private` so an inherited event can
        // be raised from a derived class (the derived method reads this field on
        // `this`). It remains inaccessible to unrelated types.
        Assert.True(backingField!.IsFamily);
    }

    [Fact]
    public void FieldLikeEvent_AddRemove_WorksAtRuntime()
    {
        var source = """
            package MyLib
            import System

            class Notifier {
                public event Changed func()
            }
            """;

        var assembly = CompileToAssembly(source);
        var notifierType = assembly.GetTypes().Single(t => t.Name == "Notifier");
        var instance = Activator.CreateInstance(notifierType)!;
        var ev = notifierType.GetEvent("Changed")!;

        bool invoked = false;
        Action handler = () => invoked = true;
        ev.AddEventHandler(instance, handler);

        // Raise by reading the backing field and invoking
        var backingField = notifierType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = backingField!.GetValue(instance) as Delegate;
        Assert.NotNull(del);
        del!.DynamicInvoke();
        Assert.True(invoked);

        // Remove handler
        invoked = false;
        ev.RemoveEventHandler(instance, handler);
        del = backingField.GetValue(instance) as Delegate;
        Assert.Null(del);
    }

    [Fact]
    public void Event_MultipleHandlers()
    {
        var source = """
            package MyLib
            import System

            class Emitter {
                public event Ping func()
            }
            """;

        var assembly = CompileToAssembly(source);
        var emitterType = assembly.GetTypes().Single(t => t.Name == "Emitter");
        var instance = Activator.CreateInstance(emitterType)!;
        var ev = emitterType.GetEvent("Ping")!;

        int count = 0;
        Action h1 = () => count++;
        Action h2 = () => count += 10;
        ev.AddEventHandler(instance, h1);
        ev.AddEventHandler(instance, h2);

        var backingField = emitterType.GetField("Ping", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = backingField!.GetValue(instance) as Delegate;
        del!.DynamicInvoke();
        Assert.Equal(11, count);
    }

    [Fact]
    public void InterfaceEvent_EmitsAbstractAccessors()
    {
        var source = """
            package MyLib

            interface IObservable {
                event Changed func()
            }
            """;

        var assembly = CompileToAssembly(source);
        var iface = assembly.GetTypes().Single(t => t.Name == "IObservable");
        var ev = iface.GetEvent("Changed");

        Assert.NotNull(ev);
        Assert.NotNull(ev!.AddMethod);
        Assert.NotNull(ev!.RemoveMethod);
        Assert.True(ev.AddMethod!.IsAbstract);
        Assert.True(ev.RemoveMethod!.IsAbstract);
    }

    [Fact]
    public void RaiseAccessor_EmitsRaiseMethod()
    {
        var source = """
            package MyLib
            import System

            class Notifier {
                public event Changed func() {
                    add { }
                    remove { }
                    raise { }
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var notifierType = assembly.GetTypes().Single(t => t.Name == "Notifier");
        var ev = notifierType.GetEvent("Changed");

        Assert.NotNull(ev);
        Assert.NotNull(ev!.RaiseMethod);
        Assert.Equal("raise_Changed", ev.RaiseMethod!.Name);
        Assert.True(ev.RaiseMethod.IsSpecialName);
    }

    [Fact]
    public void RaiseAccessor_MatchesHandlerParams()
    {
        var source = """
            package MyLib
            import System

            class Emitter {
                public event Notify func(int32, string) {
                    add { }
                    remove { }
                    raise { }
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var emitterType = assembly.GetTypes().Single(t => t.Name == "Emitter");
        var ev = emitterType.GetEvent("Notify");

        Assert.NotNull(ev);
        Assert.NotNull(ev!.RaiseMethod);
        var raiseParams = ev.RaiseMethod!.GetParameters();
        Assert.Equal(2, raiseParams.Length);
        Assert.Equal(typeof(int), raiseParams[0].ParameterType);
        Assert.Equal(typeof(string), raiseParams[1].ParameterType);
    }

    [Fact]
    public void StaticEvent_EmitsStaticAccessors()
    {
        var source = """
            package MyLib
            import System

            class EventBus {
                shared {
                    public event OnNotify func()
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var busType = assembly.GetTypes().Single(t => t.Name == "EventBus");
        var ev = busType.GetEvent("OnNotify");

        Assert.NotNull(ev);
        Assert.NotNull(ev!.AddMethod);
        Assert.NotNull(ev!.RemoveMethod);
        Assert.True(ev.AddMethod!.IsStatic);
        Assert.True(ev.RemoveMethod!.IsStatic);
    }

    [Fact]
    public void StaticEvent_AddRemove_WorksAtRuntime()
    {
        var source = """
            package MyLib
            import System

            class Bus {
                shared {
                    public event Ping func()
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var busType = assembly.GetTypes().Single(t => t.Name == "Bus");
        var ev = busType.GetEvent("Ping")!;

        bool invoked = false;
        Action handler = () => invoked = true;
        ev.AddMethod!.Invoke(null, new object[] { handler });

        // Read backing field and invoke
        var backingField = busType.GetField("Ping", BindingFlags.NonPublic | BindingFlags.Static);
        var del = backingField!.GetValue(null) as Delegate;
        Assert.NotNull(del);
        del!.DynamicInvoke();
        Assert.True(invoked);

        // Remove
        invoked = false;
        ev.RemoveMethod!.Invoke(null, new object[] { handler });
        del = backingField.GetValue(null) as Delegate;
        Assert.Null(del);
    }

    [Fact]
    public void StaticEvent_WithRaiseAccessor_Emits()
    {
        var source = """
            package MyLib
            import System

            class Hub {
                shared {
                    public event Alert func() {
                        add { }
                        remove { }
                        raise { }
                    }
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var hubType = assembly.GetTypes().Single(t => t.Name == "Hub");
        var ev = hubType.GetEvent("Alert");

        Assert.NotNull(ev);
        Assert.NotNull(ev!.RaiseMethod);
        Assert.Equal("raise_Alert", ev.RaiseMethod!.Name);
        Assert.True(ev.RaiseMethod.IsStatic);
        Assert.True(ev.RaiseMethod.IsSpecialName);
    }

    [Fact]
    public void Issue503_CapturingLambda_SubscribedToEventHandlerEvent_Works()
    {
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
        var source = """
            package MyLib
            import System

            class Source {
                public event Changed EventHandler
                init() { }
            }
            """;

        var assembly = CompileToAssembly(source);
        var sourceType = assembly.GetTypes().Single(t => t.Name == "Source");
        var instance = Activator.CreateInstance(sourceType)!;
        var ev = sourceType.GetEvent("Changed")!;

        int counter = 0;
        EventHandler handler = (s, e) => counter++;
        ev.AddEventHandler(instance, handler);

        var backingField = sourceType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = backingField!.GetValue(instance) as Delegate;
        Assert.NotNull(del);

        // Simulate the capturing-lambda scenario by Dynamic-Invoking via the
        // EventHandler signature — the IL produced by gsc would otherwise be
        // invalid before the fix lands.
        del!.DynamicInvoke(instance, EventArgs.Empty);
        Assert.Equal(1, counter);

        ev.RemoveEventHandler(instance, handler);
        del = backingField.GetValue(instance) as Delegate;
        Assert.Null(del);
    }

    [Fact]
    public void Issue503_CapturingLambda_SubscribedToEventHandlerEvent_FromGSharpClass()
    {
        // End-to-end: a G# class subscribes a capturing lambda to a CLR
        // EventHandler event declared on another G# class, then raises the
        // event by invoking the backing delegate. The captured counter must
        // observe the side effect of the handler. Before the fix, gsc would
        // emit an Action<object, EventArgs> handler that fails IL
        // verification (silent MSB4181 in build pipelines).
        var source = """
            package MyLib
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
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var sourceType = assembly.GetTypes().Single(t => t.Name == "Source");
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");

        var probe = Activator.CreateInstance(probeType)!;
        var src = probeType.GetField("Src")!.GetValue(probe)!;
        var counter = probeType.GetField("Counter")!.GetValue(probe)!;

        var backingField = sourceType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = backingField!.GetValue(src) as Delegate;
        Assert.NotNull(del);

        del!.DynamicInvoke(src, EventArgs.Empty);
        del!.DynamicInvoke(src, EventArgs.Empty);
        del!.DynamicInvoke(src, EventArgs.Empty);

        var value = (int)counterType.GetField("Value")!.GetValue(counter)!;
        Assert.Equal(3, value);
    }

    [Fact]
    public void Issue503_NonCapturingLambda_SubscribedToEventHandlerEvent_StillWorks()
    {
        // Regression guard for the non-capturing case the issue mentioned as
        // "working today". After fixing the delegate-type override the
        // non-capturing path goes through the same code, so make sure it
        // still produces verifiable IL and a functional subscription.
        var source = """
            package MyLib
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
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var notifierType = assembly.GetTypes().Single(t => t.Name == "Notifier");

        var probe = Activator.CreateInstance(probeType)!;
        var n = probeType.GetField("N")!.GetValue(probe)!;

        var backingField = notifierType.GetField("Fired", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = backingField!.GetValue(n) as Delegate;
        Assert.NotNull(del);
        Assert.IsType<EventHandler>(del);

        del!.DynamicInvoke(n, EventArgs.Empty);
    }

    [Fact]
    public void Issue503_CapturingLambda_CapturesClassInstance_HoldsReference()
    {
        // The closure must hold a reference to the captured class instance,
        // not a value-typed snapshot, so that mutations on the captured
        // instance after subscription are observable when the handler fires.
        var source = """
            package MyLib
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
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var sourceType = assembly.GetTypes().Single(t => t.Name == "Source");
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");

        var probe = Activator.CreateInstance(probeType)!;
        var counter = probeType.GetField("Counter")!.GetValue(probe)!;
        var src = probeType.GetField("Src")!.GetValue(probe)!;

        // Mutate the captured instance after subscription — the closure must
        // see the same object (reference semantics).
        counterType.GetMethod("Bump")!.Invoke(counter, Array.Empty<object>());
        Assert.Equal(1, (int)counterType.GetField("Value")!.GetValue(counter)!);

        var backingField = sourceType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = (Delegate)backingField!.GetValue(src)!;
        del.DynamicInvoke(src, EventArgs.Empty);

        Assert.Equal(2, (int)counterType.GetField("Value")!.GetValue(counter)!);
    }

    [Fact]
    public void Issue503_CapturingLambda_SubscribedToClrEvent_EmitsVerifiable()
    {
        // CLR-event variant of the regression: subscribing a capturing
        // lambda to an imported BCL event (AppDomain.ProcessExit, declared
        // as System.EventHandler). The original Oahu repro was this exact
        // shape — the event lives on an imported class, so the binder takes
        // the BoundClrEventSubscriptionExpression path. The closure rewrite
        // and delegate-target resolution must still produce verifiable IL.
        var source = """
            package MyLib
            import System

            var hits int32 = 0
            var domain = AppDomain.CurrentDomain
            domain.ProcessExit += func(sender object, e EventArgs) {
                hits = hits + 1
            }
            """;

        // Compiling alone covers the IL-verification regression. We do not
        // actually trigger ProcessExit at test time.
        var assembly = CompileToAssembly(source);
        Assert.NotNull(assembly);
    }

    [Fact]
    public void Issue503_ChainedReceiver_CapturingLambda_SubscribesAndFires()
    {
        // Follow-up to Issue #503: subscribing to an event reached through a
        // chained member access (`obj.Inner.Event += ...`). The parser emits
        // right-associative accessor syntax for `O.Inner.Changed`, so the
        // event-subscription binder must normalize the chain before
        // pattern-matching the event member. Before the fix this produced
        // GS0158 "Cannot find member +=" against the inner accessor.
        var source = """
            package MyLib
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
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var innerType = assembly.GetTypes().Single(t => t.Name == "Inner");
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");

        var probe = Activator.CreateInstance(probeType)!;
        var outer = probeType.GetField("O")!.GetValue(probe)!;
        var inner = outer.GetType().GetField("Inner")!.GetValue(outer)!;
        var counter = probeType.GetField("Counter")!.GetValue(probe)!;

        var backingField = innerType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = (Delegate)backingField!.GetValue(inner)!;
        del.DynamicInvoke(inner, EventArgs.Empty);
        del.DynamicInvoke(inner, EventArgs.Empty);

        Assert.Equal(2, (int)counterType.GetField("Value")!.GetValue(counter)!);
    }

    [Fact]
    public void Issue503_ChainedReceiver_NonCapturingLambda_Subscribes()
    {
        // Non-capturing variant of the chained-receiver subscription — must
        // bind through the same normalization path without regressing.
        var source = """
            package MyLib
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
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var innerType = assembly.GetTypes().Single(t => t.Name == "Inner");

        var probe = Activator.CreateInstance(probeType)!;
        var outer = probeType.GetField("O")!.GetValue(probe)!;
        var inner = outer.GetType().GetField("Inner")!.GetValue(outer)!;

        var backingField = innerType.GetField("Fired", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = (Delegate)backingField!.GetValue(inner)!;
        Assert.IsType<EventHandler>(del);
        del.DynamicInvoke(inner, EventArgs.Empty);
    }

    [Fact]
    public void Issue503_ChainedReceiver_Unsubscribe_Removes()
    {
        // The chained-receiver fix must apply symmetrically to `-=`: after
        // unsubscribing, the backing delegate must no longer hold the
        // handler and the captured counter must not advance when the event
        // is raised.
        var source = """
            package MyLib
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
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var innerType = assembly.GetTypes().Single(t => t.Name == "Inner");
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");

        var probe = Activator.CreateInstance(probeType)!;
        var outer = probeType.GetField("O")!.GetValue(probe)!;
        var inner = outer.GetType().GetField("Inner")!.GetValue(outer)!;
        var counter = probeType.GetField("Counter")!.GetValue(probe)!;

        var backingField = innerType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance);

        // Fire once to confirm subscription works.
        var del = (Delegate)backingField!.GetValue(inner)!;
        del.DynamicInvoke(inner, EventArgs.Empty);
        Assert.Equal(1, (int)counterType.GetField("Value")!.GetValue(counter)!);

        // Detach and verify the backing delegate is now null.
        probeType.GetMethod("Detach")!.Invoke(probe, Array.Empty<object>());
        var afterDetach = backingField.GetValue(inner) as Delegate;
        Assert.Null(afterDetach);
    }

    [Fact]
    public void Issue503_MethodGroup_ThisQualified_SubscribesToUserEvent()
    {
        // `src.Changed += this.OnHit`: the right-hand side is an instance
        // method group accessed through `this`. The event-subscription
        // binder must recognize the accessor pattern, capture `this` as the
        // delegate target, and route the group through method-group →
        // delegate conversion against the event's declared type.
        var source = """
            package MyLib
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
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var sourceType = assembly.GetTypes().Single(t => t.Name == "Source");

        var probe = Activator.CreateInstance(probeType)!;
        var src = probeType.GetField("Src")!.GetValue(probe)!;

        var backingField = sourceType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = (Delegate)backingField!.GetValue(src)!;
        Assert.IsType<EventHandler>(del);

        del.DynamicInvoke(src, EventArgs.Empty);
        del.DynamicInvoke(src, EventArgs.Empty);

        Assert.Equal(2, (int)probeType.GetField("Hits")!.GetValue(probe)!);
    }

    [Fact]
    public void Issue503_MethodGroup_BareName_SubscribesToUserEvent()
    {
        // `src.Changed += OnHit` (bare name inside the declaring class)
        // must bind as the implicit-`this` instance method group, mirroring
        // the C# rule. Before the fix, the bare name surfaced as GS0125
        // "Variable doesn't exist" because instance methods aren't visible
        // as variables.
        var source = """
            package MyLib
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
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var sourceType = assembly.GetTypes().Single(t => t.Name == "Source");

        var probe = Activator.CreateInstance(probeType)!;
        var src = probeType.GetField("Src")!.GetValue(probe)!;

        var backingField = sourceType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = (Delegate)backingField!.GetValue(src)!;
        Assert.IsType<EventHandler>(del);

        del.DynamicInvoke(src, EventArgs.Empty);

        Assert.Equal(1, (int)probeType.GetField("Hits")!.GetValue(probe)!);
    }

    [Fact]
    public void Issue503_MethodGroup_UnsubscribeFromUserEvent_Removes()
    {
        // Symmetric `-=` for instance method groups on user events: after
        // detaching, the backing delegate must drop to null and raising the
        // event must not increment the hit counter.
        var source = """
            package MyLib
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
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var sourceType = assembly.GetTypes().Single(t => t.Name == "Source");

        var probe = Activator.CreateInstance(probeType)!;
        var src = probeType.GetField("Src")!.GetValue(probe)!;

        var backingField = sourceType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = (Delegate)backingField!.GetValue(src)!;
        del.DynamicInvoke(src, EventArgs.Empty);
        Assert.Equal(1, (int)probeType.GetField("Hits")!.GetValue(probe)!);

        probeType.GetMethod("Detach")!.Invoke(probe, Array.Empty<object>());
        var afterDetach = backingField.GetValue(src) as Delegate;
        Assert.Null(afterDetach);
    }

    [Fact]
    public void Issue503_MethodGroup_OnClrEvent_EmitsVerifiable()
    {
        // The method-group conversion must work uniformly for CLR-declared
        // events. AppDomain.ProcessExit (System.EventHandler) is a stable
        // BCL event we can subscribe to at runtime without firing it; the
        // compile/IL-verify path covers the regression even when ProcessExit
        // never fires during the test.
        var source = """
            package MyLib
            import System

            class Probe {
                init() {
                    AppDomain.CurrentDomain.ProcessExit += this.OnExit
                }

                func Detach() {
                    AppDomain.CurrentDomain.ProcessExit -= this.OnExit
                }

                func OnExit(sender object, e EventArgs) { }
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var probe = Activator.CreateInstance(probeType)!;
        try
        {
            // Best-effort detach so we don't leave a handler attached to
            // ProcessExit across the test process lifetime.
            probeType.GetMethod("Detach")!.Invoke(probe, Array.Empty<object>());
        }
        catch
        {
            // ignored — the registration alone exercises the verifier
        }
    }

    [Fact]
    public void Adr0112A5_InheritedInstanceEvent_SubscribesThroughDerivedReceiver()
    {
        // ADR-0112 A5: instance event subscription on an explicit receiver now
        // routes through TypeMemberModel.TryGetEvent, which walks the base
        // chain. An instance event declared on an `open class` base must
        // resolve when subscribed through a derived receiver. Before A5 the
        // single-level `userStruct.Events` lookup fell through to an error.
        var source = """
            package MyLib
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
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "A5InhProbe");
        var baseType = assembly.GetTypes().Single(t => t.Name == "A5InhBase");
        var counterType = assembly.GetTypes().Single(t => t.Name == "A5InhCounter");

        var probe = Activator.CreateInstance(probeType)!;
        var derived = probeType.GetField("D")!.GetValue(probe)!;
        var counter = probeType.GetField("Counter")!.GetValue(probe)!;

        // The backing field is declared on the base type.
        var backingField = baseType.GetField("A5InhChanged", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = (Delegate)backingField!.GetValue(derived)!;
        Assert.NotNull(del);

        del.DynamicInvoke(derived, EventArgs.Empty);
        del.DynamicInvoke(derived, EventArgs.Empty);

        Assert.Equal(2, (int)counterType.GetField("Value")!.GetValue(counter)!);
    }

    [Fact]
    public void Adr0112A5_ImmediateInstanceEvent_SubscribesUnchanged()
    {
        // ADR-0112 A5 parity: subscribing to an event declared directly on the
        // receiver's own type must still bind and fire (no behavior change).
        var source = """
            package MyLib
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
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "A5ImmProbe");
        var sourceType = assembly.GetTypes().Single(t => t.Name == "A5ImmSource");
        var counterType = assembly.GetTypes().Single(t => t.Name == "A5ImmCounter");

        var probe = Activator.CreateInstance(probeType)!;
        var src = probeType.GetField("Src")!.GetValue(probe)!;
        var counter = probeType.GetField("Counter")!.GetValue(probe)!;

        var backingField = sourceType.GetField("A5ImmChanged", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = (Delegate)backingField!.GetValue(src)!;
        del.DynamicInvoke(src, EventArgs.Empty);

        Assert.Equal(1, (int)counterType.GetField("Value")!.GetValue(counter)!);
    }

    [Fact]
    public void Adr0112A5_StaticEvent_SubscribesUnchanged()
    {
        // ADR-0112 A5 parity: static event subscription (Issue #263) now routes
        // through TypeMemberModel.TryGetStaticEvent (single-level, first-by-name)
        // and must bind and fire exactly as before.
        var source = """
            package MyLib
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
            }
            """;

        var assembly = CompileToAssembly(source);
        var busType = assembly.GetTypes().Single(t => t.Name == "A5StatBus");
        var counterType = assembly.GetTypes().Single(t => t.Name == "A5StatCounter");

        var probe = Activator.CreateInstance(busType)!;
        var counter = busType.GetField("Counter")!.GetValue(probe)!;

        var backingField = busType.GetField("A5StatPing", BindingFlags.NonPublic | BindingFlags.Static);
        var del = (Delegate)backingField!.GetValue(null)!;
        del.DynamicInvoke(busType, EventArgs.Empty);

        Assert.Equal(1, (int)counterType.GetField("Value")!.GetValue(counter)!);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_event_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        IlVerifier.Verify(outPath);

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
