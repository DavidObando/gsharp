// <copyright file="Issue1244GenericAbstractOverrideBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #1244: a generic derived class's `override` of an abstract member
/// whose signature uses the class type parameter (`Der[T] : Base[T]` with
/// `override func Handle(x T) int32`) must be recognized as implementing the
/// abstract member, so the derived class — and every concrete leaf below it — is
/// fully concrete. The completeness check substitutes BOTH the base abstract
/// signature (with the constructed base's type arguments) AND the candidate
/// override's signature (with the derived level's construction map) before
/// comparing; otherwise the derived class's own type parameter (a distinct symbol
/// from the base's, even when same-named) fails to unify and the leaf is wrongly
/// treated as still-abstract (GS0387 / GS0386).
open class Issue1244GenericAbstractOverrideBinderTests {
    @Fact
    func GenericDerivedOverridesTypeParamAbstract_LeafIsConcrete_NoDiagnostic() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0387")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0386")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GenericDerivedOverride_RenamedTypeParam_NoDiagnostic() {
        // Param-name renaming is irrelevant: Der[U] : Base[U] with override
        // Handle(x U) must match identically to the same-named-T case.
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ThreeLevelGenericChain_AllConcrete_NoDiagnostic() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GenericDerivedMissingOverride_StillDiagnosticGS0387() {
        // Negative: Der[T] does NOT override the type-parameter-using abstract
        // member, so Leaf must still be reported as not implementing it.
        let source = `
open class Base[T] {
    open func Handle(x T) int32;
}
open class Der[T] : Base[T] {
}
class Leaf : Der[int32] {
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0387")
    }

    @Fact
    func GenericDerivedOverrideWrongType_StillDiagnosticGS0387() {
        // Negative: the override's parameter type does not match the substituted
        // abstract signature, so the abstract remains unimplemented.
        let source = `
open class Base[T] {
    open func Handle(x T) int32;
}
open class Der[T] : Base[T] {
    override func Handle(x int64) int32 { return 0 }
}
class Leaf : Der[int32] {
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0387")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
