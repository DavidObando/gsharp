// <copyright file="Issue700SmartCastBinderTests.cs" company="GSharp">
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
/// ADR-0069 / issue #700 — Kotlin-style smart cast (flow-sensitive type
/// narrowing on <c>is</c>/<c>!is</c>). Binder-level coverage for the
/// narrowing semantics: positive narrowing in the then-branch of an
/// <c>is</c> test, after-early-exit narrowing on <c>!is</c>, threading
/// through <c>&amp;&amp;</c>, and the rules under which the narrowing
/// is dropped (reassignment, fields/properties, mismatched receivers,
/// <c>||</c> branches).
/// </summary>
public class Issue700SmartCastBinderTests
{
    private const string AnimalHierarchy = @"
open class Animal {
    var Name string
    open func Describe() string { return Name }
}
open class Dog : Animal {
    override func Describe() string { return ""Dog"" }
    func Bark() string { return ""woof"" }
}
class Cat : Animal {
    override func Describe() string { return ""Cat"" }
    func Purr() string { return ""purr"" }
}
class Puppy : Dog {
    func Yip() string { return ""yip"" }
}
";

    [Fact]
    public void If_IsTest_NarrowsParameterInThenBranch()
    {
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    if a is Dog {
        return a.Bark()
    }
    return """"
}
Run(Dog{Name: ""Rex""})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_NegatedIsTest_NarrowsParameterAfterEarlyReturn()
    {
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    if a !is Dog {
        return """"
    }
    return a.Bark()
}
Run(Dog{Name: ""Rex""})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_BangIsTest_EquivalentToParenthesizedNegation()
    {
        // `if a !is Dog` and `if !(a is Dog)` must produce the same
        // narrowing: after the early return, `a` is `Dog`.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    if !(a is Dog) {
        return """"
    }
    return a.Bark()
}
Run(Dog{Name: ""Rex""})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsTestAndCondition_NarrowsInsideAndRhs()
    {
        // `if a is Dog && flag` — the right-hand side of `&&` binds with
        // `a` already narrowed to `Dog`. The then-branch sees `a` as
        // `Dog` as well.
        var result = Evaluate(AnimalHierarchy + @"
func IsBarkable(d Dog) bool {
    return d.Name != """"
}
func Run(a Animal, flag bool) string {
    if a is Dog && IsBarkable(a) {
        return a.Bark()
    }
    return """"
}
Run(Dog{Name: ""Rex""}, true)
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsTestOrCondition_DoesNotNarrow()
    {
        // Per ADR-0069: `||` does NOT narrow. In the then-arm we know
        // *one* of the operands held — neither alone forces `a` to be a
        // `Dog`, so `.Bark()` must be rejected.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal, flag bool) string {
    if a is Dog || flag {
        return a.Bark()
    }
    return """"
}
Run(Cat{Name: ""C""}, true)
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", System.StringComparison.Ordinal));
    }

    [Fact]
    public void If_IsTest_NestedIsTestNarrowsFurther()
    {
        // Inside `if a is Dog`, `a` is `Dog`; inside an inner
        // `if a is Puppy`, it is further narrowed to `Puppy`, so
        // `Puppy`-only members resolve.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    if a is Dog {
        if a is Puppy {
            return a.Yip()
        }
        return a.Bark()
    }
    return """"
}
Run(Puppy{Name: ""P""})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsTest_OnGlobalVariable_DoesNotNarrow()
    {
        // ADR-0069: globals are not narrowed (another thread or another
        // top-level statement could mutate them). `.Bark()` must be
        // rejected on the declared `Animal` type.
        var result = Evaluate(AnimalHierarchy + @"
let a Animal = Dog{Name: ""R""}
if a is Dog {
    a.Bark()
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", System.StringComparison.Ordinal));
    }

    [Fact]
    public void If_IsTest_OnInstanceField_DoesNotNarrow()
    {
        // ADR-0069: instance fields/properties are never narrowed —
        // aliasing or another thread could replace the field between
        // the test and the use.
        var result = Evaluate(AnimalHierarchy + @"
class Box {
    var Pet Animal
}
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return """"
}
Run(Box{Pet: Dog{Name: ""R""}})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", System.StringComparison.Ordinal));
    }

    [Fact]
    public void If_IsTest_ReassignmentDropsNarrowing()
    {
        // After `a = something`, the narrowing is dropped: the
        // second use of `.Bark()` must be rejected.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    var x = a
    if x is Dog {
        x = Cat{Name: ""C""}
        return x.Bark()
    }
    return """"
}
Run(Dog{Name: ""R""})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", System.StringComparison.Ordinal));
    }

    [Fact]
    public void If_IsTest_NarrowingDoesNotEscapeThenBranch()
    {
        // Outside the `if a is Dog` block, the narrowing is gone — a
        // bare `.Bark()` on the parameter must be rejected.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    if a is Dog {
    }
    return a.Bark()
}
Run(Dog{Name: ""R""})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", System.StringComparison.Ordinal));
    }

    [Fact]
    public void If_IsTest_ReturnsValueAtNarrowedType()
    {
        // A narrowed read used as a return expression must convert
        // implicitly back to the declared (broader) type: `Dog` is
        // implicitly convertible to `Animal`.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) Animal {
    if a is Dog {
        return a
    }
    return a
}
Run(Dog{Name: ""R""})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsTest_OnNonReferenceVariable_NoNarrowing()
    {
        // Smart-casting an `int32` to itself is a no-op; the binder
        // should not fail and the program should evaluate.
        var result = Evaluate(@"
func Run(n int32) int32 {
    if n is int32 {
        return n + 1
    }
    return n
}
Run(41)
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void If_NestedIsTest_AfterEarlyExit_NarrowsRestOfMethod()
    {
        // `if a !is Dog { return }; if a is Puppy { ... }` — the
        // outer narrowing makes `a` a `Dog`; the inner test further
        // narrows to `Puppy`.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    if a !is Dog {
        return """"
    }
    if a is Puppy {
        return a.Yip()
    }
    return a.Bark()
}
Run(Puppy{Name: ""P""})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsTest_NarrowingComposesWithNilGuard()
    {
        // `if s != nil && s is string` — by the time we reach the
        // `is` test on the right of `&&`, `s` has been narrowed
        // to non-nullable `string` by the nil-guard. The combined
        // narrowing must not break either axis.
        var result = Evaluate(@"
func Run(s string?) int32 {
    if s != nil && s is string {
        return s.Length
    }
    return 0
}
Run(""hi"")
");

        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
