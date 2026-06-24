// <copyright file="Issue1080NestedTypeNameCollisionTests.cs" company="GSharp">
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
/// Issue #1080: nested-type name uniqueness must be scoped to the ENCLOSING
/// type. Two nested types with the same simple name in DIFFERENT enclosing
/// types — or a nested type whose simple name matches a package-level type —
/// must NOT collide with <c>GS0102</c>. A genuine duplicate (same simple name in
/// the SAME enclosing type, or two package-level types of the same name) must
/// still report <c>GS0102</c>. Follow-up to #1069.
/// </summary>
public class Issue1080NestedTypeNameCollisionTests
{
    [Fact]
    public void SameNestedSimpleName_DifferentOuters_DoesNotCollide()
    {
        var scope = BindSource("""
            package p
            class A { class Inner { var X int32 } }
            class B { class Inner { var Y int32 } }
            """);

        Assert.DoesNotContain(GetBinderDiagnostics(scope), d => d.Id == "GS0102");
        Assert.Empty(GetBinderDiagnostics(scope));

        // Both nested types are retained as distinct declared structs, each with
        // the correct enclosing type.
        var inners = scope.Structs.Where(s => s.Name == "Inner").ToList();
        Assert.Equal(2, inners.Count);
        Assert.Contains(inners, i => i.ContainingType?.Name == "A");
        Assert.Contains(inners, i => i.ContainingType?.Name == "B");
    }

    [Fact]
    public void PackageLevelType_VersusNestedDataStruct_SameName_DoesNotCollide()
    {
        var scope = BindSource("""
            package p
            class SampleEntry { var A int32 }
            class SttsBox {
                data struct SampleEntry(FrameCount uint32, FrameDelta uint32) { }
            }
            """);

        Assert.DoesNotContain(GetBinderDiagnostics(scope), d => d.Id == "GS0102");
        Assert.Empty(GetBinderDiagnostics(scope));

        var entries = scope.Structs.Where(s => s.Name == "SampleEntry").ToList();
        Assert.Equal(2, entries.Count);

        // The package-level type stays resolvable by its simple name.
        var packageLevel = (StructSymbol)scope.TypeAliases["SampleEntry"];
        Assert.Null(packageLevel.ContainingType);

        // The nested type is retained under its qualified key and carries the
        // enclosing type.
        var nested = entries.Single(e => e.ContainingType != null);
        Assert.Equal("SttsBox", nested.ContainingType.Name);
    }

    [Theory]
    [InlineData("class Inner { var X int32 }")]
    [InlineData("struct Inner { var X int32 }")]
    [InlineData("data struct Inner(X uint32) { }")]
    [InlineData("enum Inner { Red, Green }")]
    public void SameNestedKind_DifferentOuters_DoesNotCollide(string nestedDecl)
    {
        var scope = BindSource($$"""
            package p
            class A { {{nestedDecl}} }
            class B { {{nestedDecl}} }
            """);

        Assert.DoesNotContain(GetBinderDiagnostics(scope), d => d.Id == "GS0102");
        Assert.Empty(GetBinderDiagnostics(scope));
    }

    [Fact]
    public void DuplicateNestedSimpleName_SameOuter_StillReportsGS0102()
    {
        var scope = BindSource("""
            package p
            class A { class Inner { var X int32 } class Inner { var Y int32 } }
            """);

        Assert.Contains(GetBinderDiagnostics(scope), d => d.Id == "GS0102");
    }

    [Fact]
    public void DuplicatePackageLevelType_StillReportsGS0102()
    {
        var scope = BindSource("""
            package p
            class Dup { var X int32 }
            class Dup { var Y int32 }
            """);

        Assert.Contains(GetBinderDiagnostics(scope), d => d.Id == "GS0102");
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static System.Collections.Generic.IEnumerable<GSharp.Core.CodeAnalysis.Diagnostic> GetBinderDiagnostics(BoundGlobalScope scope)
    {
        return scope.Diagnostics;
    }
}
