// <copyright file="BaseMemberCompoundAssignmentBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0192 follow-on 2: compound assignment and increment/decrement of a
/// base-qualified member (<c>base.runtextpos++</c>, <c>base.P += 1</c>).
/// <para>
/// The parser desugars every compound form of a member target to one
/// compound-assignment node, and that node's binder bound the receiver as an
/// ordinary expression. <c>base</c> is a contextual keyword with no value, so
/// every form reported GS0125 "Variable 'base' doesn't exist", while the plain
/// read <c>base.M</c> and write <c>base.M = v</c> bound. The real
/// <c>[GeneratedRegex]</c> output increments <c>base.runtextpos</c>, a
/// protected field of the imported <c>RegexRunner</c>.
/// </para>
/// </summary>
public class BaseMemberCompoundAssignmentBinderTests
{
    [Fact]
    public void ImportedBaseField_EveryCompoundForm_BindsAndRuns()
    {
        const string source = """
            import System
            import System.Text.RegularExpressions

            class Runner : RegexRunner {
                func Step() string {
                    base.runtextpos = 5
                    base.runtextpos++
                    ++base.runtextpos
                    base.runtextpos += 10
                    base.runtextpos--
                    --base.runtextpos
                    base.runtextpos -= 2
                    base.runtextpos *= 3
                    let old = base.runtextpos++
                    let now = ++base.runtextpos
                    let dec = base.runtextpos--
                    return "$old $now $dec ${base.runtextpos}"
                }
            }

            Console.WriteLine(Runner().Step())
            """;

        AssertRuns(source, "39 41 41 40");
    }

    [Fact]
    public void SameCompilationBaseFieldAndProperty_EveryCompoundForm_BindsAndRuns()
    {
        const string source = """
            import System

            open class Base {
                protected var f int32
                protected prop P int32 { get; set; }
            }

            class Derived : Base {
                func Go() string {
                    base.f++
                    ++base.f
                    base.f += 3
                    base.f--
                    base.f <<= 1
                    base.P++
                    base.P += 10
                    --base.P
                    base.P %= 7
                    let a = base.P++
                    let b = --base.f
                    return "${base.f} ${base.P} $a $b"
                }
            }

            Console.WriteLine(Derived().Go())
            """;

        AssertRuns(source, "7 4 3 7");
    }

    [Fact]
    public void OverriddenProperty_BaseCompound_UsesBaseAccessorsNonVirtually()
    {
        // The derived override multiplies by 100 on read and ignores writes.
        // A virtual dispatch of either accessor would show up in the result.
        const string source = """
            import System

            open class Base {
                var store int32 = 1
                open prop P int32 {
                    get -> store
                    set { store = value }
                }
            }

            class Derived : Base {
                override prop P int32 {
                    get -> base.P * 100
                    set { }
                }

                func Go() string {
                    base.P++
                    base.P += 5
                    let old = base.P--
                    return "$old ${base.P} $P"
                }
            }

            Console.WriteLine(Derived().Go())
            """;

        AssertRuns(source, "7 6 600");
    }

    [Fact]
    public void ImportedBaseProperty_CompoundAssignment_BindsAndRuns()
    {
        const string source = """
            import System
            import System.IO

            class Mem : MemoryStream {
                func Go() int64 {
                    base.SetLength(100)
                    base.Position = 3
                    base.Position += 4
                    base.Position++
                    return base.Position
                }
            }

            Console.WriteLine(Mem().Go())
            """;

        AssertRuns(source, "8");
    }

    [Fact]
    public void ValueNamedBase_CompoundAssignment_KeepsOrdinaryMeaning()
    {
        const string source = """
            import System

            class Box {
                var n int32
            }

            var base = Box()
            base.n += 4
            base.n++
            Console.WriteLine(base.n)
            """;

        AssertRuns(source, "5");
    }

