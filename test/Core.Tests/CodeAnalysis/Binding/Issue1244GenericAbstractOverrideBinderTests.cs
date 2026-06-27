// <copyright file="Issue1244GenericAbstractOverrideBinderTests.cs" company="GSharp">
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
/// Issue #1244: a generic derived class's <c>override</c> of an abstract member
/// whose signature uses the class type parameter (<c>Der[T] : Base[T]</c> with
/// <c>override func Handle(x T) int32</c>) must be recognized as implementing the
/// abstract member, so the derived class — and every concrete leaf below it — is
/// fully concrete. The completeness check substitutes BOTH the base abstract
/// signature (with the constructed base's type arguments) AND the candidate
/// override's signature (with the derived level's construction map) before
/// comparing; otherwise the derived class's own type parameter (a distinct symbol
/// from the base's, even when same-named) fails to unify and the leaf is wrongly
/// treated as still-abstract (GS0387 / GS0386).
/// </summary>
public class Issue1244GenericAbstractOverrideBinderTests
{
    [Fact]
    public void GenericDerivedOverridesTypeParamAbstract_LeafIsConcrete_NoDiagnostic()
    {
        var source = @"
open class Base[T] {
    open func Handle(x T) int32;
}
open class Der[T] : Base[T] {
    override func Handle(x T) int32 { return 0 }
}
class Leaf : Der[int32] {
}
class C {
    func Make() Leaf { return Leaf() }
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0387");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0386");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GenericDerivedOverride_RenamedTypeParam_NoDiagnostic()
    {
        // Param-name renaming is irrelevant: Der[U] : Base[U] with override
        // Handle(x U) must match identically to the same-named-T case.
        var source = @"
open class Base[T] {
    open func Handle(x T) int32;
}
open class Der[U] : Base[U] {
    override func Handle(x U) int32 { return 0 }
}
class Leaf : Der[int32] {
}
class C {
    func Make() Leaf { return Leaf() }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ThreeLevelGenericChain_AllConcrete_NoDiagnostic()
    {
        var source = @"
import System.Threading.Tasks
open class FilterBase[T] {
    protected open func Handle(x T) Task;
}
open class TransformBase[TIn, TOut] : FilterBase[TIn] {
    protected override async func Handle(x TIn) { }
    protected open func Perform(x TIn) TOut;
}
open class AacFilter : TransformBase[int32, int32] {
    protected override func Perform(x int32) int32 { return x }
}
class C {
    func Make() AacFilter { return AacFilter() }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GenericDerivedMissingOverride_StillDiagnosticGS0387()
    {
        // Negative: Der[T] does NOT override the type-parameter-using abstract
        // member, so Leaf must still be reported as not implementing it.
        var source = @"
open class Base[T] {
    open func Handle(x T) int32;
}
open class Der[T] : Base[T] {
}
class Leaf : Der[int32] {
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0387");
    }

    [Fact]
    public void GenericDerivedOverrideWrongType_StillDiagnosticGS0387()
    {
        // Negative: the override's parameter type does not match the substituted
        // abstract signature, so the abstract remains unimplemented.
        var source = @"
open class Base[T] {
    open func Handle(x T) int32;
}
open class Der[T] : Base[T] {
    override func Handle(x int64) int32 { return 0 }
}
class Leaf : Der[int32] {
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0387");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
