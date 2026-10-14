// <copyright file="Issue715ArrowFunctionTypeClauseBinderTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Issue #715 / ADR-0075 — binder/diagnostic behaviour for the canonical
/// arrow-form function-type clause `(T) -> R`: both spellings produce
/// identical function-type symbols, lambdas and method groups assign to
/// either form, and the legacy `func(T) R` spelling emits exactly one
/// GS0303 warning per occurrence.
open class Issue715ArrowFunctionTypeClauseBinderTests {
    @Fact
    func ArrowAndLegacyForms_ProduceIdentical_FunctionType_Symbol_Identity() {
        // Two locals with the same shape, spelled the two different ways:
        // assigning between them must succeed (no conversion diagnostic),
        // which proves they bind to the same FunctionTypeSymbol.
        let result = Evaluate(`
let add = func(a int32, b int32) int32 { return a + b }
let f1 (int32, int32) -> int32 = add
let f2 func(int32, int32) int32 = f1
f2(20, 22)
`)
        Assert.Equal(42, result.Value)
        // The only diagnostic should be the one GS0303 for the legacy
        // `func(int32, int32) int32` spelling on the `f2` declaration.
        let errors = result.Diagnostics.Where((d Diagnostic) -> d.IsError).ToList()
        Assert.Empty(errors)
        let warnings = result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0303").ToList()
        Assert.Single(warnings)
    }

    @Fact
    func Lambda_AssignableTo_ArrowForm_FunctionTypeClause() {
        let result = Evaluate(`
let inc (int32) -> int32 = (x int32) -> x + 1
inc(41)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func Lambda_AssignableTo_LegacyForm_FunctionTypeClause() {
        // The legacy spelling stays valid for one release; the only diff
        // is the GS0303 warning.
        let result = Evaluate(`
let inc func(int32) int32 = (x int32) -> x + 1
inc(41)
`)
        Assert.Equal(42, result.Value)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0303"))
    }

    @Fact
    func MethodGroup_AssignableTo_ArrowForm_FunctionTypeClause() {
        let result = Evaluate(`
func twice(x int32) int32 { return x * 2 }
let g (int32) -> int32 = twice
g(21)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ArrowAndLegacyForms_AreAssignmentCompatible_BothDirections() {
        let result = Evaluate(`
let add = func(a int32, b int32) int32 { return a + b }
let arrowSlot (int32, int32) -> int32 = add
let legacySlot func(int32, int32) int32 = arrowSlot
let arrowSlot2 (int32, int32) -> int32 = legacySlot
arrowSlot2(40, 2)
`)
        Assert.Equal(42, result.Value)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        // Exactly one GS0303 — for the single legacy spelling.
        Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0303"))
    }

    @Fact
    func Async_ArrowForm_LowersTo_TaskReturningFunctionType() {
        // `async (T) -> R` must lower to `(T) -> Task[R]`, matching the
        // legacy `async func(T) R` lowering. The two spellings produce the
        // same FunctionTypeSymbol — so assigning a value from one to the
        // other binds without a conversion diagnostic.
        let result = Evaluate(`
let arrowAsync async (int32) -> int32 = async func(x int32) int32 { return x + 100 }
let legacyAsync async func(int32) int32 = arrowAsync
1
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0303"))
        Assert.Equal(1, result.Value)
    }

    @Fact
    func GS0303_FiresOncePerOccurrence_OfLegacyFuncFormInTypeClause() {
        let result = Evaluate(`
let f func(int32) int32 = (x int32) -> x
let g (int32) -> int32 = (x int32) -> x
let h func(int32) int32 = (x int32) -> x
let i func(int32) int32 = (x int32) -> x
f(0) + g(0) + h(0) + i(0)
`)
        let warnings = result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0303").ToList()
        Assert.Equal(3, warnings.Count)
        Assert.All(warnings, (w Diagnostic) -> Assert.False(w.IsError))
    }

    @Fact
    func Arrow_Form_TypeName_Renders_Arrow_Spelling() {
        // FunctionTypeSymbol's display name is now `(T1, T2) -> R` — verify
        // by triggering a type-mismatch and matching the message.
        let source = `
let f (int32) -> int32 = "not a function"
`
        let diagnostics = EmittedOracle.Evaluate(source).Diagnostics
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError && d.Message.Contains("(int32) -> int32"))
    }

    @Fact
    func TupleReturn_ArrowForm_BindsToTupleType() {
        let result = Evaluate(`
func split(s string) (string, int32) { return (s, s.Length) }
let splitter (string) -> (string, int32) = split
let t = splitter("hello")
t.Item2
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func VoidReturn_ArrowForm_AcceptsVoidReturningLambda() {
        let result = Evaluate(`
let count = 0
let greet () -> void = () -> { }
greet()
1
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func ParenthesizedNullableArrowFunctionType_AcceptsMethodGroupAndNil() {
        let result = Evaluate(`
func cb(a int32) { }
let h ((int32) -> void)? = cb
let n ((int32) -> void)? = nil
let ah async ((int32) -> void)? = async func(a int32) { }
let an async ((int32) -> void)? = nil
1
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(1, result.Value)
    }

    @Fact
    func NonNullableArrowFunctionType_RejectsNil() {
        let result = Evaluate(`
func cb(a int32) { }
let h (int32) -> void = cb
let n (int32) -> void = nil
1
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError && d.Id == "GS0155")
    }

    @Fact
    func NullableReturnArrowFunctionType_NonVoidAndAsyncForms_StillWork() {
        let result = Evaluate(`
func maybe(a int32) int32? { return a + 1 }
let h (int32) -> int32? = maybe
let v int32? = h(41)
let ah async (int32) -> int32? = async func(a int32) int32? { return a + 1 }
v!!
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ParenthesizedNullableArrowFunctionType_NonVoid_AcceptsNil() {
        let result = Evaluate(`
let n ((int32) -> int32)? = nil
1
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(1, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
