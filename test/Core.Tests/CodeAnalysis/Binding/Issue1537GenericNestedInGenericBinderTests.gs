// <copyright file="Issue1537GenericNestedInGenericBinderTests.cs" company="GSharp">
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
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1537: member access on a <b>generic</b> type nested inside a
/// <b>generic</b> type, constructed externally through the per-segment
/// type-clause syntax (`Outer[int32].Middle[string]`), failed at bind time
/// with `GS0159 Cannot find function` because the produced
/// (cref:StructSymbol) did not expose members whose signatures substitute
/// BOTH the enclosing type arguments (`U → int32`) and the nested type's
/// own arguments (`T → string`).
///
/// These tests assert the resolution binds without diagnostics AND that the
/// member types are substituted correctly: a function whose declared return
/// type equals the expected substituted member type only binds cleanly when the
/// substitution is correct (a wrong substitution surfaces a conversion
/// diagnostic). Symbol-level assertions confirm the constructed nested symbol
/// carries the enclosing arguments separately from its own arguments.
///
/// Each test uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed and not cleared between tests.
open class Issue1537GenericNestedInGenericBinderTests {
    @Fact
    func BaseRepro_MemberAccessOnGenericNestedInGeneric_BindsWithoutGs0159() {
        // The verbatim issue repro: before the fix this reported
        // `GS0159 Cannot find function Hello` (and a cascade for WriteLine).
        let diagnostics = GetDiagnostics(`package Issue1537BinderBase
import System
struct Issue1537BOuter[U any] {
    struct Issue1537BMiddle[T any] {
        var Label string
        func Hello() string { return "hi" }
    }
}
func Main() {
    var m = Issue1537BOuter[int32].Issue1537BMiddle[string]{Label: "x"}
    System.Console.WriteLine(m.Hello())
    System.Console.WriteLine(m.Label)
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func OwnTypeArgument_SubstitutesToConcreteType() {
        // The nested type's OWN parameter `T` must surface as `string` on the
        // construction: a field typed `T` read into a `string` return only
        // binds cleanly when `T → string`.
        let diagnostics = GetDiagnostics(`package Issue1537BinderOwn
struct Issue1537OwnOuter[U any] {
    struct Issue1537OwnMiddle[T any] {
        var Own T
    }
}
func GetOwn(m Issue1537OwnOuter[int32].Issue1537OwnMiddle[string]) string {
    return m.Own
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func EnclosingTypeArgument_SubstitutesToConcreteType() {
        // The ENCLOSING parameter `U` referenced by a nested member must surface
        // as `int32` on the construction: a field typed `U` read into an `int32`
        // return only binds cleanly when `U → int32` (a wrong `U → object`
        // substitution would report a conversion diagnostic).
        let diagnostics = GetDiagnostics(`package Issue1537BinderEnclosing
struct Issue1537EncOuter[U any] {
    struct Issue1537EncMiddle[T any] {
        var FromU U
        func Combine() U { return FromU }
    }
}
func GetFromU(m Issue1537EncOuter[int32].Issue1537EncMiddle[string]) int32 {
    return m.FromU
}
func GetCombine(m Issue1537EncOuter[int32].Issue1537EncMiddle[string]) int32 {
    return m.Combine()
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func MultiArityAtEachLevel_BindsWithoutDiagnostics() {
        let diagnostics = GetDiagnostics(`package Issue1537BinderMultiArity
struct Issue1537MAOuter[A any, B any] {
    struct Issue1537MAMiddle[C any, D any] {
        var First A
        var Third C
    }
}
func GetFirst(m Issue1537MAOuter[int32, bool].Issue1537MAMiddle[string, int64]) int32 {
    return m.First
}
func GetThird(m Issue1537MAOuter[int32, bool].Issue1537MAMiddle[string, int64]) string {
    return m.Third
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func TripleNesting_GenericInnermost_BindsWithoutDiagnostics() {
        let diagnostics = GetDiagnostics(`package Issue1537BinderTriple
struct Issue1537TOuter[U any] {
    struct Issue1537TMiddle[T any] {
        struct Issue1537TInner[W any] {
            var FromU U
            var FromT T
            var Own W
        }
    }
}
func GetU(i Issue1537TOuter[int32].Issue1537TMiddle[string].Issue1537TInner[bool]) int32 {
    return i.FromU
}
func GetT(i Issue1537TOuter[int32].Issue1537TMiddle[string].Issue1537TInner[bool]) string {
    return i.FromT
}
func GetOwn(i Issue1537TOuter[int32].Issue1537TMiddle[string].Issue1537TInner[bool]) bool {
    return i.Own
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Issue1521NonOwnParamsGuard_StillBindsWithoutDiagnostics() {
        // Guard: the #1521 case (a NON-generic nested type of a generic) must
        // keep binding — the #1537 combined-vector threading must not regress
        // the enclosing-only path.
        let diagnostics = GetDiagnostics(`package Issue1537BinderGuard
struct Issue1537GBox[T any] {
    var Value T
    struct Issue1537GTag { var Name string }
}
func GrabName(t Issue1537GBox[int32].Issue1537GTag) string {
    return t.Name
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func DeepestSegment_CarriesEnclosingAndOwnArguments() {
        // Symbol-level assertion: the constructed deepest segment
        // (`Outer[int32].Middle[string]`) is a constructed-nested reference that
        // carries the enclosing argument (`int32`) on EnclosingTypeArguments AND
        // its own argument (`string`) on TypeArguments, sharing the open nested
        // definition and the open enclosing type as its ContainingType.
        let scope_ = BindGlobalScope(`package Issue1537BinderSymbol
struct Issue1537SOuter[U any] {
    struct Issue1537SMiddle[T any] {
        var Own T
        var FromU U
    }
}
func Use(m Issue1537SOuter[int32].Issue1537SMiddle[string]) { }`)
        Assert.Empty(scope_.Diagnostics)
        let use = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "Use")
        let paramStruct = Assert.IsType[StructSymbol](use.Parameters.Single().Type)
        Assert.True(paramStruct.IsConstructedNestedType)
        Assert.Equal("Issue1537SMiddle", paramStruct.Name)
        let enclosingArg = Assert.Single(paramStruct.EnclosingTypeArguments)
        Assert.Equal("int32", enclosingArg.Name)
        let ownArg = Assert.Single(paramStruct.TypeArguments)
        Assert.Equal("string", ownArg.Name)
    }

    shared {
        private func GetDiagnostics(source string) IReadOnlyList[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics
        }

        private func BindGlobalScope(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }
    }
}
