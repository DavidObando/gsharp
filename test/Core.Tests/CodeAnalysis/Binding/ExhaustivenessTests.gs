// <copyright file="ExhaustivenessTests.cs" company="GSharp">
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

/// Phase 6.3 exhaustiveness diagnostics for enum and sealed-interface switches.
open class ExhaustivenessTests {
    @Fact
    func SwitchExpression_Enum_AllMembersCovered_HasNoDiagnostic() {
        let diagnostics = Bind(`
enum Color { Red, Green, Blue }
let color = Color.Red
let label = switch color { case Color.Red: "red" case Color.Green: "green" case Color.Blue: "blue" }
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SwitchExpression_Enum_MissingMember_DiagnosesMissingName() {
        let diagnostics = Bind(`
enum Color { Red, Green, Blue }
let color = Color.Red
let label = switch color { case Color.Red: "red" case Color.Green: "green" }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message == "Switch expression on enum 'Color' is not exhaustive: missing 'Blue'."
        )
    }

    @Fact
    func SwitchExpression_Enum_DefaultArm_HasNoDiagnostic() {
        let diagnostics = Bind(`
enum Color { Red, Green, Blue }
let color = Color.Red
let label = switch color { case Color.Red: "red" default: "other" }
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SwitchExpression_Enum_DiscardArm_HasNoDiagnostic() {
        let diagnostics = Bind(`
enum Color { Red, Green, Blue }
let color = Color.Red
let label = switch color { case Color.Red: "red" case _: "other" }
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SwitchExpression_SealedInterface_AllImplementorsCovered_HasNoDiagnostic() {
        let diagnostics = Bind(`
sealed interface Expr { }
class Add : Expr { }
class Mul : Expr { }
func Label(expr Expr) string {
 return switch expr { case x is Add: "add" case x is Mul: "mul" }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SwitchExpression_SealedInterface_MissingImplementor_DiagnosesMissingName() {
        let diagnostics = Bind(`
sealed interface Expr { }
class Add : Expr { }
class Mul : Expr { }
func Label(expr Expr) string {
 return switch expr { case x is Add: "add" }
}
`)
        Assert.Contains(
            diagnostics,
            (
                d Diagnostic
            ) -> d.Message == "Switch expression on sealed interface 'Expr' is not exhaustive: missing 'Mul'."
        )
    }

    @Fact
    func SwitchExpression_SealedInterface_DefaultArm_HasNoDiagnostic() {
        let diagnostics = Bind(`
sealed interface Expr { }
class Add : Expr { }
class Mul : Expr { }
func Label(expr Expr) string {
 return switch expr { case x is Add: "add" default: "other" }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SwitchExpression_IntDiscriminant_MissingDefault_UsesExistingDiagnostic() {
        let diagnostics = Bind(`
let value = 1
let label = switch value { case 1: "one" }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message == "Switch expression must have a 'default' arm.")
        Assert.DoesNotContain(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("not exhaustive", StringComparison.Ordinal)
        )
    }

    @Fact
    func SwitchExpression_Enum_OrPattern_AllMembersCovered_HasNoDiagnostic() {
        // Issue #1643: `Red or Green` plus `Blue` covers every member.
        let diagnostics = Bind(`
enum Color { Red, Green, Blue }
let color = Color.Red
let label = switch color { case Color.Red or Color.Green: "warm" case Color.Blue: "cool" }
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SwitchExpression_Enum_NestedOrPattern_SingleArm_HasNoDiagnostic() {
        // Issue #1643: `Red or Green or Blue` in one arm must flatten through
        // arbitrary nesting.
        let diagnostics = Bind(`
enum Color { Red, Green, Blue }
let color = Color.Red
let label = switch color { case Color.Red or Color.Green or Color.Blue: "any" }
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SwitchExpression_Enum_OrPattern_StillMissingMember_DiagnosesMissingName() {
        // Issue #1643: or-pattern flattening must not over-claim coverage — a
        // genuinely non-exhaustive switch still reports the correct miss.
        let diagnostics = Bind(`
enum Color { Red, Green, Blue }
let color = Color.Red
let label = switch color { case Color.Red or Color.Green: "warm" }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message == "Switch expression on enum 'Color' is not exhaustive: missing 'Blue'."
        )
    }

    @Fact
    func SwitchExpression_Enum_AndPattern_DoesNotFalselyCoverConstants() {
        // Issue #1643: an `and` conjunction narrows and must not be flattened
        // into covering its constituent constant.
        let diagnostics = Bind(`
enum Color { Red, Green, Blue }
let color = Color.Red
let label = switch color { case Color.Red and Color.Red: "red" case Color.Green: "green" }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message == "Switch expression on enum 'Color' is not exhaustive: missing 'Red', 'Blue'."
        )
    }

    @Fact
    func SwitchExpression_SealedInterface_OrPattern_AllImplementorsCovered_HasNoDiagnostic() {
        // Issue #1643: type patterns nested in an or-pattern must be flattened
        // for sealed-interface discriminants too.
        let diagnostics = Bind(`
sealed interface Expr { }
class Add : Expr { }
class Mul : Expr { }
class Sub : Expr { }
func Label(expr Expr) string {
 return switch expr { case _ is Add or _ is Mul: "addOrMul" case x is Sub: "sub" }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SwitchExpression_SealedClass_OrPattern_AllSubclassesCovered_HasNoDiagnostic() {
        // Issue #1643: type patterns nested in an or-pattern must be flattened
        // for sealed-class discriminants too.
        let diagnostics = Bind(`
sealed class Shape { }
class Circle : Shape { }
class Square : Shape { }
class Triangle : Shape { }
func Area(s Shape) string {
 return switch s { case _ is Circle or _ is Square: "quad" case t is Triangle: "tri" }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SwitchStatement_Enum_MissingMember_DiagnosesStatementForm() {
        let diagnostics = Bind(`
enum Color { Red, Green, Blue }
var label = ""
switch Color.Red { case Color.Red { label = "red" } case Color.Green { label = "green" } }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message == "Switch statement on enum 'Color' is not exhaustive: missing 'Blue'."
        )
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            let diagnostics = globalScope.Diagnostics.ToBuilder()
            let program = Binder.BindProgram(globalScope)
            diagnostics.AddRange(program.Diagnostics)
            return diagnostics.ToImmutable()
        }
    }
}
