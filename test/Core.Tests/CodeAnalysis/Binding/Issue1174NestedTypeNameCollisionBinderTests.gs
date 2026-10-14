// <copyright file="Issue1174NestedTypeNameCollisionBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1174: a source-declared nested type whose simple name collides with a
/// same-named top-level type must remain referenceable unambiguously via the
/// qualified form `Container.Nested` — in a struct-literal position
/// (`C.E{ ... }`), as a type clause (return type / variable type), and in a
/// generic-argument position (`List[C.E]`). The constructed value's members
/// must resolve against the NESTED type (no spurious `GS0158`). Follow-up to
/// #1080.
open class Issue1174NestedTypeNameCollisionBinderTests {
    @Fact
    func QualifiedStructLiteral_UnderCollision_ResolvesNestedMembers() {
        // R2: `C.E{X:1u}` must construct the NESTED E (with member X), not the
        // top-level E (with member Y), so `e.X` resolves without GS0158.
        let scope_ = BindSource(`package p
class E { let Y int32 = 0 }
class C { data struct E(X uint32) { } }
func F() uint32 {
    let e = C.E{X: 1u}
    return e.X
}`)
        Assert.DoesNotContain(GetBinderDiagnostics(scope_), (d Diagnostic) -> d.Id == "GS0158")
        Assert.Empty(GetBinderDiagnostics(scope_))
    }

    @Fact
    func QualifiedTypeClause_ReturnType_UnderCollision_Binds() {
        let scope_ = BindSource(`package p
class E { let Y int32 = 0 }
class C { data struct E(X uint32) { } }
func G() C.E { return C.E{X: 1u} }`)
        Assert.Empty(GetBinderDiagnostics(scope_))
    }

    @Fact
    func DeepQualifiedChain_WithOuterHomonym_Resolves() {
        // A.B.C names a nested data struct even though a top-level `C` shares the
        // deepest simple name.
        let scope_ = BindSource(`package p
class C { data struct E(X uint32) { } }
class A { class B { data struct C(Z uint32) { } } }
func F() uint32 {
    let v = A.B.C{Z: 9u}
    return v.Z
}`)
        Assert.DoesNotContain(GetBinderDiagnostics(scope_), (d Diagnostic) -> d.Id == "GS0158")
        Assert.Empty(GetBinderDiagnostics(scope_))
    }

    @Fact
    func GenericNestedType_UnderCollision_Resolves() {
        let scope_ = BindSource(`package p
class Box { let W int32 = 0 }
class Outer { data struct Box[T](V T) { } }
func F() uint32 {
    let b = Outer.Box[uint32]{V: 4u}
    return b.V
}`)
        Assert.DoesNotContain(GetBinderDiagnostics(scope_), (d Diagnostic) -> d.Id == "GS0158")
        Assert.Empty(GetBinderDiagnostics(scope_))
    }

    @Fact
    func QualifiedNestedInGenericArgumentPosition_UserGeneric_Resolves() {
        // R4 at the binder level using a user-defined generic container so no BCL
        // reference set is required: `Bag[C.E]` must bind the nested E as the
        // type argument.
        let scope_ = BindSource(`package p
class E { let Y int32 = 0 }
class C { data struct E(X uint32) { } }
data struct Bag[T](Item T) { }
func F() Bag[C.E] { return Bag[C.E]{Item: C.E{X: 1u}} }`)
        Assert.DoesNotContain(GetBinderDiagnostics(scope_), (d Diagnostic) -> d.Id == "GS0158")
        Assert.Empty(GetBinderDiagnostics(scope_))
    }

    @Fact
    func NestedBySimpleName_NoCollision_StillWorks() {
        // Regression guard: with no top-level homonym the nested type keeps its
        // simple key and resolves by simple name.
        let scope_ = BindSource(`package p
class C { data struct E(X uint32) { } }
func F() uint32 {
    let e = E{X: 1u}
    return e.X
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
    }

    @Fact
    func QualifiedNested_NoCollision_AsReturnType_StillWorks() {
        let scope_ = BindSource(`package p
class C { data struct E(X uint32) { } }
func G() C.E { return C.E{X: 1u} }`)
        Assert.Empty(GetBinderDiagnostics(scope_))
    }

    @Fact
    func CollidingTopLevelType_KeepsSimpleKey_NestedRetainsQualifiedKey() {
        let scope_ = BindSource(`package p
class E { let Y int32 = 0 }
class C { data struct E(X uint32) { } }`)
        Assert.DoesNotContain(GetBinderDiagnostics(scope_), (d Diagnostic) -> d.Id == "GS0102")
        // The top-level type holds the simple key.
        let topLevel = cast[StructSymbol](scope_.TypeAliases["E"])
        Assert.Null(topLevel.ContainingType)
        // The nested type is retained as a distinct struct under its container.
        let nested = scope_.Structs.Single((s StructSymbol) -> s.Name == "E" && s.ContainingType != nil)
        Assert.Equal("C", nested.ContainingType!!.Name)
    }

    @Fact
    func DuplicateNestedSimpleName_SameContainer_StillReportsGS0102() {
        let scope_ = BindSource(`package p
class C {
    data struct E(X uint32) { }
    data struct E(Y uint32) { }
}`)
        Assert.Contains(GetBinderDiagnostics(scope_), (d Diagnostic) -> d.Id == "GS0102")
    }

    @Fact
    func DuplicateTopLevelType_StillReportsGS0102() {
        let scope_ = BindSource(`package p
class E { let Y int32 = 0 }
class E { let Z int32 = 0 }`)
        Assert.Contains(GetBinderDiagnostics(scope_), (d Diagnostic) -> d.Id == "GS0102")
    }

    shared {
        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }

        private func GetBinderDiagnostics($scope BoundGlobalScope) IEnumerable[Diagnostic] {
            return $scope.Diagnostics
        }
    }
}
