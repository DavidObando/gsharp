// <copyright file="Issue2519SourceClassConstraintOrderingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Linq
import Xunit

/// Binding regressions for issue #2519's source class-constraint
/// ordering. Tree-order binder regressions (issue #3176 Phase 3b.2): these
/// bind the plain multi-tree compilation via
/// `EmittedOracle.CompileDiagnostics` — the property under test is the
/// PLAIN compilation's order independence, and the sources declare types
/// only, so nothing needs to run.
class Issue2519SourceClassConstraintOrderingTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func CrossPackageSourceClassConstraint_ExposesCompleteMemberSurfaceInEitherTreeOrder(reverse bool) {
        let constrained = Parse(`package P.Audio
import P
import System
class Holder2519[T Entry2519] {
    func Read(value T) int32 ->
        value.Count + value.SamplesInFrame + value.Inherited() + value.VirtualValue()
    func Upcast(value T) Entry2519 -> value
    func Subscribe(value T, handler Action) {
        value.Changed += handler
    }
}`)
        let constraint = Parse(`package P
import System
open class Root2519 {
    public var SamplesInFrame int32
    public func Inherited() int32 -> 3
    public event Changed Action
}
open class Entry2519 : Root2519 {
    public prop Count int32 -> 2
    public open func VirtualValue() int32 -> 4
}`)
        let trees = if reverse {
            []SyntaxTree{constraint, constrained}
        } else {
            []SyntaxTree{constrained, constraint}
        }
        let compilation = Compilation(trees)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ExactDecryptConstraintShape_BindsBeforeOrAfterConstraintAndGenericBase(reverse bool) {
        let multipart = Parse(`package Oahu.Decrypt.FrameFilters.Audio
import Oahu.Decrypt
import Oahu.Decrypt.FrameFilters
import System.Threading.Tasks

open class MultipartFilterBase2519[
    TInput FrameEntry2519,
    TCallback Oahu.Decrypt.INewSplitCallback2519[TCallback]
] : FrameFinalBase2519[TInput] {
    protected open override func PerformFilteringAsync(input TInput) Task {
        if input.Chunk == nil {
            input.Notify += () -> { }
        }
        input.SamplesInFrame += 1
        return Task.CompletedTask
    }
}`)
        let dependencies = Parse(`package Oahu.Decrypt
import System
interface INewSplitCallback2519[T INewSplitCallback2519[T]] { }
open class FrameEntryBase2519 {
    public var Chunk object?
    public var SamplesInFrame int32
    public event Notify Action
}
open class FrameEntry2519 : FrameEntryBase2519 { }`)
        let genericBase = Parse(`package Oahu.Decrypt.FrameFilters
import System.Threading.Tasks
open class FrameFinalBase2519[T] {
    protected open func PerformFilteringAsync(input T) Task -> Task.CompletedTask
}`)
        let trees = if reverse {
            []SyntaxTree{genericBase, dependencies, multipart}
        } else {
            []SyntaxTree{multipart, dependencies, genericBase}
        }
        let compilation = Compilation(trees)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        Assert.DoesNotContain(
            EmittedOracle.CompileDiagnostics(compilation),
            (diagnostic Diagnostic) -> diagnostic.Message.Contains("FrameEntry2519") || diagnostic.Message.Contains(
                "Chunk"
            ) ||
                diagnostic
                .Message
                .Contains("SamplesInFrame")
        )
    }

    @Fact
    func SameFileConstraintDeclaredLater_ResolvesToPublishedShell() {
        let tree = Parse(`package P
class Holder2519[T Entry2519] {
    func Read(value T) int32 -> value.Count
}
class Entry2519 {
    public prop Count int32 -> 42
}`)
        let compilation = Compilation(tree)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        let holder = Assert.Single(compilation.GlobalScope.Structs.Where((s StructSymbol) -> s.Name == "Holder2519"))
        let constraint = Assert.IsType[StructSymbol](Assert.Single(holder.TypeParameters).ClassConstraint)
        Assert.Equal("Entry2519", constraint.Name)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructedClassConstraint_OnClassAndInterface_UsesLateGenericMemberProjections(reverse bool) {
        let consumers = Parse(`package P.Use
import P.Model
class Holder2519[T GenericEntry2519[int32]] {
    func Read(value T) int32 -> value.Value + value.BaseValue
}
interface Reader2519[T GenericEntry2519[int32]] {
    func Read(value T) int32;
}`)
        let model = Parse(`package P.Model
open class GenericBase2519[U] {
    public prop BaseValue U -> default(U)
}
class GenericEntry2519[U] : GenericBase2519[U] {
    public prop Value U -> default(U)
}`)
        let trees = if reverse {
            []SyntaxTree{model, consumers}
        } else {
            []SyntaxTree{consumers, model}
        }
        let compilation = Compilation(trees)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
    }

    shared {
        private func Parse(source string) SyntaxTree -> SyntaxTree.Parse(SourceText.From(source))
    }
}
