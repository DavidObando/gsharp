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
    public void PostfixUserCompoundOnProperty_EvaluatesGetterOnce()
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
            }
            var holder = Holder()
            var answer = holder.ScoreBare() == 110 &&
                holder.ScoreQualified() == 110
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
