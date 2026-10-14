// <copyright file="Issue716LambdaBindingInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #716 / ADR-0076 — type inference for lambda bindings.
/// Bottom-up: `var square = (n int32) -> n * n` binds `square`
/// to the function-type `(int32) -> int32`. Top-down (existing
/// path, extended): when the binding has an explicit function-type, lambda
/// parameters may omit types and be filled from the target. When both
/// sides are open, diagnostic GS0304 fires.
open class Issue716LambdaBindingInferenceTests {
    @Fact
    func VarBinding_SingleTypedParam_InfersFunctionType() {
        let result = Evaluate(`
var square = (n int32) -> n * n
square(5)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(25, result.Value)
    }

    @Fact
    func LetBinding_StringIdentity_InfersFunctionType() {
        let result = Evaluate(`
let id = (s string) -> s
id("hello")
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hello", result.Value)
    }

    @Fact
    func LetBinding_BlockBodyWithExplicitReturn_InfersFunctionType() {
        let result = Evaluate(`
let f = (n int32) -> { return n + 1 }
f(41)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func LetBinding_MultiParam_InfersFunctionType() {
        let result = Evaluate(`
let add = (a int32, b int32) -> a + b
add(20, 22)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func LetBinding_ZeroParam_InfersFunctionType() {
        let result = Evaluate(`
let always42 = () -> 42
always42()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func LetBinding_VoidBodyExpression_InfersVoidReturn() {
        // The trailing expression is a void-returning method call —
        // the inferred binding type is (string) -> void.
        let result = Evaluate(`
let log = (msg string) -> Console.WriteLine(msg)
log("hi")
1
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func TargetTypedBinding_AllowsUntypedLambdaParameters() {
        // Explicit target type pins the lambda's parameter type.
        let result = Evaluate(`
let inc (int32) -> int32 = (x) -> x + 1
inc(41)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func TargetTypedBinding_AllowsUntypedLambdaParameters_MultiParam() {
        let result = Evaluate(`
let add (int32, int32) -> int32 = (a, b) -> a + b
add(20, 22)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NoExplicitTypeAndUntypedLambdaParam_ReportsGS0304() {
        let diags = GetDiagnostics(`
let f = (x) -> x + 1
`)
        let gs0304 = diags.Where((d Diagnostic) -> d.Id == "GS0304").ToList()
        Assert.Single(gs0304)
        Assert.Contains("'x'", gs0304[0].Message)
    }

    @Fact
    func InvokeInferredBinding_ReturnsExpected() {
        let result = Evaluate(`
var square = (n int32) -> n * n
square(5)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(25, result.Value)
    }

    @Fact
    func InferredBinding_CapturesOuterLocals() {
        let result = Evaluate(`
let base = 100
let addBase = (n int32) -> n + base
addBase(7)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(107, result.Value)
    }

    @Fact
    func GenericMethodInference_StillWorks_WithFuncSyntax() {
        // ADR-0076 §6: the new bottom-up inference must not regress the
        // existing generic method-type inference path. The classic `func`
        // syntax in argument position still binds.
        let diags = GetDiagnostics(`
import System
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)

var positives = list.Where(func(x int32) bool { return x > 1 })
`)
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.Id == "GS0304")
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.IsError && d.Id != "GS9999")
    }

    @Fact
    func RecursiveSelfReference_IsRejected_WithExistingDiagnostic() {
        // ADR-0076 §5: a `let` binding's name is NOT visible inside its
        // own initializer. The body references `f` and gets an existing
        // "no such name" diagnostic. This test pins the documented
        // behaviour so future regressions are caught.
        let diags = GetDiagnostics(`
let f = (n int32) -> if n == 0 { 0 } else { f(n - 1) }
`)
        Assert.Contains(diags, (d Diagnostic) -> d.IsError && d.Message.Contains("'f'"))
    }

    @Fact
    func AsyncLambda_Inference_WrapsReturnInTask() {
        // The binding's function-type wraps the body's int32 in Task<int32>.
        // We do not await it: this test verifies that the assignment binds
        // without errors and the binding is invocable.
        let diags = GetDiagnostics(`
let asyncDouble = async (n int32) -> n * 2
let _ = asyncDouble(5)
1
`)
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func BlockBody_MultipleReturns_InferCommonType() {
        // Two explicit return statements with int32 expressions yield an
        // int32 common type. Straight-line returns keep this test focused on
        // inference rather than nested control flow. Only the first return is
        // reached at runtime.
        let result = Evaluate(`
let pick = (n int32) -> {
    return n
    return n + 1
}
pick(5)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func InferredLambda_AssignableTo_ArrowFunctionTypeClause() {
        // The inferred binding's type IS a FunctionTypeSymbol identical to
        // the spelled-out (int32) -> int32 type — assigning between the
        // two forms must succeed with no conversion diagnostic.
        let result = Evaluate(`
let inferred = (x int32) -> x + 1
let spelled (int32) -> int32 = inferred
spelled(41)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func GetDiagnostics(source string) ImmutableArray[Diagnostic] {
            return EmittedOracle.Evaluate(source).Diagnostics
        }
    }
}
