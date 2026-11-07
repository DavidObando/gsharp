// <copyright file="IsAsExpressionBinderTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Unit tests for the binder's handling of expression-level `is` and `as` operators (issue #575).
open class IsAsExpressionBinderTests {
    @Fact
    func BoundIsExpression_HasBoolType() {
        let expr = BoundIsExpression(nil, BoundLiteralExpression(nil, "hello"), TypeSymbol.String)
        Assert.Equal(BoundNodeKind.IsExpression, expr.Kind)
        Assert.Same(TypeSymbol.Bool, expr.Type)
    }

    @Fact
    func BoundAsExpression_RefType_HasTargetType() {
        let targetType = TypeSymbol.String
        let expr = BoundAsExpression(nil, BoundLiteralExpression(nil, "hello"), targetType)
        Assert.Equal(BoundNodeKind.AsExpression, expr.Kind)
        Assert.Same(targetType, expr.Type)
    }

    @Fact
    func BoundAsExpression_NullableValueType_HasNullableType() {
        let nullableInt = NullableTypeSymbol.Get(TypeSymbol.Int32)
        let expr = BoundAsExpression(nil, BoundLiteralExpression(nil, 42), nullableInt)
        Assert.Equal(BoundNodeKind.AsExpression, expr.Kind)
        Assert.Same(nullableInt, expr.Type)
    }

    @Fact
    func BindAsExpression_NonNullableValueType_ProducesDiagnostic() {
        let source = "let boxed object = 42\nlet r = boxed as int32"
        let result = Evaluate(source)
        Assert.True(
            result.Diagnostics.Any((d Diagnostic) -> d.Id == "GS0270"),
            "Expected GS0270, got: ${string.Join(", ", result.Diagnostics.Select((d Diagnostic) -> "${d.Id}: ${d.Message}"))}"
        )
    }

    @Fact
    func BindAsExpression_IncompatibleValueAndReferenceTypes_ReportsGS0637() {
        let result = Evaluate("let s = 42 as string")
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0637")
        Assert.Contains("Cannot convert type 'int32' to 'string'", diagnostic.Message)
    }

    @Fact
    func BindAsExpression_IncompatibleValueTypesWithExplicitConversion_ReportsGS0637WithCastHint() {
        let result = Evaluate("let u = nuint(1)\nlet p = u as int64?")
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0637")
        Assert.Contains("Cannot convert type 'nuint' to 'int64?'", diagnostic.Message)
        Assert.Contains("cast[int64]", diagnostic.Message)
    }

    @Fact
    func BindAsExpression_FunctionPointerTargetRejectsNuintAndAdmitsNintAndObject() {
        let rejected = Evaluate("let u = nuint(1)\nlet fp = u as (unmanaged () -> int32)?")
        let diagnostic = Assert.Single(rejected.Diagnostics, (d Diagnostic) -> d.Id == "GS0637")
        Assert.Contains("cast[unmanaged () -> int32]", diagnostic.Message)

        let allowed = Evaluate(`let addr = nint(0)
let obj object = addr
let fp1 = addr as (unmanaged () -> int32)?
let fp2 = obj as (unmanaged () -> int32)?
fp1 != nil && fp2 != nil`)
        Assert.Empty(allowed.Diagnostics)
        Assert.Equal(true, allowed.Value)
    }

    @Fact
    func BindAsExpression_SealedUnrelatedClassesAndInterfaces_ReportsGS0637() {
        let unrelatedClasses = Evaluate(`class Alpha {}
class Beta {}
let a = Alpha()
let b = a as Beta`)
        Assert.Single(unrelatedClasses.Diagnostics, (d Diagnostic) -> d.Id == "GS0637")

        let unrelatedInterfaceAndSealed = Evaluate(`interface IFoo {}
class SealedBar {}
func Check(x IFoo) SealedBar? -> x as SealedBar
Check(nil!!)`)
        Assert.Single(unrelatedInterfaceAndSealed.Diagnostics, (d Diagnostic) -> d.Id == "GS0637")
    }

    @Fact
    func BindAsExpression_ValidReferenceAndInterfaceHierarchyControls_BindCleanly() {
        let result = Evaluate(`interface IFoo {}
open class OpenBase {}
class Derived : OpenBase, IFoo {}
open class UnrelatedOpen {}
struct UserStruct { var X int32 }
enum UserEnum { A }

func Check(o object, i IFoo, b OpenBase, s UserStruct, e UserEnum) bool {
    let str = o as string
    let d1 = i as Derived
    let d2 = b as Derived
    let u = i as UnrelatedOpen
    let boxedS = s as object
    let unboxedS = boxedS as UserStruct?
    let boxedE = e as object
    let unboxedE = boxedE as UserEnum?
    return str == nil && d1 != nil && d2 != nil && u == nil && unboxedS != nil && unboxedE != nil
}

let d = Derived()
Check(42, d, d, UserStruct{X: 7}, UserEnum.A)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func BindAsExpression_ConstructedGenericContainerIncompatibleWithOperand_ReportsGS0637() {
        let rejected = Evaluate(`import System.Collections.Generic
func Check[T](x int32) List[T]? -> x as List[T]
Check[string](42) == nil`)
        Assert.Single(rejected.Diagnostics, (d Diagnostic) -> d.Id == "GS0637")

        let allowed = Evaluate(`import System.Collections.Generic
func Check[T](x object, xs IEnumerable[T]) bool {
    let a = x as List[T]
    let b = xs as List[T]
    return a == nil && b != nil
}
Check[int32](42, List[int32]{1})`)
        Assert.Empty(allowed.Diagnostics)
        Assert.Equal(true, allowed.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
