// <copyright file="Issue1923PatternMatchingSeamsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1923: five narrow pattern-matching gaps found by the grid app G04
/// conformance build-out (each with a passing sibling, so these are seams,
/// not wholesale missing features).
/// <list type="number">
/// <item><description>A boxed-constant equality (<c>answer == 42</c> where
/// <c>answer</c> is <c>object</c>) previously reported GS0129 because
/// <see cref="GSharp.Core.CodeAnalysis.Binding.BoundBinaryOperator"/> only
/// registers the homogeneous <c>object == object</c> arm; there was no
/// boxing-conversion adaptation for a non-<c>object</c> operand, unlike the
/// existing integer-literal / numeric-widening adaptations.</description></item>
/// <item><description>A property pattern (<c>{ City: "x" }</c>) against a
/// nullable CLASS-typed subject (<c>Address?</c>) previously reported GS0172
/// because <c>PatternBinder.BindPropertyPattern</c> required the discriminant
/// itself to be a <see cref="StructSymbol"/>, rejecting the
/// <c>NullableTypeSymbol</c> wrapper outright instead of unwrapping it (a
/// property pattern implicitly requires non-null, exactly like C#'s
/// recursive-pattern rule).</description></item>
/// </list>
/// Sub-bug #3 in the issue ("no flow-narrowing after nil checks" on
/// <c>person.Address.City</c>) turned out to be correct, DOCUMENTED by-design
/// behavior (ADR-0069 "stable member-access paths" addendum): narrowing a
/// member-access path requires every link to be immutable/stable (a
/// <c>let</c> field or a getter-only, non-virtual property); a mutable
/// <c>var</c> field is intentionally excluded because it could change between
/// the nil check and the use. <see cref="FlowNarrowing_MutableVarField_IsNotNarrowed_ByDesign"/>
/// documents that the mutable case correctly still requires a workaround,
/// while <see cref="FlowNarrowing_ImmutableLetField_NarrowsAfterNilCheck"/>
/// proves the same shape narrows once the field is declared <c>let</c>
/// (matching the ADR's stable-path contract) — this is not a regression.
/// </summary>
public class Issue1923PatternMatchingSeamsTests
{
    [Fact]
    public void BoxedConstantEquality_BindsAgainstObjectTypedVariable()
    {
        var source = @"
let answer object = 42
answer == 42
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void BoxedConstantEquality_FalseForMismatchedValue()
    {
        var source = @"
let answer object = 41
answer == 42
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(false, result.Value);
    }

    [Fact]
    public void IsPattern_NonNullableClassSubject_Binds()
    {
        var source = @"
class Foo { var X int32 }
func check(f Foo) bool { return f is Foo }
check(Foo{X: 1})
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void FlowNarrowing_ImmutableLetField_NarrowsAfterNilCheck()
    {
        // ADR-0069 addendum (issue #1180): a `let` (read-only) field is a
        // stable member-access link, so `p.Address != nil` narrows the
        // subsequent `p.Address.City` read — no explicit `!!`/cast needed.
        var source = @"
class Address { var City string }
class Person { let Address Address? }
func getCity(p Person) string {
    if p.Address != nil {
        return p.Address.City
    }
    return ""none""
}
getCity(Person{Address: Address{City: ""here""}})
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("here", result.Value);
    }

    [Fact]
    public void FlowNarrowing_MutableVarField_IsNotNarrowed_ByDesign()
    {
        // By design (ADR-0069 addendum): a mutable `var` field is NOT a
        // stable link (it could be reassigned between the nil check and the
        // use, possibly from another thread), so `p.Address.City` still
        // reports GS0158 even after `p.Address != nil` — this is correct,
        // not the bug in issue #1923. The documented workaround (also used
        // by cs2gs's translation of the equivalent C#) is the non-null
        // assertion `p.Address!!.City`.
        var source = @"
class Address { var City string }
class Person { var Address Address? }
func getCity(p Person) string {
    if p.Address != nil {
        return p.Address.City
    }
    return ""none""
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("City", System.StringComparison.Ordinal));
    }

    [Fact]
    public void PropertyPattern_OnNullableSwitchSubject_Binds()
    {
        var source = @"
class Address { var City string }
func check(a Address?) int32 {
    return switch a {
        case { City: ""x"" }: 1
        default: 0
    }
}
check(Address{City: ""x""})
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void PropertyPattern_OnNullSubject_FailsToMatch_RatherThanThrowing()
    {
        var source = @"
class Address { var City string }
func check(a Address?) int32 {
    return switch a {
        case { City: ""x"" }: 1
        default: 0
    }
}
let none Address? = nil
check(none)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void BoxedSubjectSwitch_OnNullableClassSubject_Binds()
    {
        var source = @"
class Person { var Name string }
func check(p Person?) int32 {
    return switch p {
        case o is object: 1
        default: 0
    }
}
check(Person{Name: ""x""})
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
