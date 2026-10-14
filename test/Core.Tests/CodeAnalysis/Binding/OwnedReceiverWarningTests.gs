// <copyright file="OwnedReceiverWarningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0182 / issue #4240: a receiver-clause function is unconditionally an
/// extension now, regardless of the receiver type's owning package or
/// aggregate kind. `GS0103` and `GS0314` — the diagnostics that
/// policed the old ownership-dependent binding rule (ADR-0079, ADR-0165) —
/// are retired. These tests pin the new, marker-free behavior; the retired
/// `func extension (...)` spelling's migration diagnostic (GS0587) is
/// covered by `RetiredExplicitExtensionReceiverModifierTests`.
open class OwnedReceiverWarningTests {
    @Fact
    func SamePackage_ReceiverClauseFunction_OnClass_IsExtension_NoDiagnostics() {
        let source = `
class MyClass {
    var X int32
}

func (m MyClass) M() int32 { return m.X + 1 }

let c = MyClass{X: 41}
c.M()
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> (d.Id is "GS0103" or "GS0314"))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SamePackage_ReceiverClauseFunction_OnStruct_IsExtension_NoDiagnostics() {
        let source = `
struct Point {
    var X int32
    var Y int32
}

func (p Point) Distance() int32 { return p.X * p.X + p.Y * p.Y }
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> (d.Id is "GS0103" or "GS0314"))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func SamePackage_ReceiverClauseFunction_OnSealedClass_IsExtension_NoDiagnostics() {
        let source = `
sealed class Shape {
}

func (s Shape) Tag() int32 { return 1 }
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> (d.Id is "GS0103" or "GS0314"))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func SamePackage_ReceiverClauseFunction_OnDataClass_IsExtension_NoDiagnostics() {
        let source = `
data class Person(Name string)

func (p Person) Greet() int32 { return 1 }
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> (d.Id is "GS0103" or "GS0314"))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func SamePackage_ReceiverClauseFunction_OnEnum_IsExtension_NoDiagnostics() {
        // Pre-ADR-0165 this was rejected with GS0103; ADR-0165 required the
        // explicit `extension` marker to allow it. ADR-0182 makes it the
        // unmarked default.
        let source = `
enum Color { Red, Green }

func (c Color) Rank() int32 {
    if c == Color.Green {
        return 2
    }

    return 1
}

Color.Green.Rank()
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> (d.Id is "GS0103" or "GS0314"))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func SamePackage_ReceiverClauseFunction_OnInterface_IsExtension_NoDiagnostics() {
        let source = `
interface I {
    func F() int32;
}

func (i I) G() int32 { return 1 }
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> (d.Id is "GS0103" or "GS0314"))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func SamePackage_ReceiverClauseFunction_OnAlias_IsExtension_NoDiagnostics() {
        let source = `
type Count = int32
func (c Count) G() int32 { return c + 1 }
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> (d.Id is "GS0103" or "GS0314"))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func CrossPackage_ReceiverClauseFunction_RemainsExtension_NoDiagnostics() {
        let definingTree = SyntaxTree.Parse(SourceText.From(`
package Geometry
public struct Point {
    var X int32
}
`))
        let extensionTree = SyntaxTree.Parse(SourceText.From(`
package Extensions
func (p Point) Next() int32 { return p.X + 1 }
`))
        let compilation = Compilation(definingTree, extensionTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
    }

    @Fact
    func CrossAssembly_ReceiverClauseOnClrType_RemainsExtension_NoDiagnostics() {
        let source = `
import System.Text

func (sb StringBuilder) Reset() {
    sb.Length = 0
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> (d.Id is "GS0103" or "GS0314"))
    }

    @Fact
    func Extension_RemainsAvailableAsOrdinaryFunctionName() {
        let source = `
func extension(value int32) int32 { return value + 1 }
extension(41)
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func Extension_RemainsAvailableAsExtensionMethodName() {
        let source = `
func (s string) extension() int32 { return s.Length }
"hi".extension()
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func InBodyMethod_OnClass_IsTheOnlyInstanceMethodSpelling() {
        let source = `
class Greeter(name string) {
    func Greet() string { return "hi" }
}

let g = Greeter("x")
g.Greet()
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> (d.Id is "GS0103" or "GS0314"))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("hi", result.Value)
    }

    @Fact
    func InBodyMethod_OwnedInstanceSemantics_NotAvailableViaReceiverClause() {
        // The in-body form gets implicit-this bare member access and
        // interface conformance; the receiver-clause form is an extension
        // and gets neither. A bare (unqualified) field reference inside a
        // receiver-clause function body does not resolve — only an
        // in-body method sees the type's own member scope implicitly.
        let source = `
struct Counter {
    var Value int32
}

func (c Counter) Inc() int32 {
    return Value + 1
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func OperatorReceiverClause_OnOwnedClass_StillAttachesToType() {
        // ADR-0035: operators must use receiver-clause syntax; ADR-0182
        // keeps ADR-0079's operator carve-out — an operator has no in-body
        // form, so it keeps ownership-based routing unlike ordinary
        // receiver-clause functions.
        let source = `
class Vector2 {
    var X int32
    var Y int32
}

func (a Vector2) operator +(b Vector2) Vector2 {
    return Vector2{X: a.X + b.X, Y: a.Y + b.Y}
}

let sum = Vector2{X: 1, Y: 2} + Vector2{X: 3, Y: 4}
sum.X + sum.Y
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func TopLevelExtension_SameNameAsInBodyMethod_DoesNotCollide() {
        // The extension and instance-member declaration tables are
        // separate (ADR-0165's consequence, now the default rule): a
        // same-name receiver-clause extension no longer collides with an
        // in-body method the way two same-package receiver-clause
        // declarations used to under the pre-ADR-0182 rule.
        let source = `
class Point {
    func Sum() int32 { return 1 }
}

func (p Point) Sum() int32 { return 2 }
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
