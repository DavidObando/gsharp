// <copyright file="Issue1212NullableElementArrayIndexTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1212: the two array nullability spellings.
/// - `[]T?` is a (non-nil) array whose ELEMENTS are nullable. It is indexable as ordinary element
/// access yielding `T?` (read) and accepting `T?` (write).
/// - `[]?T` is a nullable ARRAY reference (the whole array may be nil). Indexing it directly is
/// rejected with GS0116; a null-forgiving `!!` (or the null-conditional `?[`) is required first.
/// - `[]?T?` is a nullable array of nullable elements.
open class Issue1212NullableElementArrayIndexTests {
    @Fact
    func NullableReferenceElementSlice_IsIndexable_ForRead() {
        let diagnostics = Bind("package p\nfunc F(a []object?) object? { return a[0] }")
        Assert.Empty(diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func NullableValueElementSlice_IsIndexable_ForRead() {
        let diagnostics = Bind("package p\nfunc G(a []int32?) int32? { return a[0] }")
        Assert.Empty(diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func NonNullableElementSlice_StillIndexable() {
        let diagnostics = Bind("package p\nfunc H(a []object) object { return a[0] }")
        Assert.Empty(diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func NullableElementSlice_IndexResult_IsNullableElementType() {
        // `a[0]` on `[]int32?` yields `int32?`; assigning it to a non-nullable
        // `int32` return must be rejected, proving the read result is nullable.
        let diagnostics = Bind("package p\nfunc F(a []int32?) int32 { return a[0] }")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func NullableElementSlice_IndexedWrite_AcceptsNullableElement() {
        let diagnostics = Bind(`package p
func W(a []object?, x object?) { a[0] = x }
func V(a []int32?, x int32?) { a[0] = x }`)
        Assert.Empty(diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func NullableElementFixedArray_IsIndexable() {
        let diagnostics = Bind("package p\nfunc F(a [3]int32?) int32? { return a[0] }")
        Assert.Empty(diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func WholeNullableArray_RequiresNullCheck_BeforeIndexing() {
        // `[]?int32` is a nullable array *reference*; indexing it directly is
        // rejected with GS0116 (the array may be nil).
        let diagnostics = Bind("package p\nfunc F(a []?int32) int32 { return a[0] }")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0116")
    }

    @Fact
    func WholeNullableArray_IsIndexable_AfterNullForgiving() {
        let diagnostics = Bind("package p\nfunc F(a []?int32) int32 { return a!![0] }")
        Assert.Empty(diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func NullableArrayOfNullableElements_IndexAfterForgiving_YieldsNullableElement() {
        let diagnostics = Bind("package p\nfunc F(a []?int32?) int32? { return a!![0] }")
        Assert.Empty(diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func NullableArray_DisplayName_BindsQuestionToArray_NotElement() {
        // Issue #1212: the GS0116 message must render the whole-array nullable
        // spelling `[]?int32`, NOT `[]int32?` (which now means nullable elements).
        let diagnostics = Bind("package p\nfunc N(a []?int32) int32 { return a[0] }")
        let gs0116 = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0116")
        Assert.Contains("[]?int32", gs0116.Message)
        Assert.DoesNotContain("[]int32?", gs0116.Message)
    }

    @Fact
    func NullableElementSlice_DisplayName_BindsQuestionToElement() {
        // The element-nullable spelling renders `[]int32?`. Since #3246
        // retired the builtin to-string conversion no conversion exists at
        // all, so the mismatch reports GS0155 (cannot convert) rather than
        // the historical GS0156 (explicit conversion exists) — the subject
        // here is the display-name rendering, not the conversion arm.
        let diagnostics = Bind("package p\nfunc F(a []int32?) string { return a }")
        let gs0155 = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        Assert.Contains("[]int32?", gs0155.Message)
        Assert.DoesNotContain("[]?int32", gs0155.Message)
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any((d Diagnostic) -> d.IsError) {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any((d Diagnostic) -> d.IsError) {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
