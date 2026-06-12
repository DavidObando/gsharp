// <copyright file="Issue712FlowNarrowingExtensionsBinderTests.cs" company="GSharp">
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
/// ADR-0069 addendum / issue #712 — flow narrowing extensions across
/// <c>||</c> short-circuit (the De Morgan dual of <c>&amp;&amp;</c>) and
/// <c>switch</c> arm discriminator narrowing (in-arm and post-switch).
/// Binder-level coverage proving the new narrowings produce the expected
/// diagnostics (or absence-of-diagnostics) and continue to interact
/// cleanly with the existing ADR-0069 plumbing on parameters and
/// <c>let</c>-bound locals.
/// </summary>
public class Issue712FlowNarrowingExtensionsBinderTests
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

    // ──────────────────────────────────────────────────────────────────
    //  ||  short-circuit narrowing
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public void Or_ElseBranch_OfNegatedIsTest_NarrowsParameter()
    {
        // De Morgan: `if !(a is Dog) || cond { ... } else { use(a) }`.
        // Else-branch has `(a is Dog) && !cond`, so `a` is `Dog` there.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal, flag bool) string {
    if !(a is Dog) || flag {
        return """"
    } else {
        return a.Bark()
    }
}
Run(Dog{Name: ""Rex""}, false)
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Or_ElseBranch_OfBangIsTest_NarrowsParameter()
    {
        // `a !is Dog` is the contextual two-token form of `!(a is Dog)`,
        // so the De Morgan dual narrowing in the else branch must apply
        // identically.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal, flag bool) string {
    if a !is Dog || flag {
        return """"
    } else {
        return a.Bark()
    }
}
Run(Dog{Name: ""Rex""}, false)
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Or_RightOperand_OfNegatedIsTest_SeesNarrowedReceiver()
    {
        // Short-circuit: if the left operand `!(a is Dog)` is FALSE we
        // evaluate the right; therefore `a is Dog` holds, and `a.Bark()`
        // must bind cleanly inside the right operand.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) bool {
    return !(a is Dog) || a.Bark() != """"
}
Run(Dog{Name: ""Rex""})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Or_GuardStyle_BangIsTest_WithEarlyExit_LiftsNarrowing()
    {
        // The De Morgan dual of the existing `if a !is T { return }` lift.
        // Here the predicate is `a !is Dog || cond`, both of which must be
        // false to fall through; the else-frame from the if-condition
        // classifier captures `{a → Dog}` and is lifted into the rest of
        // the function body.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal, force bool) string {
    if a !is Dog || force {
        return """"
    }

    return a.Bark()
}
Run(Dog{Name: ""Rex""}, false)
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Or_ThenBranch_OfDisjointTypeTests_DoesNotNarrow()
    {
        // ADR-0069: `if (a is Dog || a is Cat)` cannot narrow `a` in the
        // then-branch — we don't know which side held. `.Bark()` must be
        // rejected.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    if a is Dog || a is Cat {
        return a.Bark()
    }
    return """"
}
Run(Cat{Name: ""C""})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", System.StringComparison.Ordinal));
    }

    [Fact]
    public void Or_ThenBranch_OfRepeatedIsTest_DoesNarrow()
    {
        // When both operands prove the SAME narrowing (`a is Dog` on
        // either side), the intersection of their then-frames is
        // non-empty and survives the `||`.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    if a is Dog || (a is Dog && a.Name != """") {
        return a.Bark()
    }
    return """"
}
Run(Dog{Name: ""Rex""})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Or_NilGuard_ElseBranch_NarrowsToNonNullable()
    {
        // `if (s == nil || cond) { ... } else { use(s) }` — else has
        // `s != nil && !cond`. The recursive nil-guard classifier lifts
        // `s → string` into the else-frame.
        var result = Evaluate(@"
func Run(s string?, flag bool) int32 {
    if s == nil || flag {
        return -1
    } else {
        return s.Length
    }
}
Run(""hi"", false)
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Or_NilGuard_GuardStyle_LiftsNarrowing()
    {
        // `if s == nil || cond { return } use(s)` — the else-frame for
        // the if has `s != nil`, and the early-return lift propagates
        // it into the rest of the block.
        var result = Evaluate(@"
func Run(s string?, force bool) int32 {
    if s == nil || force { return -1 }
    return s.Length
}
Run(""hi"", false)
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Or_IsTest_DoesNotNarrowOnFields()
    {
        // ADR-0069 stability rule: a field receiver is never narrowed,
        // and the `||` extension keeps the same rule.
        var result = Evaluate(AnimalHierarchy + @"
class Box { var Pet Animal }
func Run(b Box) string {
    if !(b.Pet is Dog) || b.Pet.Name == """" {
        return """"
    } else {
        return b.Pet.Bark()
    }
}
Run(Box{Pet: Dog{Name: ""R""}})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", System.StringComparison.Ordinal));
    }

    // ──────────────────────────────────────────────────────────────────
    //  switch arm discriminator narrowing
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public void Switch_TypePattern_NarrowsDiscriminantParameter_InArmBody()
    {
        // Inside `case d is Dog`, the discriminant `a` is narrowed to
        // `Dog`, so `a.Bark()` resolves directly.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    switch a {
        case d is Dog { return a.Bark() }
        case c is Cat { return a.Describe() }
        default { return """" }
    }
    return """"
}
Run(Dog{Name: ""Rex""})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Switch_TypePattern_NestedTypeTest_NarrowsFurther()
    {
        // Inside `case d is Dog`, an inner `if a is Puppy` narrows
        // further to `Puppy`, granting `.Yip()` access.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    switch a {
        case d is Dog {
            if a is Puppy {
                return a.Yip()
            }
            return a.Bark()
        }
        default { return """" }
    }
    return """"
}
Run(Puppy{Name: ""P""})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Switch_MutatingDiscriminantInArm_DropsNarrowingForRemainder()
    {
        // ADR-0069 stability rule: assigning to the narrowed discriminator
        // inside the arm drops its narrowing for the rest of the arm.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    var x = a
    switch x {
        case d is Dog {
            var hello = x.Bark()
            x = Cat{Name: ""C""}
            return x.Bark()
        }
        default { return """" }
    }
}
Run(Dog{Name: ""R""})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", System.StringComparison.Ordinal));
    }

    [Fact]
    public void Switch_AllFallThroughArmsNarrowToSameType_LiftsAfterSwitch()
    {
        // Every fall-through arm narrows `a` to `Dog`; the post-switch
        // dataflow inherits that narrowing.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    var name = """"
    switch a {
        case d is Dog { name = a.Name }
        case c is Cat { return """" }
        default { return """" }
    }
    return a.Bark()
}
Run(Dog{Name: ""R""})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Switch_AllArmsExitOrNarrowToSameType_LiftsAfterSwitch()
    {
        // Mix of exiting arms and a single fall-through arm that
        // narrows: the lifted frame is the fall-through arm's
        // narrowing.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    switch a {
        case c is Cat { return """" }
        case d is Dog { var name = a.Name }
        default { return """" }
    }
    return a.Bark()
}
Run(Dog{Name: ""R""})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Switch_NoDefault_DoesNotLiftAfterSwitch()
    {
        // Without a default arm, an input that matches no case escapes
        // the switch untyped; we must NOT lift any narrowing.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    switch a {
        case d is Dog { var name = a.Name }
    }
    return a.Bark()
}
Run(Dog{Name: ""R""})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", System.StringComparison.Ordinal));
    }

    [Fact]
    public void Switch_DifferentArmNarrowings_DoesNotLiftAfterSwitch()
    {
        // The two fall-through arms narrow `a` to different types
        // (`Dog` and `Cat`). Their intersection is empty, so nothing
        // lifts into the post-switch frame.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    switch a {
        case d is Dog { var n = a.Name }
        case c is Cat { var n = a.Name }
        default { return """" }
    }
    return a.Bark()
}
Run(Dog{Name: ""R""})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", System.StringComparison.Ordinal));
    }

    [Fact]
    public void Switch_FallThroughDefault_DefeatsLift()
    {
        // A fall-through default arm has no narrowing on the
        // discriminator, so the post-switch dataflow merges that
        // wider type and the lift is suppressed.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal) string {
    switch a {
        case d is Dog { var n = a.Name }
        default { var n = a.Name }
    }
    return a.Bark()
}
Run(Dog{Name: ""R""})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", System.StringComparison.Ordinal));
    }

    [Fact]
    public void Switch_NestedInIfElse_StillLifts()
    {
        // The post-switch lift must compose with the existing if/else
        // narrowing infrastructure — the switch sits inside an else
        // arm; its post-switch frame propagates to the rest of the
        // else block.
        var result = Evaluate(AnimalHierarchy + @"
func Run(a Animal, fast bool) string {
    if fast {
        return """"
    } else {
        switch a {
            case d is Dog { var n = a.Name }
            default { return """" }
        }
        return a.Bark()
    }
}
Run(Dog{Name: ""R""}, false)
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Switch_TypePattern_OnLetBoundLocal_NarrowsArmBody()
    {
        // `let`-bound locals (the immutable form) compose with switch
        // pattern narrowing exactly like parameters.
        var result = Evaluate(AnimalHierarchy + @"
let a Animal = Dog{Name: ""R""}
switch a {
    case d is Dog { Console.WriteLine(a.Bark()) }
    default { }
}
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
