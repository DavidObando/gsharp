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
