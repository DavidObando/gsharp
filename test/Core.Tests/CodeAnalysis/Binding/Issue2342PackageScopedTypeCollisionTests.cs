// <copyright file="Issue2342PackageScopedTypeCollisionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2342: top-level declaration uniqueness must be scoped to the
/// DECLARING PACKAGE, not the whole compilation. Two top-level types (or
/// aliases) with the same simple name in DIFFERENT packages — including
/// packages that share a dotted prefix (<c>Foo</c> vs. <c>Foo.Bar</c>) — must
/// NOT collide with <c>GS0102</c>, and each package's own code must still
/// resolve its OWN same-simple-name type by unqualified reference (not the
/// first-declared package's homonym). A genuine duplicate (same simple name
/// declared twice in the SAME package, even across files) must still report
/// <c>GS0102</c>. This generalizes across classes, data classes/structs,
/// plain structs, enums, interfaces, and delegates, and must not regress the
/// nested-type scoping fix from #1080 or the generic-arity rules from #1051.
/// </summary>
public class Issue2342PackageScopedTypeCollisionTests
{
    [Fact]
    public void UnrelatedPackages_SameSimpleName_DoesNotCollide()
    {
        var scope = BindSource(
            "package Foo\nclass Shape0 { var Name string }",
            "package Baz\nclass Shape0 { var Width int32 }");

        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0102");

        var shapes = scope.Structs.Where(s => s.Name == "Shape0").ToList();
        Assert.Equal(2, shapes.Count);
        Assert.Contains(shapes, s => s.PackageName == "Foo");
        Assert.Contains(shapes, s => s.PackageName == "Baz");
    }

    [Fact]
    public void PrefixPackages_FooAndFooBar_DoesNotCollide()
    {
        // Package names that share a dotted prefix must not be conflated —
        // "Foo" and "Foo.Bar" are distinct packages, not nested namespaces of
        // one another for declaration-scope purposes.
        var scope = BindSource(
            "package Foo\nclass Widget { var A int32 }",
            "package Foo.Bar\nclass Widget { var B int32 }");

        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0102");

        var widgets = scope.Structs.Where(s => s.Name == "Widget").ToList();
        Assert.Equal(2, widgets.Count);
        Assert.Contains(widgets, s => s.PackageName == "Foo");
        Assert.Contains(widgets, s => s.PackageName == "Foo.Bar");
    }

    [Fact]
    public void SamePackageAcrossFiles_DuplicateSimpleName_StillReportsGS0102()
    {
        // Negative control: the SAME package split across two files must
        // still be treated as one declaration scope — a genuine duplicate
        // must not be silently accepted just because it lives in a second
        // file.
        var scope = BindSource(
            "package Foo\nclass Shape0 { var Name string }",
            "package Foo\nclass Shape0 { var Width int32 }");

        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0102");
    }

    [Fact]
    public void SinglePackage_DuplicateSimpleName_SameFile_StillReportsGS0102()
    {
        var scope = BindSource("""
            package Foo
            class Dup { var X int32 }
            class Dup { var Y int32 }
            """);

        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0102");
    }

    [Fact]
    public void NestedTypeCollision_CombinedWithPackageDifference_StillWorks()
    {
        // Combines the #1080 nested-type scoping fix with the #2342
        // package-scoping fix: a nested `Inner` under `A` in package `Foo`
        // must not collide with a TOP-LEVEL `Inner` declared in a different
        // package `Baz`, nor with another nested `Inner` under a differently
        // named outer in `Baz`.
        var scope = BindSource(
            "package Foo\nclass A { class Inner { var X int32 } }",
            "package Baz\nclass Inner { var Y int32 }\nclass B { class Inner { var Z int32 } }");

        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0102");

        var inners = scope.Structs.Where(s => s.Name == "Inner").ToList();
        Assert.Equal(3, inners.Count);
        Assert.Contains(inners, i => i.ContainingType?.Name == "A" && i.PackageName == "Foo");
        Assert.Contains(inners, i => i.ContainingType == null && i.PackageName == "Baz");
        Assert.Contains(inners, i => i.ContainingType?.Name == "B" && i.PackageName == "Baz");
    }

    [Fact]
    public void GenericArity_SameSimpleName_DifferentPackages_DoesNotCollide()
    {
        // Issue #1051: arity is part of a generic type's declaration
        // identity. Confirm the package-scoping fix does not disturb
        // arity-based disambiguation when the packages also differ.
        var scope = BindSource(
            "package Foo\nclass Box<T> { var Value T }",
            "package Baz\nclass Box<T> { var Item T }");

        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0102");

        var boxes = scope.Structs.Where(s => s.Name == "Box").ToList();
        Assert.Equal(2, boxes.Count);
        Assert.Contains(boxes, s => s.PackageName == "Foo");
        Assert.Contains(boxes, s => s.PackageName == "Baz");
    }

    [Theory]
    [InlineData("class Widget { var X int32 }")]
    [InlineData("struct Widget { var X int32 }")]
    [InlineData("data struct Widget(X int32) { }")]
    [InlineData("enum Widget { Red, Green }")]
    [InlineData("interface Widget { func Do() int32 }")]
    [InlineData("type Widget = delegate func() int32")]
    public void EachSymbolKind_SameSimpleName_DifferentPackages_DoesNotCollide(string decl)
    {
        var scope = BindSource(
            $"package Foo\n{decl}",
            $"package Baz\n{decl}");

        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0102");
    }

    private static BoundGlobalScope BindSource(params string[] sources)
    {
        var trees = sources.Select(s => SyntaxTree.Parse(SourceText.From(s))).ToImmutableArray();
        return Binder.BindGlobalScope(previous: null, trees);
    }
}
