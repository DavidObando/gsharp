// <copyright file="Issue910NestedTypeBinderTests.cs" company="GSharp">
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

/// Issue #910 / ADR-0110: binder coverage for nested type declarations. A
/// nested type is registered as a member of the enclosing type (its
/// (cref:StructSymbol.ContainingType) / (cref:EnumSymbol.ContainingType)
/// / (cref:InterfaceSymbol.ContainingType) is set) and resolves by simple
/// name from the enclosing type's members, for every nested kind (class, struct,
/// interface, enum) in either encloser (class or struct).
open class Issue910NestedTypeBinderTests {
    @Fact
    func NestedClassInClass_BindsWithoutDiagnostics_AndSetsContainingType() {
        let scope_ = BindSource(`class Outer {
    class Inner {
        func Hello() string {
            return "hi"
        }
    }

    func Make() string {
        let i = Inner()
        return i.Hello()
    }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
        let inner = cast[StructSymbol](scope_.TypeAliases["Inner"])
        let outer = cast[StructSymbol](scope_.TypeAliases["Outer"])
        Assert.Same(outer, inner.ContainingType)
    }

    @Fact
    func NestedStructInStruct_BindsWithoutDiagnostics_AndSetsContainingType() {
        let scope_ = BindSource(`struct Outer {
    struct Inner {
        var X int32
    }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
        let inner = cast[StructSymbol](scope_.TypeAliases["Inner"])
        let outer = cast[StructSymbol](scope_.TypeAliases["Outer"])
        Assert.Same(outer, inner.ContainingType)
        Assert.False(inner.IsClass)
    }

    @Fact
    func NestedEnumInClass_BindsWithoutDiagnostics_AndSetsContainingType() {
        let scope_ = BindSource(`class Outer {
    enum Color {
        Red,
        Green,
    }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
        let color = cast[EnumSymbol](scope_.TypeAliases["Color"])
        let outer = cast[StructSymbol](scope_.TypeAliases["Outer"])
        Assert.Same(outer, color.ContainingType)
    }

    @Fact
    func RecursivelyNestedClass_AllLevelsBind_AndContainingTypesChain() {
        let scope_ = BindSource(`class Outer {
    class Middle {
        class Inner {
            func N() int32 {
                return 7
            }
        }
    }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
        let outer = cast[StructSymbol](scope_.TypeAliases["Outer"])
        let middle = cast[StructSymbol](scope_.TypeAliases["Middle"])
        let inner = cast[StructSymbol](scope_.TypeAliases["Inner"])
        Assert.Same(outer, middle.ContainingType)
        Assert.Same(middle, inner.ContainingType)
    }

    @Fact
    func NestedClassInStruct_BindsWithoutDiagnostics_AndSetsContainingType() {
        let scope_ = BindSource(`struct Outer {
    class Inner {
        func Hello() string {
            return "hi"
        }
    }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
        let inner = cast[StructSymbol](scope_.TypeAliases["Inner"])
        let outer = cast[StructSymbol](scope_.TypeAliases["Outer"])
        Assert.Same(outer, inner.ContainingType)
        Assert.True(inner.IsClass)
        Assert.False(outer.IsClass)
    }

    @Fact
    func NestedInterfaceInClass_BindsWithoutDiagnostics_AndSetsContainingType() {
        let scope_ = BindSource(`class Outer {
    interface IInner {
        func Hello() string;
    }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
        let inner = cast[InterfaceSymbol](scope_.TypeAliases["IInner"])
        let outer = cast[StructSymbol](scope_.TypeAliases["Outer"])
        Assert.Same(outer, inner.ContainingType)
    }

    @Fact
    func NestedClassInClass_WithInitConstructor_BindsExplicitConstructor() {
        // Issue #920: a nested class that declares an `init()` constructor must
        // bind that constructor onto the nested StructSymbol just like a
        // top-level class, so the emitter can record its ctor handle.
        let scope_ = BindSource(`class Outer920 {
    class Inner920 {
        prop X int32
        init() {
            X = 5
        }
    }
}`)
        Assert.Empty(GetBinderDiagnostics(scope_))
        let inner = cast[StructSymbol](scope_.TypeAliases["Inner920"])
        let outer = cast[StructSymbol](scope_.TypeAliases["Outer920"])
        Assert.Same(outer, inner.ContainingType)
        Assert.True(inner.IsClass)
        Assert.NotNull(inner.ExplicitConstructor)
        Assert.Single(inner.ExplicitConstructors)
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
