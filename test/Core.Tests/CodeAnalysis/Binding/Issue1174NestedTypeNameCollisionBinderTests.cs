// <copyright file="Issue1174NestedTypeNameCollisionBinderTests.cs" company="GSharp">
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
/// Issue #1174: a source-declared nested type whose simple name collides with a
/// same-named top-level type must remain referenceable unambiguously via the
/// qualified form <c>Container.Nested</c> — in a struct-literal position
/// (<c>C.E{ ... }</c>), as a type clause (return type / variable type), and in a
/// generic-argument position (<c>List[C.E]</c>). The constructed value's members
/// must resolve against the NESTED type (no spurious <c>GS0158</c>). Follow-up to
/// #1080.
/// </summary>
public class Issue1174NestedTypeNameCollisionBinderTests
{
    [Fact]
    public void QualifiedStructLiteral_UnderCollision_ResolvesNestedMembers()
    {
        // R2: `C.E{X:1u}` must construct the NESTED E (with member X), not the
        // top-level E (with member Y), so `e.X` resolves without GS0158.
        var scope = BindSource("""
            package p
            class E { let Y int32 = 0 }
            class C { data struct E(X uint32) { } }
            func F() uint32 {
                let e = C.E{X: 1u}
                return e.X
            }
            """);

        Assert.DoesNotContain(GetBinderDiagnostics(scope), d => d.Id == "GS0158");
        Assert.Empty(GetBinderDiagnostics(scope));
    }

    [Fact]
    public void QualifiedTypeClause_ReturnType_UnderCollision_Binds()
    {
        var scope = BindSource("""
            package p
            class E { let Y int32 = 0 }
            class C { data struct E(X uint32) { } }
            func G() C.E { return C.E{X: 1u} }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));
    }

    [Fact]
    public void DeepQualifiedChain_WithOuterHomonym_Resolves()
    {
        // A.B.C names a nested data struct even though a top-level `C` shares the
        // deepest simple name.
        var scope = BindSource("""
            package p
            class C { data struct E(X uint32) { } }
            class A { class B { data struct C(Z uint32) { } } }
            func F() uint32 {
                let v = A.B.C{Z: 9u}
                return v.Z
            }
            """);

        Assert.DoesNotContain(GetBinderDiagnostics(scope), d => d.Id == "GS0158");
        Assert.Empty(GetBinderDiagnostics(scope));
    }

    [Fact]
    public void GenericNestedType_UnderCollision_Resolves()
    {
        var scope = BindSource("""
            package p
            class Box { let W int32 = 0 }
            class Outer { data struct Box[T](V T) { } }
            func F() uint32 {
                let b = Outer.Box[uint32]{V: 4u}
                return b.V
            }
            """);

        Assert.DoesNotContain(GetBinderDiagnostics(scope), d => d.Id == "GS0158");
        Assert.Empty(GetBinderDiagnostics(scope));
    }

    [Fact]
    public void QualifiedNestedInGenericArgumentPosition_UserGeneric_Resolves()
    {
        // R4 at the binder level using a user-defined generic container so no BCL
        // reference set is required: `Bag[C.E]` must bind the nested E as the
        // type argument.
        var scope = BindSource("""
            package p
            class E { let Y int32 = 0 }
            class C { data struct E(X uint32) { } }
            data struct Bag[T](Item T) { }
            func F() Bag[C.E] { return Bag[C.E]{Item: C.E{X: 1u}} }
            """);

        Assert.DoesNotContain(GetBinderDiagnostics(scope), d => d.Id == "GS0158");
        Assert.Empty(GetBinderDiagnostics(scope));
    }

    [Fact]
    public void NestedBySimpleName_NoCollision_StillWorks()
    {
        // Regression guard: with no top-level homonym the nested type keeps its
        // simple key and resolves by simple name.
        var scope = BindSource("""
            package p
            class C { data struct E(X uint32) { } }
            func F() uint32 {
                let e = E{X: 1u}
                return e.X
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));
    }

    [Fact]
    public void QualifiedNested_NoCollision_AsReturnType_StillWorks()
    {
        var scope = BindSource("""
            package p
            class C { data struct E(X uint32) { } }
            func G() C.E { return C.E{X: 1u} }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));
    }

    [Fact]
    public void CollidingTopLevelType_KeepsSimpleKey_NestedRetainsQualifiedKey()
    {
        var scope = BindSource("""
            package p
            class E { let Y int32 = 0 }
            class C { data struct E(X uint32) { } }
            """);

        Assert.DoesNotContain(GetBinderDiagnostics(scope), d => d.Id == "GS0102");

        // The top-level type holds the simple key.
        var topLevel = (StructSymbol)scope.TypeAliases["E"];
        Assert.Null(topLevel.ContainingType);

        // The nested type is retained as a distinct struct under its container.
        var nested = scope.Structs.Single(s => s.Name == "E" && s.ContainingType != null);
        Assert.Equal("C", nested.ContainingType.Name);
    }

    [Fact]
    public void DuplicateNestedSimpleName_SameContainer_StillReportsGS0102()
    {
        var scope = BindSource("""
            package p
            class C {
                data struct E(X uint32) { }
                data struct E(Y uint32) { }
            }
            """);

        Assert.Contains(GetBinderDiagnostics(scope), d => d.Id == "GS0102");
    }

    [Fact]
    public void DuplicateTopLevelType_StillReportsGS0102()
    {
        var scope = BindSource("""
            package p
            class E { let Y int32 = 0 }
            class E { let Z int32 = 0 }
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
