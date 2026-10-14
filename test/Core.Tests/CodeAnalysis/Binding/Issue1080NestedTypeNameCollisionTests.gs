// <copyright file="Issue1080NestedTypeNameCollisionTests.cs" company="GSharp">
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

/// Issue #1080: nested-type name uniqueness must be scoped to the ENCLOSING
/// type. Two nested types with the same simple name in DIFFERENT enclosing
/// types — or a nested type whose simple name matches a package-level type —
/// must NOT collide with `GS0102`. A genuine duplicate (same simple name in
/// the SAME enclosing type, or two package-level types of the same name) must
/// still report `GS0102`. Follow-up to #1069.
open class Issue1080NestedTypeNameCollisionTests {
    @Fact
    func SameNestedSimpleName_DifferentOuters_DoesNotCollide() {
        let scope_ = BindSource(`package p
class A { class Inner { var X int32 } }
class B { class Inner { var Y int32 } }`)
        Assert.DoesNotContain(GetBinderDiagnostics(scope_), (d Diagnostic) -> d.Id == "GS0102")
        Assert.Empty(GetBinderDiagnostics(scope_))
        // Both nested types are retained as distinct declared structs, each with
        // the correct enclosing type.
        let inners = scope_.Structs.Where((s StructSymbol) -> s.Name == "Inner").ToList()
        Assert.Equal(2, inners.Count)
        Assert.Contains(inners, (i StructSymbol) -> i.ContainingType?.Name == "A")
        Assert.Contains(inners, (i StructSymbol) -> i.ContainingType?.Name == "B")
    }

    @Fact
    func PackageLevelType_VersusNestedDataStruct_SameName_DoesNotCollide() {
        let scope_ = BindSource(`package p
class SampleEntry { var A int32 }
class SttsBox {
    data struct SampleEntry(FrameCount uint32, FrameDelta uint32) { }
}`)
        Assert.DoesNotContain(GetBinderDiagnostics(scope_), (d Diagnostic) -> d.Id == "GS0102")
        Assert.Empty(GetBinderDiagnostics(scope_))
        let entries = scope_.Structs.Where((s StructSymbol) -> s.Name == "SampleEntry").ToList()
        Assert.Equal(2, entries.Count)
        // The package-level type stays resolvable by its simple name.
        let packageLevel = cast[StructSymbol](scope_.TypeAliases["SampleEntry"])
        Assert.Null(packageLevel.ContainingType)
        // The nested type is retained under its qualified key and carries the
        // enclosing type.
        let nested = entries.Single((e StructSymbol) -> e.ContainingType != nil)
        Assert.Equal("SttsBox", nested.ContainingType!!.Name)
    }

    @Theory
    @InlineData("class Inner { var X int32 }")
    @InlineData("struct Inner { var X int32 }")
    @InlineData("data struct Inner(X uint32) { }")
    @InlineData("enum Inner { Red, Green }")
    func SameNestedKind_DifferentOuters_DoesNotCollide(nestedDecl string) {
        let scope_ = BindSource((`package p
class A { ` + "$nestedDecl" + ` }
class B { ` + "$nestedDecl" + ` }`))
        Assert.DoesNotContain(GetBinderDiagnostics(scope_), (d Diagnostic) -> d.Id == "GS0102")
        Assert.Empty(GetBinderDiagnostics(scope_))
    }

    @Fact
    func DuplicateNestedSimpleName_SameOuter_StillReportsGS0102() {
        let scope_ = BindSource("package p\nclass A { class Inner { var X int32 } class Inner { var Y int32 } }")
        Assert.Contains(GetBinderDiagnostics(scope_), (d Diagnostic) -> d.Id == "GS0102")
    }

    @Fact
    func DuplicatePackageLevelType_StillReportsGS0102() {
        let scope_ = BindSource(`package p
class Dup { var X int32 }
class Dup { var Y int32 }`)
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
