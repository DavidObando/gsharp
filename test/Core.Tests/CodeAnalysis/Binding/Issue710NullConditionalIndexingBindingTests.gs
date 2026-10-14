// <copyright file="Issue710NullConditionalIndexingBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #710 / ADR-0073: binder-level coverage for `a?[i]`
/// null-conditional indexing. Validates the new diagnostics
/// (GS0300 non-nullable receiver, GS0301 assignment-LHS rejection),
/// the lifting rule (T → T?, T? → T?), and chain composition with
/// `?.`.
open class Issue710NullConditionalIndexingBindingTests {
    @Fact
    func Accepts_NullableSlice_Receiver() {
        let diagnostics = Bind(`package P
func F() {
    var a []?int32 = nil
    var x = a?[0]
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Accepts_NullableMap_Receiver() {
        let diagnostics = Bind(`package P
import System.Collections.Generic
func F() {
    var d Dictionary[string, int32]? = nil
    var x = d?["k"]
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Result_Is_Nullable_Form_Of_Element_Type() {
        // `a?[0]` where a is `[]?int32` (slice of int32, nullable slice)
        // should give `int32?` for the read result.
        let program = BindProgramFor(`package P
func F() int32? {
    var a []?int32 = nil
    return a?[0]
}`)
        Assert.Empty(program.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func Chained_NullConditional_Member_Then_Index_Binds() {
        // `a?.b?[i]` must compose two null-conditional captures without error
        // when the type chain supports it.
        let diagnostics = Bind(`package P
class Holder {
    var Data []?int32
}
func F() {
    var h Holder? = Holder{Data: []int32{1, 2, 3}}
    var x = h?.Data?[0]
}`)
        Assert.Empty(diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func Reports_GS0300_When_Receiver_Is_NonNullable_Slice() {
        let diagnostics = Bind(`package P
func F() {
    var a []int32 = []int32{1, 2, 3}
    var x = a?[0]
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0300")
    }

    @Fact
    func GS0300_Is_A_Warning_Not_An_Error() {
        let diagnostics = Bind(`package P
func F() {
    var a []int32 = []int32{1, 2, 3}
    var x = a?[0]
}`)
        let diag = diagnostics.Single((d Diagnostic) -> d.Id == "GS0300")
        Assert.Equal(DiagnosticSeverity.Warning, diag.Severity)
    }

    @Fact
    func Reports_GS0301_When_NullConditionalIndex_Is_Assignment_LHS() {
        let diagnostics = Bind(`package P
func F() {
    var a []?int32 = nil
    a?[0] = 1
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0301")
    }

    @Fact
    func Reports_GS0301_When_NullConditionalIndex_Is_CompoundAssignment_LHS() {
        let diagnostics = Bind(`package P
func F() {
    var a []?int32 = nil
    a?[0] += 1
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0301")
    }

    @Fact
    func Reports_Invalid_Target_When_NullConditionalIndex_Is_NullCoalescingAssignment_LHS() {
        // `a?[0] ??= 1` lands in the ??= statement path; the binder rejects
        // the unrecognized lvalue shape with GS0299.
        let diagnostics = Bind(`package P
func F() {
    var a []?int32 = nil
    a?[0] ??= 1
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0299" || d.Id == "GS0301")
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

        private func BindProgramFor(source string) BoundProgram {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            return Binder.BindProgram(globalScope)
        }
    }
}
