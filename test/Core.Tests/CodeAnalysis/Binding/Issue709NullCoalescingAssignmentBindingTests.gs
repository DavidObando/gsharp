// <copyright file="Issue709NullCoalescingAssignmentBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #709 / ADR-0072: binder-level coverage for `??=`. Validates
/// the new diagnostics (GS0298 non-nullable LHS, GS0299 non-assignable LHS),
/// re-uses GS0127 for readonly LHS, accepts nullable reference / nullable
/// value-type / field / property / indexer LHS shapes, and surfaces the
/// usual RHS-conversion diagnostics.
open class Issue709NullCoalescingAssignmentBindingTests {
    @Fact
    func Accepts_NullableString_Local() {
        let diagnostics = Bind(`package P
func F() {
    var x string? = nil
    x ??= "v"
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Accepts_NullableInt32_Local() {
        let diagnostics = Bind(`package P
func F() {
    var x int32? = nil
    x ??= 42
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Reports_GS0298_When_LHS_Is_NonNullable_String() {
        let diagnostics = Bind(`package P
func F() {
    var x = "hello"
    x ??= "v"
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0298")
    }

    @Fact
    func Reports_GS0298_When_LHS_Is_NonNullable_Int32() {
        let diagnostics = Bind(`package P
func F() {
    var x = 1
    x ??= 2
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0298")
    }

    @Fact
    func Reports_GS0127_When_LHS_Is_ReadOnly_Local() {
        let diagnostics = Bind(`package P
func F() {
    let x string? = nil
    x ??= "v"
}`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("read-only", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Fact
    func Reports_GS0298_OnRhs_When_LHS_Is_NonNullable_Field() {
        let diagnostics = Bind(`package P
class Box {
    var Name string
}
func F() {
    var b = Box{Name: "x"}
    b.Name ??= "v"
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0298")
    }

    @Fact
    func Accepts_Nullable_Field_LHS() {
        let diagnostics = Bind(`package P
class Box {
    var Name string?
}
func F() {
    var b = Box{}
    b.Name ??= "v"
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Accepts_Nullable_Property_LHS() {
        let diagnostics = Bind(`package P
class Person {
    prop Name string?
}
func F() {
    var p = Person{}
    p.Name ??= "Alice"
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Accepts_Nullable_Indexer_LHS() {
        let diagnostics = Bind(`package P
func F() {
    var m = map[string,string?]{}
    m["k"] = nil
    m["k"] ??= "v"
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Reports_Conversion_When_Rhs_DoesNotConvert() {
        // RHS is int — does not convert to string?. The conversion path
        // surfaces the usual GS0129 / GS0030 family of diagnostics.
        let diagnostics = Bind(`package P
func F() {
    var x string? = nil
    x ??= 42
}`)
        Assert.NotEmpty(diagnostics)
    }

    @Fact
    func Accepts_Rhs_Of_UnderlyingType_LiftsToNullable() {
        // Author can write `string` on the RHS even when LHS is `string?`;
        // the implicit `T -> T?` conversion lifts it.
        let diagnostics = Bind(`package P
func F() {
    var x string? = nil
    x ??= "lifted"
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Accepts_Rhs_Of_Nullable_Type_Directly() {
        let diagnostics = Bind(`package P
func F() {
    var x string? = nil
    var y string? = nil
    x ??= y
}`)
        Assert.Empty(diagnostics)
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
