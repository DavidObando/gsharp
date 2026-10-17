// <copyright file="Issue4962IfExpressionInitializerBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Linq
import Xunit

/// Issue #4962 / ADR-0064: the if-expression's `if init; cond` initializer
/// is scoped exactly like the if-statement's. It is visible in the condition,
/// in both branches and in every link of an `else if` chain, and not after
/// the `if`. Most tests run the statement and expression forms side by side
/// and require the same output or the same diagnostics.
open class Issue4962IfExpressionInitializerBindingTests {
    @Fact
    func Initializer_IsVisibleInConditionAndBothBranches_InBothForms() {
        let statement = Evaluate(`import System
func Run(n int32) string {
    var r = ""
    if var v = n * 2; v > 4 {
        r = "then ${v}"
    } else {
        r = "else ${v}"
    }
    return r
}
Console.WriteLine(Run(1))
Console.WriteLine(Run(5))`)
        let expression = Evaluate(`import System
func Run(n int32) string {
    return if var v = n * 2; v > 4 { "then ${v}" } else { "else ${v}" }
}
Console.WriteLine(Run(1))
Console.WriteLine(Run(5))`)
        AssertNoErrors(statement)
        AssertNoErrors(expression)
        Assert.Equal("else 2${Environment.NewLine}then 10${Environment.NewLine}", expression.Output)
        Assert.Equal(statement.Output, expression.Output)
    }

    @Fact
    func Initializer_IsNotVisibleAfterTheIf_InBothForms() {
        let statement = Evaluate(`func F() int32 {
    if var v = 1; v > 0 {
        let a = v
    } else {
        let b = v
    }
    return v
}`)
        let expression = Evaluate(`func F() int32 {
    let s = if var v = 1; v > 0 { v } else { v }
    return v
}`)
        Assert.Equal([]string{"GS0125"}, ErrorIds(statement))
        Assert.Equal(ErrorIds(statement), ErrorIds(expression))
        Assert.Contains("'v'", expression.Diagnostics.Single((d Diagnostic) -> d.Id == "GS0125").Message)
    }

    @Fact
    func ElseIfChain_SeesOuterInitializer_InBothForms() {
        let statement = Evaluate(`import System
func Run(n int32) string {
    var r = ""
    if var a = n; a > 10 {
        r = "big ${a}"
    } else if var b = a * 3; b > 10 {
        r = "mid ${a} ${b}"
    } else {
        r = "small ${a} ${b}"
    }
    return r
}
Console.WriteLine(Run(20))
Console.WriteLine(Run(5))
Console.WriteLine(Run(1))`)
        let expression = Evaluate(`import System
func Run(n int32) string {
    return if var a = n; a > 10 { "big ${a}" } else if var b = a * 3; b > 10 { "mid ${a} ${b}" } else { "small ${a} ${b}" }
}
Console.WriteLine(Run(20))
Console.WriteLine(Run(5))
Console.WriteLine(Run(1))`)
        AssertNoErrors(statement)
        AssertNoErrors(expression)
        Assert.Equal(
            "big 20${Environment.NewLine}mid 5 15${Environment.NewLine}small 1 3${Environment.NewLine}",
            expression.Output
        )
        Assert.Equal(statement.Output, expression.Output)
    }

    @Fact
    func ElseIfInitializer_IsNotVisibleInOuterThenBranch_InBothForms() {
        let statement = Evaluate(`func F() int32 {
    var r = 0
    if var a = 1; a > 5 {
        r = b
    } else if var b = 2; b > a {
        r = a + b
    }
    return r
}`)
        let expression = Evaluate(`func F() int32 {
    return if var a = 1; a > 5 { b } else if var b = 2; b > a { a + b } else { a - b }
}`)
        Assert.Equal([]string{"GS0125"}, ErrorIds(statement))
        Assert.Equal(ErrorIds(statement), ErrorIds(expression))
        Assert.Contains("'b'", expression.Diagnostics.Single((d Diagnostic) -> d.Id == "GS0125").Message)
    }

    @Fact
    func Initializer_ShadowingAnOuterLocal_BehavesTheSameInBothForms() {
        let statement = Evaluate(`import System
var v = 1
if var v = 2; v > 0 {
    Console.WriteLine(v)
}
Console.WriteLine(v)`)
        let expression = Evaluate(`import System
var v = 1
Console.WriteLine(if var v = 2; v > 0 { v } else { 0 })
Console.WriteLine(v)`)
        Assert.Equal(ErrorIds(statement), ErrorIds(expression))
        Assert.Equal(statement.Output, expression.Output)
    }

    @Fact
    func SameInitializerNameInSiblingIfs_DoesNotCollide_InBothForms() {
        let statement = Evaluate(`func F() {
    if var a = 1; a > 5 { }
    if var a = 2; a > 5 { }
}`)
        let expression = Evaluate(`func F() int32 {
    let x = if var a = 1; a > 5 { 1 } else { 2 }
    let y = if var a = 2; a > 5 { 1 } else { 2 }
    return x + y
}`)
        AssertNoErrors(statement)
        AssertNoErrors(expression)
    }

