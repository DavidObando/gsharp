// <copyright file="Issue1123AssignmentSmartCastBinderTests.cs" company="GSharp">
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
/// Issue #1123 — Kotlin-style assignment smart cast. After a nullable local
/// (<c>var x T?</c>) is assigned a statically non-null value, subsequent reads
/// see <c>x</c> at the assigned value's non-null type until the variable is
/// reassigned to a possibly-null value or otherwise invalidated. Binder-level
/// coverage for the narrowing, its reach, the invalidation-on-reassignment
/// behaviour, and the reference-only scope.
/// </summary>
public class Issue1123AssignmentSmartCastBinderTests
{
    private const string Hierarchy = @"
class E { func M() int32 { return 1 } }
open class Animal {
    var Name string
    open func Describe() string { return Name }
}
class Dog : Animal {
    override func Describe() string { return ""Dog"" }
    func Bark() string { return ""woof"" }
}
";

    [Fact]
    public void Assignment_NarrowsNullableLocalToNonNull()
    {
        // The repro: after `x = fresh`, `x` is `E`, so `x.M()` binds.
        var result = Evaluate(Hierarchy + @"
func Run(fresh E) int32 {
    var x E? = nil
    x = fresh
    return x.M()
}
Run(E{})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void WithoutAssignment_NullableMemberAccessStillReported()
    {
        // Control: without the assignment narrowing, `x.M()` on an `E?` fails.
        var result = Evaluate(Hierarchy + @"
func Run() int32 {
    var x E? = nil
    return x.M()
}
");

        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Assignment_NarrowsToAssignedStaticType_DerivedMember()
    {
        // Kotlin narrows to the assigned value's static type. Assigning a `Dog`
        // to an `Animal?` local lets a `Dog`-only member bind.
        var result = Evaluate(Hierarchy + @"
func Run(d Dog) string {
    var a Animal? = nil
    a = d
    return a.Bark()
}
Run(Dog{Name: ""Rex""})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Reassignment_ToNil_InvalidatesNarrowing()
    {
        // `x = fresh` narrows, but `x = nil` drops the narrowing, so the
        // following `x.M()` is rejected again.
        var result = Evaluate(Hierarchy + @"
func Run(fresh E) int32 {
    var x E? = nil
    x = fresh
    x = nil
    return x.M()
}
");

        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Reassignment_ToNullableValue_InvalidatesNarrowing()
    {
        // Reassigning another possibly-null value (an `E?` parameter) also
        // invalidates the narrowing.
        var result = Evaluate(Hierarchy + @"
func Run(fresh E, maybe E?) int32 {
    var x E? = nil
    x = fresh
    x = maybe
    return x.M()
}
");

        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Narrowing_AvailableBeforeReassignment()
    {
        // The narrowing is in effect for statements preceding the invalidating
        // reassignment.
        var result = Evaluate(Hierarchy + @"
func Run(fresh E) int32 {
    var x E? = nil
    x = fresh
    var n int32 = x.M()
    x = nil
    return n
}
Run(E{})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Narrowing_ReachesIntoNestedBlock()
    {
        // The narrowing holds into a subsequent nested block.
        var result = Evaluate(Hierarchy + @"
func Run(fresh E, flag bool) int32 {
    var x E? = nil
    x = fresh
    if flag {
        return x.M()
    }
    return 0
}
Run(E{}, true)
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Narrowing_HoldsAcrossStraightLineStatements()
    {
        var result = Evaluate(Hierarchy + @"
func Run(fresh E) int32 {
    var x E? = nil
    x = fresh
    var a int32 = x.M()
    var b int32 = x.M()
    return a + b
}
Run(E{})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ValueTypeNullable_NotNarrowed_ScopedToReferenceTypes()
    {
        // Issue #1123: value-type nullable narrowing is intentionally scoped
        // out (the narrowed-read emit path does not strip `Nullable<T>`), so
        // `n` stays `int32?` and the arithmetic is rejected.
        var result = Evaluate(@"
func Run() int32 {
    var n int32? = nil
    n = 5
    return n + 1
}
");

        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void AssignedNullable_DoesNotNarrow()
    {
        // Assigning a possibly-null value never narrows.
        var result = Evaluate(Hierarchy + @"
func Run(maybe E?) int32 {
    var x E? = nil
    x = maybe
    return x.M()
}
");

        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void MultiAssignment_NarrowsEachTargetToNonNull()
    {
        // The multi-assignment lowering (`x, y = a, b`) narrows each nullable
        // target assigned a non-null value.
        var result = Evaluate(Hierarchy + @"
func Run(a E, b E) int32 {
    var x E? = nil
    var y E? = nil
    x, y = a, b
    return x.M() + y.M()
}
Run(E{}, E{})
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
