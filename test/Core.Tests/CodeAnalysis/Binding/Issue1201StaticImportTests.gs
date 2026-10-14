// <copyright file="Issue1201StaticImportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1201 / ADR-0134: a non-alias type import (`import Ns.Type`, the
/// G# spelling of C#'s `using static`) brings that type's `shared`
/// (static) members into scope for <em>unqualified</em> reference. These tests
/// pin the binder behaviour: unqualified calls and identifiers resolve to the
/// imported type's shared methods, generic shared methods, static fields/consts,
/// and static properties; a plain namespace import and an alias import do NOT
/// hoist members; and an unqualified name exposed by two imported types is an
/// ambiguity error (GS0414).
open class Issue1201StaticImportTests {
    @Fact
    func TypeImport_ExposesSharedMethod_ForUnqualifiedCall() {
        // The exact repro from the issue: `import p.aux.EnumUtil` lets the
        // caller invoke the shared `GetValues()` without the `EnumUtil.` prefix.
        let util = `package p.aux
class EnumUtil {
    shared {
        func GetValues() []int32 { return []int32{1, 2, 3} }
    }
}`
        let caller = `package p.main
import p.aux.EnumUtil
class C {
    func F() []int32 {
        return GetValues()
    }
}`
        Assert.Empty(Bind(util, caller))
    }

    @Fact
    func TypeImport_ExposesGenericSharedMethod_ForUnqualifiedCall() {
        // The Oahu impact: a generic shared method called unqualified with an
        // explicit type argument (`GetValues[int32]()`) must resolve through the
        // static import exactly as the qualified `EnumUtil.GetValues[int32]()`.
        let util = `package p.aux
class EnumUtil {
    shared {
        func GetValues[T any]() []T { return []T{} }
    }
}`
        let caller = `package p.main
import p.aux.EnumUtil
class C {
    func F() []int32 {
        return GetValues[int32]()
    }
}`
        Assert.Empty(Bind(util, caller))
    }

    @Fact
    func TypeImport_ExposesStaticFieldConstAndProperty_ForUnqualifiedRead() {
        let util = `package p.aux
class Config {
    shared {
        const Answer int32 = 42
        let Greeting string = "hi"
        prop Level int32 { get { return 7 } }
    }
}`
        let caller = `package p.main
import p.aux.Config
class C {
    func A() int32 { return Answer }
    func B() string { return Greeting }
    func D() int32 { return Level }
}`
        Assert.Empty(Bind(util, caller))
    }

    @Fact
    func NamespaceImport_DoesNotExposeSharedMembers() {
        // A plain namespace import (`import p.aux`) names no type, so the bare
        // call stays unresolved — GS0130 — matching C#, where `using p.aux`
        // (not `using static`) does not hoist members.
        let util = `package p.aux
class EnumUtil {
    shared {
        func GetValues() []int32 { return []int32{1, 2, 3} }
    }
}`
        let caller = `package p.main
import p.aux
class C {
    func F() []int32 {
        return GetValues()
    }
}`
        Assert.Contains(Bind(util, caller), (d Diagnostic) -> d.Id == "GS0130")
    }

    @Fact
    func AliasImport_DoesNotExposeSharedMembers() {
        // `import eu = p.aux.EnumUtil` is a type alias, not a static import, so
        // the bare call stays unresolved (mirroring C#, where `using X = T;`
        // does not hoist members). The alias is still usable qualified.
        let util = `package p.aux
class EnumUtil {
    shared {
        func GetValues() []int32 { return []int32{1, 2, 3} }
    }
}`
        let caller = `package p.main
import eu = p.aux.EnumUtil
class C {
    func F() []int32 {
        return GetValues()
    }
}`
        Assert.Contains(Bind(util, caller), (d Diagnostic) -> d.Id == "GS0130")
    }

    @Fact
    func AmbiguousSharedMember_AcrossTwoTypeImports_ReportsGS0414() {
        let util = `package p.aux
class A {
    shared { func Shared() int32 { return 1 } }
}
class B {
    shared { func Shared() int32 { return 2 } }
}`
        let caller = `package p.main
import p.aux.A
import p.aux.B
class C {
    func F() int32 {
        return Shared()
    }
}`
        Assert.Contains(Bind(util, caller), (d Diagnostic) -> d.Id == "GS0414")
    }

    @Fact
    func AmbiguousSharedMember_QualifyingDisambiguates() {
        // The same two imports are fine when the references are qualified: the
        // ambiguity is only reported when the bare name is actually used.
        let util = `package p.aux
class A {
    shared { func Shared() int32 { return 1 } }
}
class B {
    shared { func Shared() int32 { return 2 } }
}`
        let caller = `package p.main
import p.aux.A
import p.aux.B
class C {
    func F() int32 {
        return A.Shared() + B.Shared()
    }
}`
        Assert.Empty(Bind(util, caller))
    }

    shared {
        private func Bind(sources ...string) ImmutableArray[Diagnostic] {
            let trees = sources.Select((s string) -> SyntaxTree.Parse(SourceText.From(s))).ToImmutableArray()
            let parseDiagnostics = trees.SelectMany(
                func (t SyntaxTree) IEnumerable[Diagnostic] {
                    return t.Diagnostics
                }
            )
                .ToImmutableArray()
            if parseDiagnostics.Any() {
                return parseDiagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, trees)
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
