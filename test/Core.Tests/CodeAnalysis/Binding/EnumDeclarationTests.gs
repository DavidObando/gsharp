// <copyright file="EnumDeclarationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Emitted-oracle coverage for enum declaration.
open class EnumDeclarationTests {
    @Fact
    func EnumMemberAccess_HasEnumType() {
        let scope_ = BindGlobalScope(`
enum Color { Red, Green, Blue }
let c = Color.Red
`)
        Assert.Empty(scope_.Diagnostics)
        let variable = scope_.Variables.Single((v VariableSymbol) -> v.Name == "c")
        let enumType = Assert.IsType[EnumSymbol](variable.Type)
        Assert.Equal("Color", enumType.Name)
    }

    @Fact
    func DuplicateEnumMember_Diagnoses() {
        let diagnostics = Evaluate(`
enum Color { Red, Red }
0
`).Diagnostics
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("already declares a member", StringComparison.Ordinal)
        )
    }

    @Fact
    func UndefinedEnumMember_Diagnoses() {
        let diagnostics = Evaluate(`
enum Color { Red }
Color.Blue
`).Diagnostics
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("does not define a member", StringComparison.Ordinal)
        )
    }

    @Fact
    func EmptyEnum_Diagnoses() {
        let diagnostics = Evaluate(`
enum Color { }
0
`).Diagnostics
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("must declare at least one member", StringComparison.Ordinal)
        )
    }

    @Fact
    func SwitchStatement_EnumDiscriminant_Binds() {
        let diagnostics = Bind(`
enum Color { Red, Green, Blue }
func F() {
 var color = Color.Green
 switch color {
 case Color.Red { var r = 1 }
 case Color.Green { var g = 2 }
 default { var b = 3 }
 }
}
`)
        Assert.Empty(diagnostics)
    }

    @Theory
    @InlineData("Color.Red", int32(1))
    @InlineData("Color.Green", int32(2))
    @InlineData("Color.Blue", int32(3))
    func SwitchStatement_EnumDiscriminant_Evaluates(color string, expected int32) {
        let result = Evaluate((`
enum Color { Red, Green, Blue }
var value = 0
switch ` + "$color" + ` {
case Color.Red { value = 1 }
case Color.Green { value = 2 }
default { value = 3 }
}
value
`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func SwitchExpression_EnumDiscriminant_BindsAndEvaluatesDefault() {
        let result = Evaluate(`
enum Color { Red, Green, Blue }
let color = Color.Blue
let label = switch color { case Color.Red: "red" case Color.Green: "green" default: "other" }
label
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("other", result.Value)
    }

    @Fact
    func SwitchStatement_EnumCaseValueTypeMismatch_Diagnoses() {
        let diagnostics = Bind(`
enum Color { Red, Green }
func F() {
 var color = Color.Red
 switch color {
 case 0 { var value = 1 }
 }
}
`)
        Assert.NotEmpty(diagnostics)
    }

    @Fact
    func SwitchExpression_EnumCaseValueTypeMismatch_Diagnoses() {
        let diagnostics = Evaluate(`
enum Color { Red, Green }
let color = Color.Red
let label = switch color { case 0: "red" default: "other" }
label
`).Diagnostics
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("Switch case value", StringComparison.Ordinal)
        )
    }

    @Fact
    func EnumEquality_Evaluates() {
        let result = Evaluate(`
enum Color { Red, Green }
let same = Color.Red == Color.Red
let different = Color.Red != Color.Green
same && different
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
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

        private func BindGlobalScope(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            Assert.Empty(tree.Diagnostics)
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
