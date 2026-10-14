// <copyright file="SwitchExpressionTests.cs" company="GSharp">
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
import System.Collections.Immutable
import System.Linq
import Xunit

/// Emitted-oracle coverage for switch expression.
open class SwitchExpressionTests {
    @Fact
    func SwitchExpression_IntDiscriminant_StringArms_HasStringType() {
        let scope_ = BindGlobalScope(`
let v = 1
let label = switch v { case 1: "one" default: "many" }
`)
        Assert.Empty(scope_.Diagnostics)
        Assert.Equal(TypeSymbol.String, scope_.Variables.Single((v VariableSymbol) -> v.Name == "label").Type)
    }

    @Fact
    func SwitchExpression_MissingDefault_Diagnoses() {
        let diagnostics = Bind(`
let v = 1
let label = switch v { case 1: "one" }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message == "Switch expression must have a 'default' arm.")
    }

    @Fact
    func SwitchExpression_DuplicateDefault_Diagnoses() {
        let diagnostics = Bind(`
let v = 1
let label = switch v { default: "one" default: "many" }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("default", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Fact
    func SwitchExpression_ArmResultTypeMismatch_Diagnoses() {
        let diagnostics = Bind(`
let v = 1
let label = switch v { case 1: "one" default: 2 }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains(
                "All switch-expression arms must produce the same type",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func SwitchExpression_CommonBaseClass_LetInference_Compiles() {
        // Issue #1112: arms produce A and B which share base class Base; the
        // switch-expression result type should be the best common type Base,
        // so `let box = …` infers Base and returning it as Base succeeds.
        let diagnostics = Bind(ShapeHierarchy + `
func Pick(s string) Base {
    let box = switch s {
        case "a": A()
        case "b": B()
        default: A()
    }
    return box
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SwitchExpression_CommonBaseClass_DirectReturn_Compiles() {
        // Issue #1112: `return switch { … }` unifies the A/B arms to Base
        // (best common type and/or the function-return target type).
        let diagnostics = Bind(ShapeHierarchy + `
func Pick(s string) Base {
    return switch s {
        case "a": A()
        case "b": B()
        default: A()
    }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SwitchExpression_CommonInterface_LetInference_Compiles() {
        // Issue #1112: arms produce Sq and Ci which share interface IShape; the
        // best common type is IShape.
        let diagnostics = Bind(ShapeHierarchy + `
func Pick(s string) IShape {
    let box = switch s {
        case "a": Sq()
        default: Ci()
    }
    return box
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SwitchExpression_NullableSiblingArms_ResultTypeIsNullableCommonInterface() {
        // Issue #2202: both arms are nullable-wrapped siblings (Sq?/Ci?) sharing
        // only the interface IShape; the best common type must unify the
        // unwrapped types to IShape and re-wrap it nullable.
        let scope_ = BindGlobalScope(ShapeHierarchy + `
let sq Sq? = Sq()
let ci Ci? = Ci()
let box = switch "x" {
    case "a": sq
    default: ci
}
`)
        Assert.Empty(scope_.Diagnostics)
        let nullable = Assert.IsType[NullableTypeSymbol](
            scope_.Variables.Single((v VariableSymbol) -> v.Name == "box").Type
        )
        Assert.Equal("IShape", nullable.UnderlyingType.Name)
    }

    @Fact
    func SwitchExpression_TargetTypedLocal_Compiles() {
        // Issue #1112: an explicitly-typed local supplies the target type the
        // switch-expression unifies to.
        let diagnostics = Bind(ShapeHierarchy + `
func Pick(s string) Base {
    let box Base = switch s {
        case "a": A()
        default: B()
    }
    return box
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SwitchExpression_CommonBaseClass_ResultTypeIsBase() {
        // Issue #1112: the inferred local type is the best common type Base.
        let scope_ = BindGlobalScope(ShapeHierarchy + `
let box = switch "x" {
    case "a": A()
    case "b": B()
    default: A()
}
`)
        Assert.Empty(scope_.Diagnostics)
        Assert.Equal("Base", scope_.Variables.Single((v VariableSymbol) -> v.Name == "box").Type.Name)
    }

    @Fact
    func SwitchExpression_CaseValueTypeMismatch_Diagnoses() {
        let diagnostics = Bind(`
let v = 1
let label = switch v { case "one": "one" default: "many" }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("Switch case value", StringComparison.Ordinal)
        )
    }

    @Theory
    @InlineData("1", "one")
    @InlineData("2", "two")
    @InlineData("3", "many")
    func SwitchExpression_IntDiscriminant_Evaluates(input string, expected string) {
        let result = Evaluate((`
let v = ` + "$input" + `
let label = switch v { case 1: "one" case 2: "two" default: "many" }
label
`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func SwitchExpression_StringDiscriminant_Evaluates() {
        let result = Evaluate(`
let v = "b"
let label = switch v { case "a": 1 case "b": 2 default: 3 }
label
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Theory
    @InlineData("true", "yes")
    @InlineData("false", "no")
    func SwitchExpression_BoolDiscriminant_Evaluates(input string, expected string) {
        let result = Evaluate((`
let v = ` + "$input" + `
let label = switch v { case true: "yes" case false: "no" default: "maybe" }
label
`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func SwitchExpression_BoolDiscriminant_DefaultFallthrough_Evaluates() {
        let result = Evaluate(`
let v = false
let label = switch v { case true: "yes" default: "maybe" }
label
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("maybe", result.Value)
    }

    // Issue #991: `when` guards on switch-expression arms.
    @Theory
    @InlineData("5", "small")
    @InlineData("50", "big")
    @InlineData("-1", "nonpositive")
    func SwitchExpression_WhenGuard_Evaluates(input string, expected string) {
        let result = Evaluate((`
let v = ` + "$input" + `
let label = switch v { case > 0 when v < 10: "small" case > 0: "big" default: "nonpositive" }
label
`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func SwitchExpression_GuardedDiscard_DoesNotSatisfyExhaustiveness() {
        // Issue #991: a guarded discard (`case _ when …`) can fail at runtime,
        // so it does not act as a total/default arm — the value switch is
        // still missing a default.
        let diagnostics = Bind(`
let v = 1
let label = switch v { case > 0: "pos" case _ when v < 0: "neg" }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message == "Switch expression must have a 'default' arm.")
    }

    @Fact
    func SwitchExpression_NonBoolGuard_Diagnoses() {
        // Issue #991: a non-bool guard reports the standard conversion error.
        let diagnostics = Bind(`
let v = 1
let label = switch v { case > 0 when v: "x" default: "y" }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert type", StringComparison.Ordinal) && d.Message.Contains(
                "'bool'",
                StringComparison.Ordinal
            )
        )
    }

    // Issue #992: `and` / `or` / `not` pattern combinators on switch-expression arms.
    @Theory
    @InlineData("5", "small-positive")
    @InlineData("-5", "extreme")
    @InlineData("200", "extreme")
    @InlineData("50", "other")
    func SwitchExpression_AndOrPatterns_Evaluate(input string, expected string) {
        let result = Evaluate((`
let v = ` + "$input" + `
let label = switch v { case > 0 and < 10: "small-positive" case < 0 or > 100: "extreme" default: "other" }
label
`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.Value)
    }

    @Theory
    @InlineData("0", "A")
    @InlineData("7", "A")
    @InlineData("3", "C")
    @InlineData("100", "C")
    func SwitchExpression_CombinatorPrecedence_Evaluates(input string, expected string) {
        // `== 0 or > 5 and < 10` == `(== 0) or ((> 5) and (< 10))`.
        let result = Evaluate((`
let v = ` + "$input" + `
let label = switch v { case == 0 or > 5 and < 10: "A" default: "C" }
label
`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.Value)
    }

    @Theory
    @InlineData("-2", "nonpositive")
    @InlineData("0", "nonpositive")
    @InlineData("5", "positive")
    func SwitchExpression_NotPattern_Evaluates(input string, expected string) {
        let result = Evaluate((`
let v = ` + "$input" + `
let label = switch v { case not > 0: "nonpositive" default: "positive" }
label
`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func SwitchExpression_CombinedArm_DoesNotSatisfyExhaustiveness() {
        // Issue #992: a combined (and/or/not) pattern is treated conservatively
        // by the exhaustiveness analyzer — it never acts as a total arm, so a
        // value switch with only combined arms is still missing a default.
        let diagnostics = Bind(`
let v = 1
let label = switch v { case > 0 and < 10: "x" case < 0 or > 100: "y" }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message == "Switch expression must have a 'default' arm.")
    }

    shared {
        // Issue #1112: a class hierarchy used to exercise best-common-type and
        // target-typing across switch-expression arms.
        private const ShapeHierarchy string = `
open class Base {
    open func Name() string { return "base" }
}
class A : Base {
    override func Name() string { return "a" }
}
class B : Base {
    override func Name() string { return "b" }
}
interface IShape {
    func Area() float64;
}
class Sq : IShape {
    func Area() float64 { return 4.0 }
}
class Ci : IShape {
    func Area() float64 { return 3.0 }
}
`

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
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
