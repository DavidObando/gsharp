// <copyright file="Issue1069NestedTypesTests.cs" company="GSharp">
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
/// Issue #1069: nested <c>struct</c>, <c>data struct</c>, and <c>enum</c>
/// declarations inside a class/struct must be registered into the enclosing
/// type's scope so they resolve by simple name (from the enclosing type and the
/// rest of the compilation) and by qualified name (<c>Outer.Entry</c>), are
/// constructible, and expose their members. Nested <c>class</c> already worked
/// and is covered here for regression.
/// </summary>
public class Issue1069NestedTypesTests
{
    [Fact]
    public void NestedDataStruct_ResolvesBySimpleName_AsReturnTypeAndConstructed()
    {
        var scope = BindSource("""
            package p
            open class Outer {
                func Make() Entry { return Entry(1u) }
                data struct Entry(X uint32) { }
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var entry = (StructSymbol)scope.TypeAliases["Entry"];
        var outer = (StructSymbol)scope.TypeAliases["Outer"];
        Assert.Same(outer, entry.ContainingType);
        Assert.True(entry.HasPrimaryConstructor);
    }

    [Fact]
    public void NestedDataStruct_ResolvesByQualifiedName()
    {
        var scope = BindSource("""
            package p
            open class Outer {
                func Make() Outer.Entry { return Outer.Entry(2u) }
                data struct Entry(X uint32) { }
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var entry = (StructSymbol)scope.TypeAliases["Entry"];
        var outer = (StructSymbol)scope.TypeAliases["Outer"];
        Assert.Same(outer, entry.ContainingType);
    }

    [Fact]
    public void NestedEnum_ResolvesBySimpleName()
    {
        var scope = BindSource("""
            package p
            open class Outer {
                func Make() Color { return Color.Red }
                enum Color { Red, Green }
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var color = (EnumSymbol)scope.TypeAliases["Color"];
        var outer = (StructSymbol)scope.TypeAliases["Outer"];
        Assert.Same(outer, color.ContainingType);
    }

    [Fact]
    public void NestedEnum_ResolvesByQualifiedName()
    {
        var scope = BindSource("""
            package p
            open class Outer {
                func Make() Outer.Color { return Outer.Color.Green }
                enum Color { Red, Green }
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var color = (EnumSymbol)scope.TypeAliases["Color"];
        var outer = (StructSymbol)scope.TypeAliases["Outer"];
        Assert.Same(outer, color.ContainingType);
    }

    [Fact]
    public void NestedPlainStruct_MembersResolve()
    {
        var scope = BindSource("""
            package p
            open class Outer {
                func Make() int32 {
                    let e = Entry{X: 1}
                    return e.X
                }
                struct Entry { var X int32 }
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var entry = (StructSymbol)scope.TypeAliases["Entry"];
        var outer = (StructSymbol)scope.TypeAliases["Outer"];
        Assert.Same(outer, entry.ContainingType);
        Assert.False(entry.IsClass);
    }

    [Fact]
    public void NestedClass_StillResolves_Regression()
    {
        var scope = BindSource("""
            package p
            open class Outer {
                func Make() int32 {
                    let e = Inner()
                    return e.X
                }
                class Inner { prop X int32 { get; init; } }
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var inner = (StructSymbol)scope.TypeAliases["Inner"];
        var outer = (StructSymbol)scope.TypeAliases["Outer"];
        Assert.Same(outer, inner.ContainingType);
        Assert.True(inner.IsClass);
    }

    [Fact]
    public void NestedTypes_UsableAsFieldAndArrayElement()
    {
        var scope = BindSource("""
            package p
            open class Outer {
                var First Entry
                func Many() []Entry { return [Entry(1u)] }
                data struct Entry(X uint32) { }
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var entry = (StructSymbol)scope.TypeAliases["Entry"];
        var outer = (StructSymbol)scope.TypeAliases["Outer"];
        Assert.Same(outer, entry.ContainingType);
    }

    [Fact]
    public void AbsentNestedType_ReportsTypeDoesNotExist()
    {
        var scope = BindSource("""
            package p
            open class Outer {
                func Make() Missing { return Missing(1u) }
                data struct Entry(X uint32) { }
            }
            """);

        Assert.Contains(GetBinderDiagnostics(scope), d => d.Id == "GS0113");
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
