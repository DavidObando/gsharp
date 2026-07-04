// <copyright file="Issue1931GenericAbstractOverrideTests.cs" company="GSharp">
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
/// Issue #1931: an abstract (Issue #987 style no-body <c>open func</c>) GENERIC
/// method's own type parameter is a distinct <see cref="TypeParameterSymbol"/>
/// instance from the overriding method's own same-named type parameter. Two
/// unrelated code paths compared those signatures without mapping the base
/// method's type parameter onto the override's: <c>SignaturesMatch</c> (used to
/// classify the <c>override</c> declaration itself) and
/// <c>StructSymbol.AbstractMethodSatisfiedBy</c> (used to decide whether a
/// concrete class still has unimplemented abstract members). Both saw the base's
/// <c>T</c> and the override's <c>T</c> as different types, so a `T?`-typed
/// parameter never compared equal — cascading into GS0185 (override signature
/// mismatch), which in turn left the abstract method looking unoverridden
/// (GS0387 on the class, GS0386 at the construction site). A third, unrelated
/// bug in generic-argument inference meant even a correctly-matched generic
/// method with only a `T?` parameter could never infer `T` from a plain
/// (non-nullable) argument, forcing every call site to spell out `[T]` (GS0151).
/// These tests verify all four clear together for the grid G08
/// <c>DefaultConstraint</c> fixture shape (a C# <c>where T : default</c>
/// override, which G# has no `where`-clause spelling for and represents as a
/// plain, unconstrained `[T]`).
/// </summary>
public class Issue1931GenericAbstractOverrideTests
{
    [Fact]
    public void GenericAbstractMethodOverride_WithNullableTypeParameter_BindsClean()
    {
        var source = @"
open class MaybeShower {
    open func Show[T](value T?) string;
}

class PlainShower() : MaybeShower {
    override func Show[T](value T?) string {
        return ""value""
    }
}

let s MaybeShower = PlainShower()
s.Show[string](""x"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("value", result.Value);
    }

    [Fact]
    public void GenericAbstractMethodOverride_InfersTypeArgumentFromNonNullableArgument()
    {
        // Issue #1931: the only parameter is `T?`; a plain `string` argument
        // (not itself `T?`) must still infer `T := string` (GS0151 regression).
        var source = @"
open class MaybeShower {
    open func Show[T](value T?) string;
}

class PlainShower() : MaybeShower {
    override func Show[T](value T?) string {
        return ""value""
    }
}

let s MaybeShower = PlainShower()
s.Show(""x"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("value", result.Value);
    }

    [Fact]
    public void GenericAbstractMethodOverride_ConcreteClassConstructsCleanly()
    {
        // Regression guard for the GS0386/GS0387 cascade: constructing the
        // concrete override must not be rejected as "still abstract".
        var source = @"
open class MaybeShower {
    open func Show[T](value T?) string;
}

class PlainShower() : MaybeShower {
    override func Show[T](value T?) string {
        return ""value""
    }
}

PlainShower()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GenericAbstractMethodOverride_StillCatchesGenuineMismatch()
    {
        // A real signature mismatch (different arity) must still be rejected —
        // the fix maps type parameters onto each other, it does not disable the
        // rest of override validation.
        var source = @"
open class MaybeShower {
    open func Show[T](value T?) string;
}

class BrokenShower() : MaybeShower {
    override func Show[T, U](value T?) string {
        return ""value""
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0185");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