    [Fact]
    public void BaseCompound_OutsideClassInstanceMember_ReportsGS0383()
    {
        const string source = """
            class Plain {
                shared {
                    var x int32
                    func Go() {
                        base.x++
                    }
                }
            }
            """;

        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0383");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0125");
    }

    [Fact]
    public void BaseCompound_ReadOnlyBaseField_IsRejected()
    {
        const string source = """
            open class Base {
                protected let f int32 = 1
            }

            class Derived : Base {
                func Go() {
                    base.f++
                }
            }
            """;

        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.IsError);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0125");
    }

    [Fact]
    public void BaseEventSubscription_NonVirtualEvent_BindsAndRuns()
    {
        // `base.E += h` / `base.E -= h` on a non-virtual event calls the
        // base's own add/remove accessors, as in C#, directly and from a
        // function literal. Component.Disposed is an imported event.
        const string source = """
            import System
            import System.ComponentModel

            open class Base {
                event Changed EventHandler?
                func Fire() {
                    Changed?.Invoke(this, EventArgs.Empty)
                }
            }

            class Derived : Base {
                func Go() {
                    let h EventHandler = func (s object?, e EventArgs) { Console.WriteLine("handler") }
                    let subscribe = func () { base.Changed += h }
                    subscribe()
                    this.Fire()
                    base.Changed -= h
                    this.Fire()
                }
            }

            class Part : Component {
                func Go() {
                    base.Disposed += func (s object?, e EventArgs) { Console.WriteLine("disposed") }
                    this.Dispose()
                }
            }

            Derived().Go()
            Part().Go()
            """;

        AssertRuns(source, "handler" + Environment.NewLine + "disposed");
    }

    [Fact]
    public void NullCoalescingAssignment_OnBaseProperty_UsesBaseAccessors()
    {
        // `base.P ??= v` reads and writes through the base accessors, like
        // `base.f ??= v` on a field already did. The overrides return "d" and
        // ignore writes, so a virtual call on either side would show.
        const string source = """
            import System

            open class Base {
                var store string?
                open prop Q string? {
                    get -> store
                    set { store = value }
                }
                open prop Auto string? { get; set; }
            }

            class Derived : Base {
                override prop Q string? {
                    get -> "d"
                    set { }
                }
                override prop Auto string? {
                    get -> "d"
                    set { }
                }

                func Go() string {
                    base.Q ??= "q1"
                    base.Q ??= "q2"
                    let f = func () { base.Auto ??= "a1" }
                    f()
                    base.Auto ??= "a2"
                    return "${base.Q} ${base.Auto}"
                }
            }

            class Err : Exception {
                func Go() string? {
                    base.HelpLink ??= "h1"
                    base.HelpLink ??= "h2"
                    return base.HelpLink
                }
            }

            Console.WriteLine(Derived().Go())
            Console.WriteLine(Err().Go())
            """;

        AssertRuns(source, "q1 a1" + Environment.NewLine + "h1");
    }

    [Fact]
    public void BaseEventSubscription_ShadowedByDerivedEvent_SubscribesToBaseEvent()
    {
        // The derived class declares its own event of the same name. The
        // subscription must reach the BASE event, not the derived one.
        const string source = """
            import System
            import System.ComponentModel

            open class Base {
                event Changed EventHandler?
                func FireBase() { Changed?.Invoke(this, EventArgs.Empty) }
            }

            class Derived : Base {
                event Changed EventHandler?
                func FireDerived() { Changed?.Invoke(this, EventArgs.Empty) }

                func Go() {
                    let h EventHandler = func (s object?, e EventArgs) { Console.WriteLine("base handler") }
                    base.Changed += h
                    this.FireDerived()
                    this.FireBase()
                    let unsubscribe = func () { base.Changed -= h }
                    unsubscribe()
                    this.FireBase()
                    let subscribe = func () { base.Changed += h }
                    subscribe()
                    this.FireBase()
                }
            }

            class Comp : Component {
                event Disposed EventHandler?
                func Go() {
                    base.Disposed += func (s object?, e EventArgs) { Console.WriteLine("component disposed") }
                    this.Dispose()
                }
            }

            Derived().Go()
            Comp().Go()
            """;

        AssertRuns(source, "base handler" + Environment.NewLine + "base handler" + Environment.NewLine + "component disposed");
    }

    [Fact]
    public void ClassNamedBase_MemberAccess_KeepsTypeMeaning()
    {
        // `base` is contextual: a type named `base` keeps its ordinary
        // meaning, so `base.count` is that type's static field.
        const string source = """
            import System

            class base {
                shared { var count int32 = 4 }
            }

            Console.WriteLine(base.count.ToString())
            base.count = 5
            Console.WriteLine(base.count.ToString())
            """;

        AssertRuns(source, "4" + Environment.NewLine + "5");
    }

    [Fact]
    public void UserCompoundOperator_OnBaseMembers_RunsInPlace()
    {
        // Issue #2834 on base-qualified targets: the member type's own `+=`
        // runs (GS0129 before), including over a declared binary `+`, and a
        // property is read once with a value-type result written back.
        const string source = """
            import System

            class Bag {
                var total int32
                prop Total int32 { get { return total } }
                func operator +=(amount int32) {
                    Console.WriteLine("Bag.+= $amount")
                    total = total + amount
                }
            }

            struct Meter {
                var Total int32
                func operator +=(amount int32) {
                    Console.WriteLine("Meter.+= $amount")
                    Total = Total + amount
                }
            }

            struct Both {
                var Total int32
                func operator +=(amount int32) {
                    Console.WriteLine("Both.+= $amount")
                    Total = Total + amount
                }
            }

            func (a Both) operator +(amount int32) Both {
                Console.WriteLine("Both.+ $amount")
                return Both{Total: a.Total + amount}
            }

            open class Base {
                protected var bag Bag = Bag()
                protected var meter Meter
                protected var both Both
                var backing Meter
                var reads int32
                prop Value Meter {
                    get {
                        reads = reads + 1
                        return backing
                    }
                    set { backing = value }
                }
                prop Reads int32 { get { return reads } }
            }

            class Derived : Base {
                func Go() string {
                    base.bag += 2
                    base.meter += 3
                    base.both += 4
                    base.Value += 5
                    base.Value++
                    let f = func () { base.meter++ }
                    f()
                    let old = base.meter++
                    let updated = ++base.meter
                    Console.WriteLine("old ${old.Total} updated ${updated.Total}")
                    return "${base.bag.Total} ${base.meter.Total} ${base.both.Total} ${base.Value.Total} ${base.Reads}"
                }
            }

            Console.WriteLine(Derived().Go())
            """;

        AssertRuns(
            source,
            string.Join(
                Environment.NewLine,
                "Bag.+= 2", "Meter.+= 3", "Both.+= 4", "Meter.+= 5", "Meter.+= 1", "Meter.+= 1", "Meter.+= 1", "Meter.+= 1",
                "old 4 updated 6", "2 6 4 6 3"));
    }

    [Theory]
    [InlineData("base.bag += 1")]
    [InlineData("base.bag++")]
    [InlineData("--base.bag")]
    [InlineData("base.meter += 1")]
    [InlineData("base.n += 1")]
    [InlineData("base.n++")]
    public void ReadOnlyBaseField_CompoundIsRejected(string statement)
    {
        // A `let` base field is not a compound target, whether the member's
        // type mutates in place (`Bag`, a class with `operator +=`), is a
        // struct with one, or has only a binary `+`. `base.f` names a base
        // class's field, so even a derived constructor may not write it.
        var source = $$"""
            class Bag {
                var total int32
                func operator +=(amount int32) { total = total + amount }
                func operator -=(amount int32) { total = total - amount }
            }

            struct Meter {
                var Total int32
                func operator +=(amount int32) { Total = Total + amount }
            }

            open class Base {
                protected let bag Bag = Bag()
                protected let meter Meter
                protected let n int32 = 1
            }

            class Derived : Base {
                init() {
                    {{statement}}
                }

                func Go() {
                    {{statement}}
                }
            }
            """;

        var errors = EmittedOracle.Evaluate(source).Diagnostics.Where(d => d.IsError).ToArray();
        Assert.Equal(2, errors.Length);
        Assert.All(errors, error => Assert.Equal("GS0127", error.Id));
    }

    [Fact]
    public void BaseEventSubscription_VirtualEvent_KeepsPreviousDiagnostic()
    {
        // A virtual event would need its base accessors called non-virtually;
        // that is not supported, so the shape is not intercepted and reports
        // what it reported before.
        const string source = """
            import System

            open class Base {
                open event Changed EventHandler?
            }

            class Derived : Base {
                func Go() {
                    base.Changed += func (s object?, e EventArgs) { }
                }
            }
            """;

        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0125");
    }

    private static void AssertRuns(string source, string expected)
    {
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(expected + Environment.NewLine, result.Output);
    }
}
