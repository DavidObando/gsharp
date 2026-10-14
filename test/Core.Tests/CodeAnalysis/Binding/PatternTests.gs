// <copyright file="PatternTests.cs" company="GSharp">
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

/// Binder coverage for Phase 6.2 switch patterns.
open class PatternTests {
    @Fact
    func TypePattern_BindsVariableOnlyInArmScope() {
        let diagnostics = Bind(`
class User { var Name string }
let u = User{Name: "x"}
let a = switch u { case v is User: v.Name default: "n" }
let b = v.Name
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("v", StringComparison.Ordinal))
    }

    @Fact
    func PropertyPattern_OnNonStruct_Diagnoses() {
        let diagnostics = Bind("let x = switch 1 { case { Name: \"x\" }: 1 default: 0 }")
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("Property pattern requires", StringComparison.Ordinal)
        )
    }

    @Fact
    func PropertyPattern_MissingField_Diagnoses() {
        let diagnostics = Bind(`
class User { var Name string }
let u = User{Name: "x"}
let x = switch u { case { Missing: 1 }: 1 default: 0 }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains(
                "does not define a readable instance field or property named 'Missing'",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func RelationalPattern_UndefinedOperator_Diagnoses() {
        let diagnostics = Bind("let x = switch true { case > false: 1 default: 0 }")
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains(
                "Relational pattern operator '>' is not defined",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func ListPattern_OnNonArray_Diagnoses() {
        let diagnostics = Bind("let x = switch 1 { case [1]: 1 default: 0 }")
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("List pattern requires", StringComparison.Ordinal)
        )
    }

    @Fact
    func DiscardPattern_AcceptsAnyDiscriminantType() {
        let diagnostics = Bind(`
class User { var Name string }
let u = User{Name: "x"}
let x = switch u { case _: 1 }
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SlicePattern_DiscardForms_BindWithoutError() {
        let diagnostics = Bind(`
let xs = []int32{1, 2, 3}
let x = switch xs { case [1, .., 3]: 1 case [..]: 2 default: 0 }
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SlicePattern_PrefixAndSuffixWithNestedPatterns_BindWithoutError() {
        let diagnostics = Bind(`
let xs = []int32{1, 2, 3}
let x = switch xs { case [> 0, .., _]: 1 default: 0 }
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func CapturedSlice_BindsVariableWithSliceElementType() {
        // 'rest' must have type []int32; assigning it to a []int32 local must bind clean.
        let diagnostics = Bind(`
let xs = []int32{1, 2, 3}
switch xs {
    case [_, ..rest, _] {
        let s []int32 = rest
    }
    default { }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func CapturedSlice_UsedAsElementType_Diagnoses() {
        // 'rest' is []int32, not int32, so assigning to an int32 local must fail.
        let diagnostics = Bind(`
let xs = []int32{1, 2, 3}
switch xs {
    case [_, ..rest, _] {
        let s int32 = rest
    }
    default { }
}
`)
        Assert.NotEmpty(diagnostics)
    }

    @Fact
    func SlicePattern_MultipleSlices_Diagnoses() {
        let diagnostics = Bind(`
let xs = []int32{1, 2, 3}
let x = switch xs { case [1, .., .., 3]: 1 default: 0 }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("at most one slice", StringComparison.Ordinal)
        )
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
