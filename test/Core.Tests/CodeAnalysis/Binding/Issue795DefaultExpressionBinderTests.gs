// <copyright file="Issue795DefaultExpressionBinderTests.cs" company="GSharp">
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
import System.Collections.Generic
import Xunit
import Xunit.Sdk

/// Issue #795: Emitted-oracle coverage for default expression.
/// Traceability: ADR-0100.
open class Issue795DefaultExpressionBinderTests {
    @Fact
    func DefaultOfInt32_IsZero() {
        let (eval, vars) = EvaluateWithVariables(`
var x = default(int32)
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(0, vars["x"])
    }

    @Fact
    func DefaultOfFloat64_IsZero() {
        let (eval, vars) = EvaluateWithVariables(`
var x = default(float64)
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(0d, vars["x"])
    }

    @Fact
    func DefaultOfBool_IsFalse() {
        let (eval, vars) = EvaluateWithVariables(`
var x = default(bool)
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(false, vars["x"])
    }

    @Fact
    func DefaultOfString_IsNil() {
        let (eval, vars) = EvaluateWithVariables(`
var x = default(string)
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Null(vars["x"])
    }

    @Fact
    func DefaultOfNullableInt32_IsNil() {
        let (eval, vars) = EvaluateWithVariables(`
var x = default(int32?)
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Null(vars["x"])
    }

    @Fact
    func DefaultOfNullableString_IsNil() {
        let (eval, vars) = EvaluateWithVariables(`
var x = default(string?)
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Null(vars["x"])
    }

    @Fact
    func DefaultOfUnconstrainedTypeParameter_BindsCleanly() {
        // Issue #795 repro — `func MakeZero[T]() T { return default(T) }`.
        // The binder must accept the shape; the closed-substitution semantics
        // (zero for value types, nil for reference types) are verified by the
        // compiled emit path (CompileAndRun).
        let compilation = CompileSnippet(`
func MakeZero[T]() T {
    return default(T)
}
`)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
    }

    @Fact
    func DefaultOfClassConstrainedTypeParameter_BindsCleanly() {
        let compilation = CompileSnippet(`
func MakeZero[T class]() T {
    return default(T)
}
`)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
    }

    @Fact
    func DefaultOfStructConstrainedTypeParameter_BindsCleanly() {
        let compilation = CompileSnippet(`
func MakeZero[T struct]() T {
    return default(T)
}
`)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
    }

    @Fact
    func BareDefault_InLetInitializerWithExplicitType_Works() {
        let (eval, vars) = EvaluateWithVariables(`
let x int32 = default
let s string = default
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(0, vars["x"])
        Assert.Null(vars["s"])
    }

    @Fact
    func BareDefault_InVarInitializerWithExplicitType_Works() {
        let (eval, vars) = EvaluateWithVariables(`
var x int32 = default
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(0, vars["x"])
    }

    @Fact
    func BareDefault_InReturn_WhenReturnTypeKnown_Works() {
        let (eval, vars) = EvaluateWithVariables(`
func Zero() int32 {
    return default
}
var a = Zero()
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(0, vars["a"])
    }

    @Fact
    func BareDefault_InCallArgument_TakesParameterType() {
        let (eval, vars) = EvaluateWithVariables(`
func Echo(x int32) int32 {
    return x
}
var a = Echo(default)
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(0, vars["a"])
    }

    @Fact
    func BareDefault_InTernaryBranch_TakesSiblingType() {
        let (eval, vars) = EvaluateWithVariables(`
var a = true ? 42 : default
var b = false ? default : 7
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(42, vars["a"])
        Assert.Equal(7, vars["b"])
    }

    @Fact
    func BareDefault_WithNoTargetType_ReportsGS0362() {
        // `var x = default` has no target type — the variable type is
        // being inferred from the initializer, which leaves the bare
        // default unresolved.
        let compilation = CompileSnippet(`
var x = default
`)
        Assert.Contains(compilation.GlobalScope.Diagnostics, (d Diagnostic) -> d.Id == "GS0362")
    }

    @Fact
    func BareDefault_InBothBranchesOfTernary_ReportsGS0362() {
        let compilation = CompileSnippet(`
let x int32 = if true { 1 } else { 2 }
var y = true ? default : default
`)
        Assert.Contains(compilation.GlobalScope.Diagnostics, (d Diagnostic) -> d.Id == "GS0362")
    }

    @Fact
    func DefaultOfInt32_StaticType_IsInt32() {
        let tree = SyntaxTree.Parse(SourceText.From("var x = default(int32)\n"))
        let compilation = Compilation(tree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let variable = FindVariable(compilation, "x")
        Assert.Same(TypeSymbol.Int32, variable.Type)
    }

    @Fact
    func DefaultOfString_StaticType_IsString() {
        let tree = SyntaxTree.Parse(SourceText.From("var x = default(string)\n"))
        let compilation = Compilation(tree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let variable = FindVariable(compilation, "x")
        Assert.Same(TypeSymbol.String, variable.Type)
    }

    @Fact
    func SwitchDefaultArm_StillWorks_RegressionGuard() {
        let (eval, vars) = EvaluateWithVariables(`
import System
var label = switch 99 {
case 1: "one"
default: "other"
}
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal("other", vars["label"])
    }

    shared {
        private func FindVariable(compilation Compilation, name string) VariableSymbol {
            for symbol in compilation.GlobalScope.Variables {
                if symbol.Name == name {
                    return symbol
                }
            }
            throw XunitException("variable '$name' not found")
        }

        private func CompileSnippet(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree)
        }

        private func EvaluateWithVariables(source string)(
            Result EmittedOracleResult,
            Variables IReadOnlyDictionary[string, object?]
        ) {
            // Post-run globals read back through the oracle (issue #3176 Phase
            // 3b.2): the emitted equivalent of the evaluator's variables
            // dictionary.
            let result = EmittedOracle.Evaluate(source)
            return (result, result.ReadGlobals())
        }
    }
}
