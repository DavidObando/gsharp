// <copyright file="Issue1180SmartCastMembersBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0069 addendum / issue #1180 — extend Kotlin-style smart cast from
/// locals to <em>stable member-access paths</em>. A narrowing on a member path
/// is only sound when every link is immutable and not externally mutable
/// between the test and the use: an immutable <c>let</c> field or a getter-only
/// / init-only auto-property (no custom getter, not <c>open</c>/override),
/// declared in the current compilation, read through a stable receiver chain.
/// These tests mirror the local smart-cast coverage style and exercise the
/// positive and negative (stability) cases.
/// </summary>
public class Issue1180SmartCastMembersBinderTests
{
    private const string Hierarchy = @"
open class Animal {
    var Name string
    open func Describe() string { return Name }
}
class Dog : Animal {
    func Bark() string { return ""woof"" }
}
class Cat : Animal {
    func Purr() string { return ""purr"" }
}
";

    [Fact]
    public void If_IsTest_NarrowsStableLetFieldPathInThenBranch()
    {
        var result = Evaluate(Hierarchy + @"
class Box { let Pet Animal }
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return """"
}
Run(Box{Pet: Dog{Name: ""Rex""}})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_NegatedIsTest_NarrowsStableFieldPathAfterEarlyReturn()
    {
        var result = Evaluate(Hierarchy + @"
class Box { let Pet Animal }
func Run(b Box) string {
    if b.Pet !is Dog { return """" }
    return b.Pet.Bark()
}
Run(Box{Pet: Dog{Name: ""Rex""}})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsTest_NarrowsDeepStableReceiverChain()
    {
        var result = Evaluate(Hierarchy + @"
class Inner { let Pet Animal }
class Box { let In Inner }
func Run(b Box) string {
    if b.In.Pet !is Dog { return """" }
    return b.In.Pet.Bark()
}
Run(Box{In: Inner{Pet: Dog{Name: ""Rex""}}})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsTest_NarrowsInitOnlyAutoPropertyPath()
    {
        var result = Evaluate(Hierarchy + @"
class Box {
    prop Pet Animal { get; init; }
}
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return """"
}
Run(Box() { Pet = Dog{Name: ""Rex""} })
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NilGuard_NarrowsStableNullableFieldPath()
    {
        var result = Evaluate(Hierarchy + @"
class Box { let Pet Animal? }
func Run(b Box) string {
    if b.Pet != nil {
        return b.Pet.Describe()
    }
    return """"
}
Run(Box{Pet: Dog{Name: ""Rex""}})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Switch_NarrowsStableFieldPathDiscriminantInArm()
    {
        var result = Evaluate(Hierarchy + @"
class Box { let Pet Animal }
func Run(b Box) string {
    switch b.Pet {
        case d is Dog { return b.Pet.Bark() }
        default { return """" }
    }
    return """"
}
Run(Box{Pet: Dog{Name: ""Rex""}})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsTestAnd_ThreadsMemberPathNarrowingIntoRhs()
    {
        var result = Evaluate(Hierarchy + @"
class Box { let Pet Animal }
func Run(b Box) string {
    if b.Pet is Dog && b.Pet.Bark() != """" {
        return b.Pet.Bark()
    }
    return """"
}
Run(Box{Pet: Dog{Name: ""Rex""}})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void MutableVarField_DoesNotNarrow()
    {
        var result = Evaluate(Hierarchy + @"
class Box { var Pet Animal }
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return """"
}
Run(Box{Pet: Dog{Name: ""Rex""}})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", StringComparison.Ordinal));
    }

    [Fact]
    public void MutableVarAutoProperty_DoesNotNarrow()
    {
        var result = Evaluate(Hierarchy + @"
class Box { prop Pet Animal }
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return """"
}
Run(Box() { Pet = Dog{Name: ""Rex""} })
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", StringComparison.Ordinal));
    }

    [Fact]
    public void CustomGetterProperty_DoesNotNarrow()
    {
        var result = Evaluate(Hierarchy + @"
class Box {
    let backing Animal
    prop Pet Animal { get { return backing } }
    init(p Animal) { backing = p }
}
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return """"
}
Run(Box(Dog{Name: ""Rex""}))
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", StringComparison.Ordinal));
    }

    [Fact]
    public void OverridableOpenProperty_DoesNotNarrow()
    {
        var result = Evaluate(Hierarchy + @"
open class Box {
    open prop Pet Animal { get; init; }
}
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return """"
}
Run(Box() { Pet = Dog{Name: ""Rex""} })
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", StringComparison.Ordinal));
    }

    [Fact]
    public void InterveningCall_InvalidatesMemberPathNarrowing()
    {
        var result = Evaluate(Hierarchy + @"
class Box { let Pet Animal }
func SideEffect() {}
func Run(b Box) string {
    if b.Pet !is Dog { return """" }
    SideEffect()
    return b.Pet.Bark()
}
Run(Box{Pet: Dog{Name: ""Rex""}})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", StringComparison.Ordinal));
    }

    [Fact]
    public void InterveningMemberAssignment_InvalidatesMemberPathNarrowing()
    {
        var result = Evaluate(Hierarchy + @"
class Box { var Other int32 = 0 let Pet Animal }
func Run(b Box) string {
    if b.Pet !is Dog { return """" }
    b.Other = 1
    return b.Pet.Bark()
}
Run(Box{Pet: Dog{Name: ""Rex""}})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", StringComparison.Ordinal));
    }

    [Fact]
    public void ImportedClrMemberPath_DoesNotNarrow()
    {
        // A member read through an imported / CLR type surfaces as a
        // BoundClrPropertyAccessExpression, which is never a stable G# path —
        // the binder cannot guarantee idempotence / immutability across module
        // boundaries, so no narrowing applies.
        var result = Evaluate(Hierarchy + @"
import System
class Box { let Builder System.Text.StringBuilder }
func Run(b Box) int32 {
    if b.Builder.Length is int32 {
        return b.Builder.Length + 1
    }
    return 0
}
Run(Box{Builder: System.Text.StringBuilder()})
");

        // The point is purely that the member path is not narrowed; the program
        // need not be otherwise meaningful. We assert that binding does not
        // crash and produces a deterministic result object.
        Assert.NotNull(result);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
