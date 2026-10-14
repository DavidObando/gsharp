// <copyright file="Issue2517ConstructedBaseOrderingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit

/// Binding regressions for issue #2517's early generic construction ordering.
class Issue2517ConstructedBaseOrderingTests {
    @Fact
    func EarlyReturnSignature_BeforeGenericBaseDefinition_PreservesOverrideAndInheritedMembers() {
        let early = Parse(`package Other
import P
class Early2517 {
    func Get() Middle2517[Entry2517,Entry2517]? -> default(Middle2517[Entry2517,Entry2517]?)
}`)
        let derived = Parse(`package P.Audio
import P
open class Derived2517 : Middle2517[Entry2517,Entry2517] {
    protected open override prop Size int32 -> 100
    func Read() int32 -> Size + Inherited()
}`)
        let entry = Parse("package P\nclass Entry2517 { }")
        let middle = Parse("package P\nopen class Middle2517[TInput,TOutput] : Base2517[TInput] { }")
        let baseType = Parse(`package P
open class Base2517[T] {
    protected open prop Size int32 { get; }
    protected func Inherited() int32 -> 1
}`)
        // Tree-order binder regression (issue #3176 Phase 3b.2): bind the
        // plain multi-tree compilation via EmittedOracle.CompileDiagnostics;
        // the sources declare types only and nothing needs to run.
        let compilation = Compilation(early, derived, entry, middle, baseType)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func MultiLevelGenericBase_WithExplicitBaseConstructor_IsTreeOrderIndependent(reverse bool) {
        let early = Parse(`package Other2517
import Layers2517
class EarlyCtor2517 {
    var Value Layer2517[int32]?
}`)
        let derived = Parse(`package Layers2517
class Final2517 : Layer2517[int32] {
    init() : base(41) { }
    override func Read() int32 -> 42
}`)
        let layers = Parse(`package Layers2517
open class Root2517[T] {
    init(value T) { }
    open func Read() int32 -> 1
}
open class Layer2517[T] : Root2517[T] {
    init(value T) : base(value) { }
}`)
        let trees = if reverse {
            []SyntaxTree{layers, derived, early}
        } else {
            []SyntaxTree{early, derived, layers}
        }
        let compilation = Compilation(trees)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
    }

    shared {
        private func Parse(source string) SyntaxTree -> SyntaxTree.Parse(SourceText.From(source))
    }
}
