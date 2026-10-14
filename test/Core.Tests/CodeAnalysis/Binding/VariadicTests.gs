// <copyright file="VariadicTests.cs" company="GSharp">
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
import System.Collections.Immutable
import System.Linq
import Xunit

/// Emitted-oracle coverage for variadic.
open class VariadicTests {
    @Fact
    func Variadic_PassThroughImportedClrArray() {
        let result = Evaluate(`
import System

func CountTypes(types ...Type) int32 -> types.Length

CountTypes(Type.EmptyTypes)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func Variadic_PacksTrailingArgs_IntoSlice() {
        let result = Evaluate(`
func sum(nums ...int32) int32 {
    var total = 0
    for var i = 0; i < nums.Length; i++ {
        total = total + nums[i]
    }
    return total
}
sum(1, 2, 3, 4)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func Variadic_AcceptsZeroTrailingArgs_EmptySlice() {
        let result = Evaluate(`
func count(xs ...int32) int32 { return xs.Length }
count()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func Variadic_WithFixedParametersBefore() {
        let result = Evaluate(`
func joinWith(sep string, parts ...string) string {
    var s = ""
    for var i = 0; i < parts.Length; i++ {
        if i > 0 { s = s + sep }
        s = s + parts[i]
    }
    return s
}
joinWith(", ", "a", "b", "c")
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("a, b, c", result.Value)
    }

    @Fact
    func Variadic_TooFewFixedArgs_ReportsDiagnostic() {
        let result = Evaluate(`
func joinWith(sep string, parts ...string) string { return sep }
joinWith()
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Variadic_WrongElementType_ReportsDiagnostic() {
        let result = Evaluate(`
func sum(nums ...int32) int32 { return 0 }
sum(1, "x", 3)
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Variadic_NotLastParameter_ReportsDiagnostic() {
        let result = Evaluate(`
func bad(xs ...int32, n int32) int32 { return n }
bad(1, 2)
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Variadic_OnLambda_BodySeesSlice() {
        // ADR-0102 / issue #812: the binder accepts a variadic parameter on
        // a function-literal lambda; inside the body the name has type
        // <c>[]T</c>. Sanity test: bind a plain non-variadic baseline first,
        // then the variadic spelling, asserting both bind without
        // diagnostics. (Indirect call evaluation through the synthetic
        // FunctionTypeSymbol does not preserve IsVariadic by design — see
        // ADR-0102 §5 — so packing semantics are exercised in the emit
        // tests, not here.)
        let result = Evaluate(`
let f = func(xs ...int32) int32 { return xs.Length }
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Variadic_OnArrowLambda_BodySeesSlice() {
        // ADR-0102 §3 — arrow-lambda variant.
        let result = Evaluate(`
let count = (xs ...int32) -> xs.Length
count([]int32{10, 20, 30})
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    // ADR-0102 / issue #812 — variadic on class instance methods.
    @Fact
    func Variadic_OnClassInstanceMethod_PacksTrailingArgs() {
        let result = Evaluate(`
class Joiner {
    func Sum(nums ...int32) int32 {
        var total = 0
        for var i = 0; i < nums.Length; i++ { total = total + nums[i] }
        return total
    }
}
var j = Joiner()
j.Sum(1, 2, 3, 4)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func Variadic_OnClassInstanceMethod_PassThroughSlice() {
        let result = Evaluate(`
class Joiner {
    func Count(nums ...int32) int32 { return nums.Length }
}
var j = Joiner()
j.Count([]int32{1, 2, 3})
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func Variadic_OnClassInstanceMethod_EmptyCall_ProducesEmptySlice() {
        let result = Evaluate(`
class Joiner {
    func Count(nums ...int32) int32 { return nums.Length }
}
var j = Joiner()
j.Count()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    // ADR-0102 / issue #812 — variadic on a class static (shared) method.
    @Fact
    func Variadic_OnSharedStaticMethod_PacksTrailingArgs() {
        let result = Evaluate(`
class Sequences {
    shared {
        func Of[T](values ...T) []T { return values }
    }
}
let xs = Sequences.Of(1, 2, 3)
xs.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func Variadic_OnSharedStaticMethod_SingleArrayPassesThrough() {
        let result = Evaluate(`
class Sequences {
    shared {
        func Of[T](values ...T) []T { return values }
    }
}
let arr = []int32{10, 20, 30}
let xs = Sequences.Of(arr)
xs[1]
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(20, result.Value)
    }

    @Fact
    func Variadic_OnSharedStaticMethod_EmptyCall_ProducesEmptySlice() {
        let result = Evaluate(`
class Sequences {
    shared {
        func Of[T](values ...T) []T { return values }
    }
}
let xs = Sequences.Of[int32]()
xs.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    // ADR-0102 / issue #812 — variadic on an interface default-body method
    // (ADR-0085). The default body must see the parameter as <c>[]T</c>.
    @Fact
    func Variadic_OnInterfaceDefaultBody_PacksTrailingArgs() {
        let result = Evaluate(`
interface IAdder {
    func Add(nums ...int32) int32 {
        var total = 0
        for var i = 0; i < nums.Length; i++ { total = total + nums[i] }
        return total
    }
}
class Adder : IAdder {}
var a = Adder()
a.Add(1, 2, 3, 4)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func Variadic_OnInterfaceDefaultBody_EmptyCall() {
        let result = Evaluate(`
interface IAdder {
    func Add(nums ...int32) int32 { return nums.Length }
}
class Adder : IAdder {}
var a = Adder()
a.Add()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    // ADR-0102 / issue #812 — variadic on a constructor (init block).
    @Fact
    func Variadic_OnConstructor_PacksTrailingArgs() {
        let result = Evaluate(`
class Tags {
    var Values []string
    init(vs ...string) {
        Values = vs
    }
}
var t = Tags("a", "b", "c")
t.Values.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func Variadic_OnConstructor_PassThroughAndEmpty() {
        let result = Evaluate(`
class Tags {
    var Values []string
    init(vs ...string) {
        Values = vs
    }
}
var t = Tags([]string{"x", "y"})
t.Values.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    // ADR-0102 / issue #812 — variadic on a named delegate type. Both the
    // direct-call form `d(args)` and the explicit `d.Invoke(args)` member
    // form must pack / pass-through trailing arguments. These binder-only
    // checks assert that the declaration and call site bind without
    // diagnostics; runtime semantics are covered by the emit tests
    // (VariadicEmitTests.Variadic_OnNamedDelegate_*).
    @Fact
    func Variadic_OnNamedDelegate_DirectCall_Binds() {
        let diagnostics = Bind(`
package P
delegate Adder(nums ...int32) int32;
var d Adder = func(nums ...int32) int32 { return 0 }
let r = d(1, 2, 3, 4)
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Variadic_OnNamedDelegate_InvokeForm_Binds() {
        let diagnostics = Bind(`
package P
delegate Adder(nums ...int32) int32;
var d Adder = func(nums ...int32) int32 { return 0 }
let r = d.Invoke(1, 2, 3, 4)
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Variadic_OnNamedDelegate_SingleArrayPassesThrough_Binds() {
        let diagnostics = Bind(`
package P
delegate Counter(nums ...int32) int32;
var d Counter = func(nums ...int32) int32 { return 0 }
let r = d([]int32{1, 2, 3})
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Variadic_OnNamedDelegate_EmptyCall_Binds() {
        let diagnostics = Bind(`
package P
delegate Counter(nums ...int32) int32;
var d Counter = func(nums ...int32) int32 { return 0 }
let r = d()
`)
        Assert.Empty(diagnostics)
    }

    // ADR-0101 / issue #799 — issue repro: `Sequences.Of`-shaped generic
    // variadic. Declared in source as `func Of[T](values ...T) []T` so the
    // test exercises every branch (multi-arg pack, single-array pass-through,
    // empty pack) without depending on the C#-authored helper.
    @Fact
    func Variadic_Generic_PacksTrailingArgs() {
        let result = Evaluate(`
func Of[T](values ...T) []T { return values }
let xs = Of(1, 2, 3)
xs.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func Variadic_Generic_SingleArrayPassesThrough() {
        // Issue #799 §3 (call-site semantics): when the caller supplies a
        // single trailing argument already typed `[]T`, it must be passed
        // through as-is — no double-wrap.
        let result = Evaluate(`
func Of[T](values ...T) []T { return values }
let arr = []int32{10, 20, 30}
let xs = Of(arr)
xs.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func Variadic_Generic_EmptyCall_ProducesEmptySlice() {
        let result = Evaluate(`
func Of[T](values ...T) []T { return values }
let xs = Of[int32]()
xs.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func Variadic_Generic_PassThrough_PreservesIdentity() {
        // The pass-through path means the body sees the SAME array the
        // caller supplied — index 1 of the returned slice equals the
        // value the caller stored at index 1 of the input.
        let result = Evaluate(`
func Of[T](values ...T) []T { return values }
let arr = []int32{100, 200, 300}
let xs = Of(arr)
xs[1]
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(200, result.Value)
    }

    @Fact
    func Variadic_MultipleVariadicParameters_Diagnostic() {
        // ADR-0101 / issue #799: at most one variadic param per signature.
        let result = Evaluate(`
func bad(xs ...int32, ys ...int32) int32 { return 0 }
bad(1)
`)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0364")
    }

    @Fact
    func Variadic_ParamsKeyword_Rejected() {
        // ADR-0101 / issue #799: the C# `params` keyword is intentionally
        // not part of the G# grammar. The parser flags the spelling
        // and points the user at the canonical `...T` form.
        let result = Evaluate(`
func bad(params values []int32) int32 { return 0 }
bad()
`)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0363")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] {
            // Bind-only helper for sites whose declaration and call-site binding
            // are the test subject. Mirrors NamedDelegateBindingTests.Bind.
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
