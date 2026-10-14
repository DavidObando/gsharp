// <copyright file="Issue2342PackageScopedTypeCollisionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #2342: top-level declaration uniqueness must be scoped to the
/// DECLARING PACKAGE, not the whole compilation. Two top-level types (or
/// aliases) with the same simple name in DIFFERENT packages — including
/// packages that share a dotted prefix (`Foo` vs. `Foo.Bar`) — must
/// NOT collide with `GS0102`, and each package's own code must still
/// resolve its OWN same-simple-name type by unqualified reference (not the
/// first-declared package's homonym). A genuine duplicate (same simple name
/// declared twice in the SAME package, even across files) must still report
/// `GS0102`. This generalizes across classes, data classes/structs,
/// plain structs, enums, interfaces, and delegates, and must not regress the
/// nested-type scoping fix from #1080 or the generic-arity rules from #1051.
open class Issue2342PackageScopedTypeCollisionTests {
    @Fact
    func UnrelatedPackages_SameSimpleName_DoesNotCollide() {
        let scope_ = BindSource(
            "package Foo\nclass Shape0 { var Name string }",
            "package Baz\nclass Shape0 { var Width int32 }"
        )
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
        let shapes = scope_.Structs.Where((s StructSymbol) -> s.Name == "Shape0").ToList()
        Assert.Equal(2, shapes.Count)
        Assert.Contains(shapes, (s StructSymbol) -> s.PackageName == "Foo")
        Assert.Contains(shapes, (s StructSymbol) -> s.PackageName == "Baz")
    }

    @Fact
    func PrefixPackages_FooAndFooBar_DoesNotCollide() {
        // Package names that share a dotted prefix must not be conflated —
        // "Foo" and "Foo.Bar" are distinct packages, not nested namespaces of
        // one another for declaration-scope purposes.
        let scope_ = BindSource(
            "package Foo\nclass Widget { var A int32 }",
            "package Foo.Bar\nclass Widget { var B int32 }"
        )
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
        let widgets = scope_.Structs.Where((s StructSymbol) -> s.Name == "Widget").ToList()
        Assert.Equal(2, widgets.Count)
        Assert.Contains(widgets, (s StructSymbol) -> s.PackageName == "Foo")
        Assert.Contains(widgets, (s StructSymbol) -> s.PackageName == "Foo.Bar")
    }

    @Fact
    func SamePackageAcrossFiles_DuplicateSimpleName_StillReportsGS0102() {
        // Negative control: the SAME package split across two files must
        // still be treated as one declaration scope — a genuine duplicate
        // must not be silently accepted just because it lives in a second
        // file.
        let scope_ = BindSource(
            "package Foo\nclass Shape0 { var Name string }",
            "package Foo\nclass Shape0 { var Width int32 }"
        )
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
    }

    @Fact
    func SinglePackage_DuplicateSimpleName_SameFile_StillReportsGS0102() {
        let scope_ = BindSource(`package Foo
class Dup { var X int32 }
class Dup { var Y int32 }`)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
    }

    @Fact
    func NestedTypeCollision_CombinedWithPackageDifference_StillWorks() {
        // Combines the #1080 nested-type scoping fix with the #2342
        // package-scoping fix: a nested `Inner` under `A` in package `Foo`
        // must not collide with a TOP-LEVEL `Inner` declared in a different
        // package `Baz`, nor with another nested `Inner` under a differently
        // named outer in `Baz`.
        let scope_ = BindSource("package Foo\nclass A { class Inner { var X int32 } }", `package Baz
class Inner { var Y int32 }
class B { class Inner { var Z int32 } }`)
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
        let inners = scope_.Structs.Where((s StructSymbol) -> s.Name == "Inner").ToList()
        Assert.Equal(3, inners.Count)
        Assert.Contains(inners, (i StructSymbol) -> i.ContainingType?.Name == "A" && i.PackageName == "Foo")
        Assert.Contains(inners, (i StructSymbol) -> i.ContainingType == nil && i.PackageName == "Baz")
        Assert.Contains(inners, (i StructSymbol) -> i.ContainingType?.Name == "B" && i.PackageName == "Baz")
    }

    @Fact
    func GenericArity_SameSimpleName_DifferentPackages_DoesNotCollide() {
        // Issue #1051: arity is part of a generic type's declaration
        // identity. Confirm the package-scoping fix does not disturb
        // arity-based disambiguation when the packages also differ.
        let scope_ = BindSource("package Foo\nclass Box<T> { var Value T }", "package Baz\nclass Box<T> { var Item T }")
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
        let boxes = scope_.Structs.Where((s StructSymbol) -> s.Name == "Box").ToList()
        Assert.Equal(2, boxes.Count)
        Assert.Contains(boxes, (s StructSymbol) -> s.PackageName == "Foo")
        Assert.Contains(boxes, (s StructSymbol) -> s.PackageName == "Baz")
    }

    @Theory
    @InlineData("class Widget { var X int32 }")
    @InlineData("struct Widget { var X int32 }")
    @InlineData("data struct Widget(X int32) { }")
    @InlineData("enum Widget { Red, Green }")
    @InlineData("interface Widget { func Do() int32 }")
    @InlineData("delegate Widget() int32;")
    func EachSymbolKind_SameSimpleName_DifferentPackages_DoesNotCollide(decl string) {
        let scope_ = BindSource((`package Foo
` + "$decl"), (`package Baz
` + "$decl"))
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
    }

    shared {
        private func BindSource(sources ...string) BoundGlobalScope {
            let trees = sources.Select((s string) -> SyntaxTree.Parse(SourceText.From(s))).ToImmutableArray()
            return Binder.BindGlobalScope(previous: nil, trees)
        }
    }
}
