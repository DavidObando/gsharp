// <copyright file="Issue1158ConditionalSiblingUnifyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1158: an `if`/conditional-expression whose two arms are sibling
/// subtypes sharing a common base (or interface) must unify to that common
/// supertype (best-common-type), and an explicit target type must drive the
/// conversion (C# 9+ target-typed conditional) — matching the switch-expression
/// machinery (#1112/#1151). These tests cover both the `if`-expression and
/// the ternary `?:` form, and confirm the existing one-way, numeric and
/// nil behaviors are unchanged.
open class Issue1158ConditionalSiblingUnifyTests {
    @Fact
    func ReproF_ReturnIfExpression_SiblingArms_ReturnTypeBox_NoDiagnostics() {
        // Issue repro F: both arms are siblings of Box; the declared return type
        // Box is the target the arms unify to.
        let diagnostics = Bind(Hierarchy + `
func F(b bool, x Co64Box, y StcoBox) Box {
    return if b { x } else { y }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func ReproG_LetTypedBox_IfExpression_SiblingArms_NoDiagnostics() {
        // Issue repro G: an explicitly-typed local Box supplies the target type.
        let diagnostics = Bind(Hierarchy + `
func G(b bool, x Co64Box, y StcoBox) {
    let r Box = if b { x } else { y }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Ternary_SiblingArms_ReturnTypeBox_NoDiagnostics() {
        let diagnostics = Bind(Hierarchy + `
func F(b bool, x Co64Box, y StcoBox) Box {
    return b ? x : y
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Ternary_SiblingArms_LetTypedBox_NoDiagnostics() {
        let diagnostics = Bind(Hierarchy + `
func G(b bool, x Co64Box, y StcoBox) {
    let r Box = b ? x : y
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func NoTarget_IfExpression_SiblingArms_InfersBox() {
        // No declared target: the best-common-type (LUB) fallback unifies the
        // two siblings to their shared base Box.
        let scope_ = BindGlobalScope(Hierarchy + `
let b = true
let x = Co64Box()
let y = StcoBox()
let r = if b { x } else { y }
`)
        Assert.Empty(scope_.Diagnostics)
        Assert.Equal("Box", scope_.Variables.Single((v VariableSymbol) -> v.Name == "r").Type.Name)
    }

    @Fact
    func NoTarget_Ternary_SiblingArms_InfersBox() {
        let scope_ = BindGlobalScope(Hierarchy + `
let b = true
let x = Co64Box()
let y = StcoBox()
let r = b ? x : y
`)
        Assert.Empty(scope_.Diagnostics)
        Assert.Equal("Box", scope_.Variables.Single((v VariableSymbol) -> v.Name == "r").Type.Name)
    }

    @Fact
    func NoTarget_IfExpression_CommonInterfaceArms_InfersIShape() {
        // Sq and Ci share only the interface IShape (no common non-object base);
        // the LUB enumerates interfaces and unifies to IShape.
        let scope_ = BindGlobalScope(Hierarchy + `
let b = true
let x = Sq()
let y = Ci()
let r = if b { x } else { y }
`)
        Assert.Empty(scope_.Diagnostics)
        Assert.Equal("IShape", scope_.Variables.Single((v VariableSymbol) -> v.Name == "r").Type.Name)
    }

    @Fact
    func NoTarget_Ternary_CommonInterfaceArms_InfersIShape() {
        let scope_ = BindGlobalScope(Hierarchy + `
let b = true
let x = Sq()
let y = Ci()
let r = b ? x : y
`)
        Assert.Empty(scope_.Diagnostics)
        Assert.Equal("IShape", scope_.Variables.Single((v VariableSymbol) -> v.Name == "r").Type.Name)
    }

    @Fact
    func TargetTyped_LetIShape_CommonInterfaceArms_NoDiagnostics() {
        let diagnostics = Bind(Hierarchy + `
func H(b bool, x Sq, y Ci) {
    let r IShape = if b { x } else { y }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func BaseDerived_IfExpression_TargetAnimal_NoDiagnostics() {
        // One arm IS the base (Animal); the existing one-way implicit path keeps
        // working unchanged.
        let diagnostics = Bind(Hierarchy + `
func B(b bool, d Dog, a Animal) Animal {
    return if b { d } else { a }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func BaseDerived_NoTarget_InfersAnimal() {
        let scope_ = BindGlobalScope(Hierarchy + `
let b = true
let d = Dog()
let a = Animal()
let r = if b { d } else { a }
`)
        Assert.Empty(scope_.Diagnostics)
        Assert.Equal("Animal", scope_.Variables.Single((v VariableSymbol) -> v.Name == "r").Type.Name)
    }

    @Fact
    func Numeric_IfExpression_Int32AndInt64_StillUnifiesToInt64() {
        // Guard: ADR-0037 numeric tie-break behavior is unchanged — an int32 and
        // an int64 arm unify to int64 (issue #1150's surface is untouched).
        let scope_ = BindGlobalScope(Hierarchy + `
let b = true
let i32v int32 = 5
let i64v int64 = 5
let r = if b { i32v } else { i64v }
`)
        Assert.Empty(scope_.Diagnostics)
        Assert.Equal(TypeSymbol.Int64, scope_.Variables.Single((v VariableSymbol) -> v.Name == "r").Type)
    }

    @Fact
    func Numeric_Ternary_Int32AndInt64_StillUnifiesToInt64() {
        let scope_ = BindGlobalScope(Hierarchy + `
let b = true
let i32v int32 = 5
let i64v int64 = 5
let r = b ? i32v : i64v
`)
        Assert.Empty(scope_.Diagnostics)
        Assert.Equal(TypeSymbol.Int64, scope_.Variables.Single((v VariableSymbol) -> v.Name == "r").Type)
    }

    @Fact
    func Unrelated_NoTarget_IfExpression_StillReportsGS0263() {
        // Two unrelated user classes share only object; with NO target type the
        // best-common-type (which deliberately excludes object) yields none, so
        // GS0263 still fires.
        let diagnostics = Bind(Hierarchy + `
func U(b bool, x Box, y Unrelated) {
    let r = if b { x } else { y }
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0263")
    }

    @Fact
    func Unrelated_ObjectTarget_IfExpression_NoDiagnostics() {
        // string and int32 share only object. With NO target the conditional is
        // GS0263, but an explicit `object` target drives both arms' implicit
        // conversion to object (target-typing), so it binds cleanly.
        let diagnostics = Bind(Hierarchy + `
func O(b bool, s string, n int32) {
    let r object = if b { s } else { n }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Unrelated_ObjectTarget_NoTarget_StillReportsGS0263() {
        // The same string/int32 pair WITHOUT a target still reports GS0263.
        let diagnostics = Bind(Hierarchy + `
func O(b bool, s string, n int32) {
    let r = if b { s } else { n }
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0263")
    }

    @Fact
    func Unrelated_ObjectTarget_Ternary_NoDiagnostics() {
        let diagnostics = Bind(Hierarchy + `
func O(b bool, s string, n int32) {
    let r object = b ? s : n
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func NilArm_NullableReferenceArm_IfExpression_UnifiesToNullable() {
        // A nullable-reference arm (`string?`) unified with a `nil` arm stays
        // `string?` — unchanged from the existing nil/null handling.
        let scope_ = BindGlobalScope(Hierarchy + `
let b = true
let s string? = "hi"
let r = if b { s } else { nil }
`)
        Assert.Empty(scope_.Diagnostics)
        let nullable = Assert.IsType[NullableTypeSymbol](
            scope_.Variables.Single((v VariableSymbol) -> v.Name == "r").Type
        )
        Assert.Equal(TypeSymbol.String, nullable.UnderlyingType)
    }

    @Fact
    func NilArm_NullableReferenceArm_Ternary_UnifiesToNullable() {
        let scope_ = BindGlobalScope(Hierarchy + `
let b = true
let s string? = "hi"
let r = b ? s : nil
`)
        Assert.Empty(scope_.Diagnostics)
        let nullable = Assert.IsType[NullableTypeSymbol](
            scope_.Variables.Single((v VariableSymbol) -> v.Name == "r").Type
        )
        Assert.Equal(TypeSymbol.String, nullable.UnderlyingType)
    }

    @Fact
    func NoTarget_IfExpression_NullableCommonInterfaceArms_InfersNullableIShape() {
        // Issue #2202: both arms are NULLABLE-wrapped siblings (Sq?/Ci?) that
        // share only the interface IShape. Before the fix, EnumerateSupertypeCandidates
        // never unwrapped the NullableTypeSymbol arms, so the base/interface walk
        // never found IShape and the conditional reported GS0263. The common type
        // must be computed on the unwrapped types (Sq/Ci -> IShape) and then
        // re-wrapped nullable since both arms were nullable.
        let scope_ = BindGlobalScope(Hierarchy + `
let b = true
let x Sq? = Sq()
let y Ci? = Ci()
let r = if b { x } else { y }
`)
        Assert.Empty(scope_.Diagnostics)
        let nullable = Assert.IsType[NullableTypeSymbol](
            scope_.Variables.Single((v VariableSymbol) -> v.Name == "r").Type
        )
        Assert.Equal("IShape", nullable.UnderlyingType.Name)
    }

    @Fact
    func NoTarget_Ternary_NullableCommonInterfaceArms_InfersNullableIShape() {
        let scope_ = BindGlobalScope(Hierarchy + `
let b = true
let x Sq? = Sq()
let y Ci? = Ci()
let r = b ? x : y
`)
        Assert.Empty(scope_.Diagnostics)
        let nullable = Assert.IsType[NullableTypeSymbol](
            scope_.Variables.Single((v VariableSymbol) -> v.Name == "r").Type
        )
        Assert.Equal("IShape", nullable.UnderlyingType.Name)
    }

    @Fact
    func TargetTyped_LetNullableIShape_NullableCommonInterfaceArms_NoDiagnostics() {
        let diagnostics = Bind(Hierarchy + `
func H(b bool, x Sq?, y Ci?) {
    let r IShape? = if b { x } else { y }
}
`)
        Assert.Empty(diagnostics)
    }

    shared {
        // Sibling subtypes of a shared base, a base/derived pair, and two classes
        // sharing only an interface (no common non-object base).
        private const Hierarchy string = `
open class Box { }
class Co64Box : Box { }
class StcoBox : Box { }
open class Animal { }
class Dog : Animal { }
interface IShape { }
class Sq : IShape { }
class Ci : IShape { }
class Unrelated { }
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
    }
}
