// <copyright file="Issue2419QualifiedSourceTypeNamespaceShadowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Linq
import Xunit

/// Issue #2419: `TryBindQualifiedSourceTypeConstruction` (and the
/// sibling `PeelNamespacePrefix` used for constructed-generic-type
/// assignment targets) peel a redundant package prefix off a fully-qualified,
/// same-compilation source-type construction one dotted segment at a time via
/// `IsNamespacePrefixSegment`. That helper required EVERY peeled segment
/// — not just the first — to fail lookup as an in-scope value/type/import.
/// When an unrelated in-scope value (e.g. a `const` field on the
/// enclosing type) happened to share its simple name with a middle or trailing
/// segment of the qualified package path (e.g. `Oahu.Audible.Json.Author`
/// where the enclosing `AaxExporter` class also declares
/// `private const Json string = ".json"`), peeling stopped one segment
/// short of the construction terminal, and the whole qualified name failed to
/// bind — reported as GS0157 "Cannot find type" against the leftmost segment.
///
/// The fix restricts the in-scope-value shadow check to the FIRST peeled
/// segment (which is what correctly protects a genuine value-access chain,
/// e.g. `myValue.Foo.Ctor()`, from being misinterpreted as a namespace
/// prefix) and ignores value shadowing for later segments, since once the
/// first segment has been accepted as a namespace component the chain can no
/// longer be a value-access chain at all. The type-alias/import/imported-class
/// checks are unchanged and still gate every segment, so this does not affect
/// disambiguation between same-simple-name types declared in different
/// packages — the terminal type is still resolved exactly as it was for the
/// already-supported unshadowed case.
open class Issue2419QualifiedSourceTypeNamespaceShadowTests {
    @Fact
    func QualifiedStructLiteral_ShadowedByConstFieldOnEnclosingType_Binds() {
        // Mirrors the exact real-world shape: AaxExporter declares
        // `private const Json string = ".json"`, and separately constructs
        // `Oahu.Audible.Json.Author{...}` — the const's simple name ("Json")
        // collides with the namespace's terminal package segment.
        const source = `package Oahu.Audible.Json
import Oahu.Audible.Json

class Author {
    prop Asin string
    prop Name string
}`
        const consumer = `package Oahu.Core
import Oahu.Audible.Json

class AaxExporter {
    func Make() Oahu.Audible.Json.Author {
        return Oahu.Audible.Json.Author{Asin: "x", Name: "y"}
    }

    private const Json string = ".json"
}`
        let compilation = Compile(source, consumer)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func QualifiedConstructorCall_ShadowedByConstFieldOnEnclosingType_Binds() {
        const source = `package Oahu.Audible.Json

class ChapterInfo {
    func Hello() int32 -> 42
}`
        const consumer = `package Oahu.Core
import Oahu.Audible.Json

class AaxExporter {
    func Make() int32 {
        let ci = Oahu.Audible.Json.ChapterInfo()
        return ci.Hello()
    }

    private const Json string = ".json"
}`
        let compilation = Compile(source, consumer)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func QualifiedStructLiteral_ShadowedByLocalVariableInSameMethod_Binds() {
        // The shadow does not have to be a class-level field — an ordinary
        // local variable earlier in the same method whose name matches a
        // middle namespace segment must not stop peeling either.
        const source = `package App.Models

class Foo {
    prop X int32
}`
        const consumer = `package App
import App.Models

func Make() int32 {
    let Models = 7
    let f = App.Models.Foo{X: Models}
    return f.X
}`
        let compilation = Compile(source, consumer)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func QualifiedGenericTypeArgument_ShadowedByConstFieldOnEnclosingType_Binds() {
        // Type clauses and generic type arguments already went through a
        // separate, unaffected binding path — this pins that they remain
        // unaffected by the fix (and were never broken by the shadow).
        const source = `package App.Models

class Foo {
    prop X int32
}`
        const consumer = `package App
import App.Models
import System.Collections.Generic

class Widget {
    func Make() int32 {
        let list = List[App.Models.Foo]()
        list.Add(App.Models.Foo{X: 9})
        return list[0].X
    }

    private const Models string = ".models"
}`
        let compilation = Compile(source, consumer)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func QualifiedTypeClauseAnnotation_ShadowedByConstFieldOnEnclosingType_Binds() {
        const source = `package App.Models

class Foo {
    prop X int32
}`
        const consumer = `package App
import App.Models

class Widget {
    func Make() int32 {
        let f App.Models.Foo = App.Models.Foo{X: 5}
        return f.X
    }

    private const Models string = ".models"
}`
        let compilation = Compile(source, consumer)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func QualifiedStructLiteral_AsParameterAndReturn_ShadowedByConstField_Binds() {
        const source = `package App.Models

class Foo {
    prop X int32
}`
        const consumer = `package App
import App.Models

class Widget {
    func Echo(f App.Models.Foo) App.Models.Foo {
        return f
    }

    func Make() int32 {
        return this.Echo(App.Models.Foo{X: 11}).X
    }

    private const Models string = ".models"
}`
        let compilation = Compile(source, consumer)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func QualifiedStructLiteral_InArrayInitializer_ShadowedByConstField_Binds() {
        const source = `package App.Models

class Foo {
    prop X int32
}`
        const consumer = `package App
import App.Models

class Widget {
    func Make() int32 {
        let items = []App.Models.Foo{App.Models.Foo{X: 1}, App.Models.Foo{X: 2}}
        return items[0].X + items[1].X
    }

    private const Models string = ".models"
}`
        let compilation = Compile(source, consumer)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func QualifiedStructLiteral_ShadowedByConstField_DisambiguatesFromSameSimpleNameInSiblingPackage() {
        // Combines the shadow with a genuine same-simple-name collision across
        // sibling packages (the real Oahu.Audible.Json.Author vs.
        // Oahu.BooksDatabase.Author shape) to prove the fix does not fall back
        // to a flat/ambiguous simple-name resolution: the qualified
        // construction must still bind to the SPECIFIC package's type, not
        // whichever same-named type happens to resolve first.
        const source = `package Oahu.Audible.Json

class Author {
    prop Asin string
    prop Name string
}`
        const other = `package Oahu.BooksDatabase

class Author {
    prop Id int32
}`
        const consumer = `package Oahu.Core
import Oahu.Audible.Json
import Oahu.BooksDatabase

class AaxExporter {
    func Make() string {
        let a = Oahu.Audible.Json.Author{Asin: "x", Name: "y"}
        return a.Name
    }

    private const Json string = ".json"
}`
        let compilation = Compile(source, other, consumer)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func UnqualifiedValueAccessChain_WithGenuineFirstSegmentValue_IsNotMisboundAsNamespace() {
        // Negative/ambiguity control: when the FIRST segment of a dotted chain
        // genuinely is an in-scope value, the chain must still be bound as an
        // ordinary member-access/call on that value — never reinterpreted as a
        // namespace-prefixed type construction. This protects the existing,
        // unchanged first-segment shadow check.
        const source = `package App

class Holder {
    prop Value int32
}

func Make() int32 {
    let Holder = App.Holder{Value: 3}
    return Holder.Value
}`
        let compilation = Compile(source)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    shared {
        private func Compile(sources ...string) Compilation {
            let trees = sources.Select((s string) -> SyntaxTree.Parse(SourceText.From(s))).ToArray()
            return Compilation(trees){IsLibrary = true}
        }
    }
}