    @Fact
    func MissingElse_WithInitializer_ReportsGS0276() {
        let result = Evaluate(`func F() int32 {
    return if var a = 1; a > 5 { 1 }
}`)
        Assert.Equal([]string{"GS0276"}, ErrorIds(result))
    }

    @Fact
    func TargetTyping_FlowsIntoBranchesWithInitializer() {
        let result = Evaluate(`import System
let wide int64 = if var v = 5; v > 3 { v } else { 0 }
let narrow byte = if var v = 5; v > 3 { 200 } else { 0 }
let maybe int32? = if var v = 1; v > 3 { v } else { nil }
let scale (int32) -> int32 = if var k = 3; k > 1 { (x) -> x * k } else { (x) -> x }
Console.WriteLine("${wide.GetType().Name} ${narrow.GetType().Name} ${narrow} ${maybe == nil} ${scale(5)}")`)
        AssertNoErrors(result)
        Assert.Equal("Int64 Byte 200 True 15${Environment.NewLine}", result.Output)
    }

    @Fact
    func OverloadedArgument_RebindsInitializerWithoutDuplicateDeclaration() {
        // An if-expression argument is bound again once overload resolution
        // knows the parameter type (issue #1238). The initializer's local must
        // not report GS0004 on that second binding.
        let result = Evaluate(`import System
func Show(x int64) { Console.WriteLine("int64 ${x}") }
func Show(x string) { Console.WriteLine("string ${x}") }
Show(if var v = 5; v > 3 { v } else { 0 })
Show(if var s = "a"; s.Length > 0 { s + "b" } else { "c" })`)
        AssertNoErrors(result)
        Assert.Equal("int64 5${Environment.NewLine}string ab${Environment.NewLine}", result.Output)
    }

    @Fact
    func NilGuardOnInitializerLocal_NarrowsTheThenBranch_InBothForms() {
        let statement = Evaluate(`import System
func Maybe(b bool) string? { return if b { "abc" } else { nil } }
func Len(b bool) int32 {
    var r = -1
    if var s = Maybe(b); s != nil {
        r = s.Length
    }
    return r
}
Console.WriteLine("${Len(true)} ${Len(false)}")`)
        let expression = Evaluate(`import System
func Maybe(b bool) string? { return if b { "abc" } else { nil } }
func Len(b bool) int32 -> if var s = Maybe(b); s != nil { s.Length } else { -1 }
Console.WriteLine("${Len(true)} ${Len(false)}")`)
        AssertNoErrors(statement)
        AssertNoErrors(expression)
        Assert.Equal("3 -1${Environment.NewLine}", expression.Output)
        Assert.Equal(statement.Output, expression.Output)
    }

    @Fact
    func AssignmentIncrementAndCallInitializers_Work_InBothForms() {
        let statement = Evaluate(`import System
var counter = 0
var r = ""
if counter = 4; counter > 3 { r = r + "assign ${counter} " }
if counter++; counter > 4 { r = r + "inc ${counter} " }
if Console.Write("call "); counter > 4 { r = r + "call" }
Console.WriteLine(r)`)
        let expression = Evaluate(`import System
var counter = 0
let a = if counter = 4; counter > 3 { "assign ${counter} " } else { "no " }
let b = if counter++; counter > 4 { "inc ${counter} " } else { "no " }
let c = if Console.Write("call "); counter > 4 { "call" } else { "no" }
Console.WriteLine(a + b + c)`)
        AssertNoErrors(statement)
        AssertNoErrors(expression)
        Assert.Equal("call assign 4 inc 5 call${Environment.NewLine}", expression.Output)
        Assert.Equal(statement.Output, expression.Output)
    }

    @Fact
    func NestedIfExpressionWithInitializerInCondition_RunsInBothForms() {
        let statement = Evaluate(`import System
let flags = []bool{false, true}
if if var x = 1; x > 0 { true } else { false } {
    Console.Write("a ")
}
if flags[if var i = 1; i > 0 { i } else { 0 }] {
    Console.Write("b ")
}
if var a = 1; if var b = a; b > 0 { true } else { false } {
    Console.Write("c${a}")
}
Console.WriteLine()`)
        let expression = Evaluate(`import System
let flags = []bool{false, true}
let r1 = if if var x = 1; x > 0 { true } else { false } { "a " } else { "- " }
let r2 = if flags[if var i = 1; i > 0 { i } else { 0 }] { "b " } else { "- " }
let r3 = if var a = 1; if var b = a; b > 0 { true } else { false } { "c${a}" } else { "-" }
Console.WriteLine(r1 + r2 + r3)`)
        AssertNoErrors(statement)
        AssertNoErrors(expression)
        Assert.Equal("a b c1${Environment.NewLine}", expression.Output)
        Assert.Equal(statement.Output, expression.Output)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func ErrorIds(result EmittedOracleResult)[]string {
            return result
                .Diagnostics
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .Select((d Diagnostic) -> d.Id)
                .ToArray()
        }

        private func AssertNoErrors(result EmittedOracleResult) {
            Assert.Empty(ErrorIds(result))
        }
    }
}
