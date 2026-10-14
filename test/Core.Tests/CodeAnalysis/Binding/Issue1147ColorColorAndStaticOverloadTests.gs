// <copyright file="Issue1147ColorColorAndStaticOverloadTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1147: unified instance + static (`shared`) overload resolution in
/// two member-access scenarios.
/// - Facet A — the C# "Color Color" rule (ECMA-334 §12.8.7.1): a member-access receiver simple-name
/// that binds to BOTH an in-scope value AND a same-named type prefers the VALUE (instance access) when
/// an instance overload is applicable, instead of always doing static member resolution against the
/// type.
/// - Facet B — a bare unqualified call inside an instance method resolves against the COMBINED instance
/// + static overload set of the enclosing type, not only the instance overloads.
open class Issue1147ColorColorAndStaticOverloadTests {
    @Fact
    func FacetA_ColorColor_InstanceOverloadApplicable_BindsInstanceCall() {
        // The receiver `AppleListBox` binds to both the property value and the
        // same-named type. The string argument is applicable to the INSTANCE
        // overload `GetTagString(string)`, not the static `GetTagString(Tag?)`,
        // so the instance interpretation must win (no GS0155).
        let source = `package p
class Tag { }
class AppleListBox {
    func GetTagString(name string) string? { return nil }
    shared {
        func GetTagString(tagBox Tag?) string? { return nil }
    }
}
class Owner {
    prop AppleListBox AppleListBox {
        get { return AppleListBox() }
    }
    func Title() string? {
        return AppleListBox.GetTagString("title")
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func FacetA_ColorColor_OnlyStaticOverloadApplicable_BindsStaticCall() {
        // Same Color-Color receiver, but the argument (a `Tag?`) is applicable
        // only to the STATIC overload `GetTagString(Tag?)`, so unified
        // resolution must select the static overload and the call compiles.
        let source = `package p
class Tag { }
class AppleListBox {
    func GetTagString(name string) string? { return nil }
    shared {
        func GetTagString(tagBox Tag?) string? { return nil }
    }
}
class Owner {
    prop AppleListBox AppleListBox {
        get { return AppleListBox() }
    }
    func GetTag() Tag? { return nil }
    func Title() string? {
        return AppleListBox.GetTagString(GetTag())
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func FacetA_ColorColor_InstanceOnlyMethod_StillBindsInstance() {
        // The method exists ONLY as an instance overload (no `shared` sibling).
        // The Color-Color receiver must keep binding the value/instance call.
        let source = `package p
class AppleListBox {
    func GetTagString(name string) string? { return nil }
}
class Owner {
    prop AppleListBox AppleListBox {
        get { return AppleListBox() }
    }
    func Title() string? {
        return AppleListBox.GetTagString("title")
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func FacetB_UnqualifiedCall_SelectsStaticOverload() {
        // The bare unqualified call `GetTagString(GetTagBox(name))` passes a
        // `Tag?` which is applicable only to the static overload. Unified
        // instance + static resolution must select the static one (no GS0155).
        let source = `package p
class Tag { }
class Box {
    func GetTagString(name string) string? {
        return GetTagString(GetTagBox(name))
    }
    func GetTagBox(name string) Tag? { return nil }
    shared {
        func GetTagString(tagBox Tag?) string? { return nil }
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func FacetB_UnqualifiedCall_SelectsInstanceOverload() {
        // The same combined group, but a `string` argument is applicable only to
        // the instance overload — it must still bind the instance call.
        let source = `package p
class Tag { }
class Box {
    func Probe() string? {
        return GetTagString("name")
    }
    func GetTagString(name string) string? { return nil }
    shared {
        func GetTagString(tagBox Tag?) string? { return nil }
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func FacetB_UnqualifiedCall_StaticOnlySibling_Resolves() {
        // A bare unqualified call inside an instance method that names a method
        // declared ONLY as a `shared` sibling resolves against the static
        // overload (mirrors C# resolving the combined set).
        let source = `package p
class Box {
    func Probe() string? {
        return Helper("x")
    }
    shared {
        func Helper(name string) string? { return nil }
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Guardrail_StaticNotReachableThroughOrdinaryInstance() {
        // `box` is an ordinary parameter whose name is NOT also a type, so the
        // Color-Color rule does not apply. The static overload
        // `GetTagString(Tag?)` must remain unreachable: the only candidate is the
        // instance `GetTagString(string)`, so passing a `Tag?` fails to convert.
        let source = `package p
class Tag { }
class AppleListBox {
    func GetTagString(name string) string? { return nil }
    shared {
        func GetTagString(tagBox Tag?) string? { return nil }
    }
}
class Owner {
    func GetTag() Tag? { return nil }
    func Title(box AppleListBox) string? {
        return box.GetTagString(GetTag())
    }
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("Tag?") || d.Message.Contains("Tag"))
    }

    @Fact
    func Guardrail_UndefinedUnqualifiedName_ReportsUndefinedFunction() {
        let source = `package p
class Box {
    func M() string? {
        return TotallyUndefined("x")
    }
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("TotallyUndefined"))
    }

    @Fact
    func Guardrail_UnqualifiedCall_ArgMatchesNeitherOverload_Errors() {
        // The argument `42` is applicable to neither the instance
        // `GetTagString(string)` nor the static `GetTagString(Tag?)` overload —
        // the call must be rejected, never silently mis-bound.
        let source = `package p
class Tag { }
class Box {
    func GetTagString(name string) string? {
        return GetTagString(42)
    }
    shared {
        func GetTagString(tagBox Tag?) string? { return nil }
    }
}`
        Assert.NotEmpty(Bind(source))
    }

    shared {
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
    }
}
