// <copyright file="Issue1636TypeTestNarrowingSubtypeGateTests.cs" company="GSharp">
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
/// Issue #1636 — <c>x is T</c> smart-cast narrowing must only replace the
/// declared type when <c>T</c> is a genuine subtype (or nullable-strip) of
/// the declared type. Supertype/interface/unrelated candidates are a
/// widening or unrelated test and must keep the declared type, matching C#'s
/// treatment of a bare <c>is</c> test.
/// </summary>
public class Issue1636TypeTestNarrowingSubtypeGateTests
{
    [Fact]
    public void If_IsTestOnImplementedInterface_KeepsDeclaredClassMembers()
    {
        // `Circle` implements `IDrawable`. Testing `c is IDrawable` is a
        // WIDENING (interface is a supertype) — `c` must remain usable as
        // `Circle`, so `c.Radius` (a Circle-only member) must still resolve.
        var result = Evaluate(@"
interface IDrawable {
    func Draw() int32;
}
class Circle(Radius int32) : IDrawable {
    func Draw() int32 { return Radius }
}
func Run(c Circle) int32 {
    if c is IDrawable {
        return c.Radius
    }
    return 0
}
Run(Circle{Radius: 3})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsTestOnObject_KeepsStringMembers()
    {
        // `object` is a supertype of `string`; `s is object` must not hide
        // `string.Length`.
        var result = Evaluate(@"
func Run(s string) int32 {
    if s is object {
        return s.Length
    }
    return 0
}
Run(""hello"")
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsTestOnBaseClass_KeepsSubtypeMembers()
    {
        // Testing a `Dog`-typed value against its base class `Animal` is
        // widening — `d.Bark()` (a Dog-only member) must remain usable.
        var result = Evaluate(@"
open class Animal {
    var Name string
}
class Dog : Animal {
    func Bark() string { return ""woof"" }
}
func Run(d Dog) string {
    if d is Animal {
        return d.Bark()
    }
    return """"
}
Run(Dog{Name: ""Rex""})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsTestOnSubclass_StillNarrows()
    {
        // Genuine narrowing must still work: `a is Dog` narrows `a` to
        // `Dog`, so `Bark()` (Dog-only) becomes callable.
        var result = Evaluate(@"
open class Animal {
    var Name string
}
class Dog : Animal {
    func Bark() string { return ""woof"" }
}
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
    public void If_IsTestOnSubclass_DogOnlyMemberUnavailableBeforeTest()
    {
        // Before the narrowing test, `a` is still `Animal` — `Bark()` must
        // NOT resolve outside the then-branch.
        var result = Evaluate(@"
open class Animal {
    var Name string
}
class Dog : Animal {
    func Bark() string { return ""woof"" }
}
func Run(a Animal) string {
    return a.Bark()
}
Run(Dog{Name: ""Rex""})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark"));
    }

    [Fact]
    public void If_IsTestOnNullableUnderlyingType_StillNarrows()
    {
        // Nullable-strip (`string? is string`) remains a genuine narrowing.
        var result = Evaluate(@"
func Run(s string?) int32 {
    if s is string {
        return s.Length
    }
    return 0
}
Run(""hi"")
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsTestOnUnrelatedInterface_KeepsDeclaredClassMembers()
    {
        // `Circle` does not implement `IComparable` — an unrelated type test
        // must also keep the declared type (no narrowing installed at all).
        var result = Evaluate(@"
interface IComparableThing {
    func CompareTo() int32;
}
class Circle(Radius int32) {
    func Draw() int32 { return Radius }
}
func Run(c Circle) int32 {
    if c is IComparableThing {
        return 0
    }
    return c.Radius
}
Run(Circle{Radius: 3})
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
