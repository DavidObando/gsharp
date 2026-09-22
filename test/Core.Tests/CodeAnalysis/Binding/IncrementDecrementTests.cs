// <copyright file="IncrementDecrementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// <c>i++</c> and <c>i--</c> work both as statement forms and, since issue #1027,
/// as value-producing expressions. The parser lowers them to assignments.
/// </summary>
public class IncrementDecrementTests
{
    [Fact]
    public void Increment_OnIntVariable_Binds()
    {
        Assert.Empty(Bind("func F() {\n var x = 1\n x++\n }\n"));
    }

    [Fact]
    public void Decrement_OnIntVariable_Binds()
    {
        Assert.Empty(Bind("func F() {\n var x = 1\n x--\n }\n"));
    }

    [Fact]
    public void Increment_On_ReadOnly_Reports_Error()
    {
        var diagnostics = Bind("func F() {\n let x = 1\n x++\n }\n");
        Assert.Contains(
            diagnostics,
            d => d.Message.Contains("read-only", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Increment_Allowed_As_Expression()
    {
        // Since issue #1027, `let y = x++` parses and binds: x++ yields x's old value.
        Assert.Empty(Bind("func F() {\n var x = 1\n let y = x++\n }\n"));
    }

    [Fact]
    public void FloatingPointMemberIncrement_WidensSyntheticOne_AndVoidizesLambda()
    {
        var result = EmittedOracle.Evaluate("""
            class Counter { var Value float64 }
            func Apply(action () -> void) { action() }
            func Run() float64 {
                var counter = Counter{}
                Apply(() -> counter.Value++)
                counter.Value++
                return counter.Value
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2.0, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void FloatingPointPostfixIncrement_ReturnsExactPreviousBoundaryValue()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() bool {
                var value = 9007199254740992.0
                let previous = value++
                return previous == 9007199254740992.0 &&
                    value == 9007199254740992.0
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void FloatingPointPropertyPostfixIncrement_ReturnsExactPreviousBoundaryValue()
    {
        var result = EmittedOracle.Evaluate("""
            class Counter {
                var backing float64
                prop Value float64 {
                    get { return backing }
                    set { backing = value }
                }
            }
            func Run() bool {
                var counter = Counter{}
                counter.Value = 9007199254740992.0
                let previous = counter.Value++
                return previous == 9007199254740992.0 &&
                    counter.Value == 9007199254740992.0
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void FloatingPointBarePropertyPostfixIncrement_ReturnsExactPreviousBoundaryValue()
    {
        var result = EmittedOracle.Evaluate("""
            class Counter {
                var backing float64
                prop Value float64 {
                    get { return backing }
                    set { backing = value }
                }
                func Run() bool {
                    Value = 9007199254740992.0
                    let previous = Value++
                    return previous == 9007199254740992.0 &&
                        Value == 9007199254740992.0
                }
            }
            var answer = Counter{}.Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void NullableFloatingAndDecimalIncrement_WidensSyntheticOne()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() bool {
                var single float32? = 1.5f
                let oldSingle = single++
                var doubled float64? = 2.5
                let oldDouble = doubled++
                var money decimal? = 3.5m
                let oldMoney = money++
                return oldSingle == 1.5f && single == 2.5f &&
                    oldDouble == 2.5 && doubled == 3.5 &&
                    oldMoney == 3.5m && money == 4.5m
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void MemberPostfixIncrement_EvaluatesReceiverOnce()
    {
        var result = EmittedOracle.Evaluate("""
            class Counter { var Value int32 }
            class Holder {
                var counter Counter
                var calls int32
                func Get() Counter {
                    calls++
                    return counter
                }
                func Run() bool {
                    counter = Counter{ Value: 7 }
                    let previous = Get().Value++
                    return calls == 1 && previous == 7 && counter.Value == 8
                }
            }
            var answer = Holder{}.Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void UserCompoundIncrementOnProperty_EvaluatesGetterOnce()
    {
        var result = EmittedOracle.Evaluate("""
            class Bag {
                var total int32
                prop Total int32 { get { return total } }
                func operator +=(amount int32) { total = total + amount }
            }
            class Holder {
                var first Bag
                var second Bag
                var calls int32
                prop Next Bag {
                    get {
                        calls = calls + 1
                        if calls == 1 { return first }
                        return second
                    }
                }
                func Reset() {
                    first = Bag()
                    second = Bag()
                    calls = 0
                }
                func ScoreBare() int32 {
                    Reset()
                    let previous = Next++
                    return calls * 100 + first.Total * 10 + second.Total
                }
                func ScoreQualified() int32 {
                    Reset()
                    let previous = this.Next++
                    return calls * 100 + first.Total * 10 + second.Total
                }
                func ScorePrefix() int32 {
                    Reset()
                    let updated = ++Next
                    return calls * 100 + first.Total * 10 + second.Total + updated.Total
                }
            }
            var holder = Holder()
            var answer = holder.ScoreBare() == 110 &&
                holder.ScoreQualified() == 110 &&
                holder.ScorePrefix() == 111
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void PostfixStatementUsesUserCompoundOperator()
    {
        var result = EmittedOracle.Evaluate("""
            class Bag {
                var total int32
                prop Total int32 { get { return total } }
                func operator +=(amount int32) { total = total + amount }
            }
            func Run() int32 {
                var bag = Bag()
                bag++
                return bag.Total
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void PrefixExpressionUsesUserCompoundOperatorAndReturnsUpdatedValue()
    {
        var result = EmittedOracle.Evaluate("""
            class Bag {
                var total int32
                prop Total int32 { get { return total } }
                func operator +=(amount int32) { total = total + amount }
            }
            func Run() int32 {
                var bag = Bag()
                let updated = ++bag
                return updated.Total * 10 + bag.Total
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void IndexedIncrementUsesUserCompoundOperator()
    {
        var result = EmittedOracle.Evaluate("""
            struct Meter {
                var Total int32
                func operator +=(amount int32) { Total = Total + amount }
            }
            var values = []Meter{Meter{}}
            let previous = values[0]++
            let updated = ++values[0]
            var answer = previous.Total * 100 + updated.Total * 10 + values[0].Total
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(22, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void NativeSliceIncrementUsesUserCompoundOperator()
    {
        var result = EmittedOracle.Evaluate("""
            struct Meter {
                var Total int32
                func operator +=(amount int32) { Total = Total + amount }
            }
            let values = Gsharp.Values.Slice[Meter].Create(1, 1)
            let previous = values[0]++
            let updated = ++values[0]
            var answer = previous.Total * 100 + updated.Total * 10 + values[0].Total
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(22, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void ValueReturningIndexedIncrementWritesStructBack()
    {
        var result = EmittedOracle.Evaluate("""
            struct Meter {
                var Total int32
                func operator +=(amount int32) { Total = Total + amount }
            }
            class Store {
                var values []Meter
                prop this[index int32] Meter {
                    get { return values[index] }
                    set { values[index] = value }
                }
                func Init() { values = []Meter{Meter{}} }
            }
            var mapped = map[string, Meter]{"x": Meter{}}
            mapped["x"]++
            var store = Store{}
            store.Init()
            store[0]++
            var answer = mapped["x"].Total * 10 + store[0].Total
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void IncrementPrefersDerivedValueMemberOverInheritedEvent()
    {
        var result = EmittedOracle.Evaluate("""
            open class Base {
                event Value () -> void
            }
            class FieldDerived : Base {
                var Value int32
                func Run() int32 {
                    Value++
                    this.Value++
                    return Value
                }
            }
            class PropertyDerived : Base {
                var backing int32
                prop Value int32 {
                    get { return backing }
                    set { backing = value }
                }
                func Run() int32 {
                    Value++
                    this.Value++
                    return Value
                }
            }
            var answer = FieldDerived{}.Run() + PropertyDerived{}.Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void IncrementPrefersDerivedStaticValueMemberOverInheritedStaticEvent()
    {
        var result = EmittedOracle.Evaluate("""
            open class Base {
                shared { event Value () -> void }
            }
            class FieldDerived : Base {
                shared { var Value int32 }
                func Run() int32 {
                    Value++
                    FieldDerived.Value++
                    return Value
                }
            }
            class PropertyDerived : Base {
                shared {
                    var backing int32
                    prop Value int32 {
                        get { return backing }
                        set { backing = value }
                    }
                }
                func Run() int32 {
                    Value++
                    PropertyDerived.Value++
                    return Value
                }
            }
            var answer = FieldDerived{}.Run() + PropertyDerived{}.Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void ParenthesizedPointerPostfixIncrementMutatesPointee()
    {
        var result = EmittedOracle.Evaluate("""
            unsafe func Run() int32 {
                var value = 10
                let pointer = &value
                let previous = (*pointer)++
                return previous * 100 + value
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1011, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void ParenthesizedWritableTargetsRemainIncrementable()
    {
        var result = EmittedOracle.Evaluate("""
            class Counter { var Value int32 }
            func Run() int32 {
                var value = 1
                let previous = (value)++
                var counter = Counter{ Value: 1 }
                (counter.Value)++
                var items = []int32{1}
                (items[0])++
                return previous * 1000 + value * 100 + counter.Value * 10 + items[0]
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1222, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void MemberIncrement_InvalidatesMemberPathNarrowing()
    {
        // The desugared `b.Other++` write must drop member-path smart casts
        // exactly like the equivalent `b.Other = b.Other + 1` form.
        var diagnostics = Bind("""
            open class Animal { var Name string }
            class Dog : Animal { func Bark() string { return "woof" } }
            class Box { var Other int32 = 0 let Pet Animal }
            func Run(b Box) string {
                if b.Pet !is Dog { return "" }
                b.Other++
                return b.Pet.Bark()
            }
            """);

        Assert.Contains(diagnostics, d => d.Message.Contains("Bark", System.StringComparison.Ordinal));
    }

    [Fact]
    public void IndexedUserCompound_ReportsArgumentConversionOnce()
    {
        // Staging a non-addressable element for the in-place operator must not
        // re-bind the operator (and its argument conversion) a second time.
        var diagnostics = Bind("""
            struct Meter {
                var Total int32
                func operator +=(amount int32) { Total = Total + amount }
            }
            func Run(mapped map[string, Meter], amount int64) {
                mapped["x"] += amount
            }
            """);

        Assert.Single(diagnostics);
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
