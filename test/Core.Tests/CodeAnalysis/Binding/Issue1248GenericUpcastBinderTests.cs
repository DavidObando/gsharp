// <copyright file="Issue1248GenericUpcastBinderTests.cs" company="GSharp">
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
/// Issue #1248: an instance of a generic class must be recognized as implicitly
/// convertible to its (constructed) generic base class when the base type argument
/// is one of the derived class's OWN type parameters
/// (<c>TransformBase[TIn, TOut] : FilterBase[TIn]</c>). The implicit reference
/// upcast <c>Derived[...] -&gt; Base[...]</c> must be classified by substituting the
/// derived instance's type arguments along the base chain before comparing against
/// the target, instead of comparing the unsubstituted base reference
/// (<c>FilterBase[TIn]</c>) against the target (<c>FilterBase[int32]</c>) and
/// failing with GS0155. Wrong type arguments and unrelated types must still fail.
/// </summary>
public class Issue1248GenericUpcastBinderTests
{
    [Fact]
    public void TwoLevelGenericUpcast_ParameterPassing_NoDiagnostic()
    {
        var source = @"
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
class C {
    func Take(f FilterBase[int32]) { }
    func G() {
        var x = TransformBase[int32, int32]()
        Take(x)
    }
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0155");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TwoLevelGenericUpcast_LocalInitialization_NoDiagnostic()
    {
        var source = @"
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
class C {
    func G() {
        var f FilterBase[int32] = TransformBase[int32, int32]()
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TwoLevelGenericUpcast_Assignment_NoDiagnostic()
    {
        var source = @"
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
class C {
    func G() {
        var f FilterBase[int32] = FilterBase[int32]()
        f = TransformBase[int32, int32]()
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ConcreteLeafBelowGenericIntermediate_Upcast_NoDiagnostic()
    {
        var source = @"
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
class LosslessFilter : TransformBase[int32, int32] { }
class C {
    func G() {
        var f FilterBase[int32] = LosslessFilter()
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TypeParameterRenaming_ThreeLevelChain_Upcast_NoDiagnostic()
    {
        // Renaming the flowing type parameter at every hop must not matter:
        // Leaf[Z] : Mid[Z], Mid[A] : FilterBase[A].
        var source = @"
open class FilterBase[T]() { }
open class Mid[A] : FilterBase[A] { }
open class Leaf[Z] : Mid[Z] { }
class C {
    func Take(f FilterBase[int32]) { }
    func G() {
        var x = Leaf[int32]()
        Take(x)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void PartialTypeParameterFlow_OnlyOneParameterReachesBase_NoDiagnostic()
    {
        // Only TIn flows to FilterBase; TOut is unused by the base. The upcast
        // must still succeed regardless of the TOut argument.
        var source = @"
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
class C {
    func Take(f FilterBase[int32]) { }
    func G() {
        var x = TransformBase[int32, string]()
        Take(x)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void WrongTypeArgument_StillDiagnosticGS0155()
    {
        // Negative: TransformBase[int64, int64] is NOT a FilterBase[int32].
        var source = @"
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
class C {
    func Take(f FilterBase[int32]) { }
    func G() {
        var x = TransformBase[int64, int64]()
        Take(x)
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0155");
    }

    [Fact]
    public void WrongTypeArgument_FlowingParameter_StillDiagnosticGS0155()
    {
        // Negative: the FLOWING parameter is wrong (string instead of int32),
        // even though the non-flowing TOut happens to be int32.
        var source = @"
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
class C {
    func Take(f FilterBase[int32]) { }
    func G() {
        var x = TransformBase[string, int32]()
        Take(x)
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0155");
    }

    [Fact]
    public void UnrelatedType_StillDiagnosticGS0155()
    {
        // Negative: an unrelated class is not a FilterBase at all.
        var source = @"
open class FilterBase[T]() { }
class Unrelated { }
class C {
    func Take(f FilterBase[int32]) { }
    func G() {
        Take(Unrelated())
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0155");
    }

    [Fact]
    public void DirectOneLevelGenericUpcast_StillWorks_NoDiagnostic()
    {
        // Control / regression: a one-level derived class that directly closes the
        // generic base with a concrete argument already worked and must keep working.
        var source = @"
open class FilterBase[T]() { }
class LosslessFilter : FilterBase[int32] { }
class C {
    func Take(f FilterBase[int32]) { }
    func G() {
        Take(LosslessFilter())
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
