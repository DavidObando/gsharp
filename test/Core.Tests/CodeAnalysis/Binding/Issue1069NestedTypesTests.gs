// <copyright file="Issue1069NestedTypesTests.cs" company="GSharp">
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

/// Issue #1069: nested `struct`, `data struct`, and `enum`
/// declarations inside a class/struct must be registered into the enclosing
/// type's scope so they resolve by simple name (from the enclosing type and the
/// rest of the compilation) and by qualified name (`Outer.Entry`), are
/// constructible, and expose their members. Nested `class` already worked
/// and is covered here for regression.
open class Issue1069NestedTypesTests {
    @Fact
    func NestedDataStruct_ResolvesBySimpleName_AsReturnTypeAndConstructed() {
        let scope_ = BindSource(`package p
open class Outer {
    func Make() Entry { return Entry(1u) }
    data struct Entry(X uint32) { }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
        let entry = cast[StructSymbol](scope_.TypeAliases["Entry"])
        let outer = cast[StructSymbol](scope_.TypeAliases["Outer"])
        Assert.Same(outer, entry.ContainingType)
        Assert.True(entry.HasPrimaryConstructor)
    }

    @Fact
    func NestedDataStruct_ResolvesByQualifiedName() {
        let scope_ = BindSource(`package p
open class Outer {
    func Make() Outer.Entry { return Outer.Entry(2u) }
    data struct Entry(X uint32) { }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
        let entry = cast[StructSymbol](scope_.TypeAliases["Entry"])
        let outer = cast[StructSymbol](scope_.TypeAliases["Outer"])
        Assert.Same(outer, entry.ContainingType)
    }

    @Fact
    func NestedEnum_ResolvesBySimpleName() {
        let scope_ = BindSource(`package p
open class Outer {
    func Make() Color { return Color.Red }
    enum Color { Red, Green }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
        let color = cast[EnumSymbol](scope_.TypeAliases["Color"])
        let outer = cast[StructSymbol](scope_.TypeAliases["Outer"])
        Assert.Same(outer, color.ContainingType)
    }

    @Fact
    func NestedEnum_ResolvesByQualifiedName() {
        let scope_ = BindSource(`package p
open class Outer {
    func Make() Outer.Color { return Outer.Color.Green }
    enum Color { Red, Green }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
        let color = cast[EnumSymbol](scope_.TypeAliases["Color"])
        let outer = cast[StructSymbol](scope_.TypeAliases["Outer"])
        Assert.Same(outer, color.ContainingType)
    }

    @Fact
    func NestedPlainStruct_MembersResolve() {
        let scope_ = BindSource(`package p
open class Outer {
    func Make() int32 {
        let e = Entry{X: 1}
        return e.X
    }
    struct Entry { var X int32 }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
        let entry = cast[StructSymbol](scope_.TypeAliases["Entry"])
        let outer = cast[StructSymbol](scope_.TypeAliases["Outer"])
        Assert.Same(outer, entry.ContainingType)
        Assert.False(entry.IsClass)
    }

    @Fact
    func NestedClass_StillResolves_Regression() {
        let scope_ = BindSource(`package p
open class Outer {
    func Make() int32 {
        let e = Inner()
        return e.X
    }
    class Inner { prop X int32 { get; init; } }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
        let inner = cast[StructSymbol](scope_.TypeAliases["Inner"])
        let outer = cast[StructSymbol](scope_.TypeAliases["Outer"])
        Assert.Same(outer, inner.ContainingType)
        Assert.True(inner.IsClass)
    }

    @Fact
    func QualifiedNestedClassConstructor_ResolvesWhenSimpleNameCollides() {
        let scope_ = BindSource(`package p
class Helper { }
class Outer {
    class Helper { }
}
class Consumer {
    func Make() Outer.Helper {
        return Outer.Helper()
    }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
    }

    @Fact
    func NestedTypes_UsableAsFieldAndArrayElement() {
        let scope_ = BindSource(`package p
open class Outer {
    var First Entry
    func Many() []Entry { return [Entry(1u)] }
    data struct Entry(X uint32) { }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
        let entry = cast[StructSymbol](scope_.TypeAliases["Entry"])
        let outer = cast[StructSymbol](scope_.TypeAliases["Outer"])
        Assert.Same(outer, entry.ContainingType)
    }

    @Fact
    func AbsentNestedType_ReportsTypeDoesNotExist() {
        let scope_ = BindSource(`package p
open class Outer {
    func Make() Missing { return Missing(1u) }
    data struct Entry(X uint32) { }
}`)
        Assert.Contains(GetBinderDiagnostics(scope_), (d Diagnostic) -> d.Id == "GS0113")
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
