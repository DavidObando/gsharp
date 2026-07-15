// <copyright file="Issue2342PackageScopedFunctionAndAliasTests.cs" company="GSharp">
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
/// Issue #2342 follow-up: the top-level declaration-uniqueness fix originally
/// scoped only <c>TryDeclareTypeAlias</c>/<c>IsSameDeclarationScope</c> (real
/// struct/enum/interface/delegate symbols) to the declaring package. Two
/// deferred gaps remained in the SAME shared, compilation-wide
/// <see cref="BoundScope"/>:
/// <list type="number">
/// <item><description>Top-level FREE FUNCTIONS shared one flat, package-blind
/// name→overload-set table (<c>TryDeclareFunction</c>/<c>TryLookupFunctions</c>),
/// so two unrelated packages that each declared a same-simple-name,
/// same-signature function collided as a spurious duplicate overload
/// (<c>GS0264</c>), and a same-name-different-signature pair silently merged
/// into one cross-package overload set instead of resolving independently per
/// package.</description></item>
/// <item><description>A plain <c>type Name = Target</c> alias has no
/// dedicated symbol of its own — <c>target</c> IS the aliased type — so its
/// package identity for #2342 purposes was inferred (best-effort) from
/// whatever package the ALIASED TARGET belongs to, which is <c>null</c> for a
/// primitive/imported/BCL target. Two unrelated packages that each declared a
/// same-simple-name alias to such a target were therefore indistinguishable
/// and collided as a spurious <c>GS0102</c>.</description></item>
/// </list>
/// Both gaps are fixed by reusing the same package-aware key/ambient-package
/// mechanism introduced for #2342, without leaking ambient state across
/// binds. A genuine duplicate (same simple name, same declaring package) must
/// still report the correct diagnostic in both cases.
/// </summary>
public class Issue2342PackageScopedFunctionAndAliasTests
{
    [Fact]
    public void UnrelatedPackages_SameSimpleName_SameSignature_FreeFunction_DoesNotCollide()
    {
        // The exact GS0264 defect: two unrelated packages each declare a
        // free function with the identical name AND signature. This must
        // NOT be treated as a duplicate overload of one shared function.
        var scope = BindSource(
            "package Foo\nfunc Describe() string { return \"Foo\" }",
            "package Baz\nfunc Describe() string { return \"Baz\" }");

        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0264");
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0102");

        var describers = scope.Functions.Where(f => f.Name == "Describe").ToList();
        Assert.Equal(2, describers.Count);
        Assert.Contains(describers, f => f.Package?.Name == "Foo");
        Assert.Contains(describers, f => f.Package?.Name == "Baz");
    }

    [Fact]
    public void UnrelatedPackages_SameSimpleName_DifferentSignature_FreeFunction_DoesNotMergeOverloadSets()
    {
        // A same-name, DIFFERENT-signature pair across unrelated packages
        // must also resolve independently, not merge into a single
        // cross-package overload set.
        var scope = BindSource(
            "package Foo\nfunc Describe() string { return \"Foo\" }",
            "package Baz\nfunc Describe(x int32) string { return \"Baz\" }");

        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0264");
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0102");

        var describers = scope.Functions.Where(f => f.Name == "Describe").ToList();
        Assert.Equal(2, describers.Count);
        Assert.Contains(describers, f => f.Package?.Name == "Foo" && f.Parameters.Length == 0);
        Assert.Contains(describers, f => f.Package?.Name == "Baz" && f.Parameters.Length == 1);
    }

    [Fact]
    public void PrefixPackages_FooAndFooBar_FreeFunction_DoesNotCollide()
    {
        // Package names sharing a dotted prefix ("Foo" vs. "Foo.Bar") are
        // distinct packages, not nested namespaces of one another, matching
        // the type-scoping rule from #2342.
        var scope = BindSource(
            "package Foo\nfunc Describe() string { return \"Foo\" }",
            "package Foo.Bar\nfunc Describe() string { return \"Foo.Bar\" }");

        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0264");

        var describers = scope.Functions.Where(f => f.Name == "Describe").ToList();
        Assert.Equal(2, describers.Count);
        Assert.Contains(describers, f => f.Package?.Name == "Foo");
        Assert.Contains(describers, f => f.Package?.Name == "Foo.Bar");
    }

    [Fact]
    public void SamePackageAcrossFiles_DuplicateSignature_FreeFunction_StillReportsGS0264()
    {
        // Negative control: the SAME package split across two files must
        // still enforce the existing overload-uniqueness rule.
        var scope = BindSource(
            "package Foo\nfunc Describe() string { return \"A\" }",
            "package Foo\nfunc Describe() string { return \"B\" }");

        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0264");
    }

    [Fact]
    public void SamePackage_DifferentSignature_FreeFunction_StillOverloads()
    {
        // Two functions with the same name but DIFFERENT signatures in the
        // SAME package must still coexist as ordinary overloads (ADR-0063
        // §11), unaffected by the package-scoping change.
        var scope = BindSource("""
            package Foo
            func Describe() string { return "A" }
            func Describe(x int32) string { return "B" }
            """);

        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0264");

        var describers = scope.Functions.Where(f => f.Name == "Describe").ToList();
        Assert.Equal(2, describers.Count);
    }

    [Fact]
    public void OwnPackageCall_ResolvesToOwnFunction_NotForeignPackageHomonym()
    {
        // The critical resolution-side check: a call FROM within package
        // Baz's own code must resolve to Baz's OWN "Describe", not Foo's
        // same-named, same-signature homonym (which — by source order —
        // would otherwise occupy the shared legacy lookup slot).
        var scope = BindSource(
            "package Foo\nfunc Describe() string { return \"Foo\" }",
            """
            package Baz
            func Describe() string { return "Baz" }
            func CallDescribe() string { return Describe() }
            """);

        Assert.Empty(scope.Diagnostics);

        var program = Binder.BindProgram(scope);
        Assert.Empty(program.Diagnostics);

        var callDescribe = scope.Functions.Single(f => f.Name == "CallDescribe");
        var body = program.Functions[callDescribe];
        var returnStatement = (BoundReturnStatement)body.Statements.Single();
        var call = Assert.IsType<BoundCallExpression>(returnStatement.Expression);
        Assert.Equal("Baz", call.Function.Package?.Name);
    }

    [Fact]
    public void UnrelatedPackages_SameSimpleName_PrimitiveAliasedAlias_DoesNotCollide()
    {
        // The exact alias defect: both packages alias a target with NO
        // package identity of its own (a primitive), so a best-effort
        // "infer package from target" scheme cannot tell them apart. The
        // alias's OWN declaring package must give it a stable identity.
        var scope = BindSource(
            "package Foo\ntype Coord = int32",
            "package Baz\ntype Coord = int32");

        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0102");

        var coordKeys = scope.TypeAliases.Keys.Where(k => k.Contains("Coord")).ToList();
        Assert.Equal(2, coordKeys.Count);
    }

    [Fact]
    public void UnrelatedPackages_SameSimpleName_GenericAliasArity_DoesNotCollide()
    {
        // Issue #1051 interaction: a GENERIC alias's arity is part of its
        // declaration identity via the same arity-mangled storage key used
        // for real types. Confirm the alias package-scoping fix does not
        // disturb arity-based disambiguation when the packages also differ
        // — mirroring GenericArity_SameSimpleName_DifferentPackages_DoesNotCollide
        // in Issue2342PackageScopedTypeCollisionTests, but for aliases.
        var scope = BindSource(
            "package Foo\ntype Callback[T any] = delegate func() T",
            "package Baz\ntype Callback[T any] = delegate func() T");

        Assert.Empty(scope.Diagnostics);

        var callbackKeys = scope.TypeAliases.Keys.Where(k => k.Contains("Callback")).ToList();
        Assert.Equal(2, callbackKeys.Count);
    }




    [Fact]
    public void SamePackageAcrossFiles_DuplicateAlias_StillReportsGS0102()
    {
        // Negative control: the SAME package split across two files must
        // still be treated as one declaration scope for aliases too.
        var scope = BindSource(
            "package Foo\ntype Coord = int32",
            "package Foo\ntype Coord = int64");

        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0102");
    }

    [Fact]
    public void SinglePackage_DuplicateAlias_SameFile_StillReportsGS0102()
    {
        var scope = BindSource("""
            package Foo
            type Coord = int32
            type Coord = int64
            """);

        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0102");
    }

    [Fact]
    public void OwnPackageStructField_ResolvesOwnAlias_NotForeignPackageHomonym()
    {
        // The alias analog of the ambient-package-preference check: a struct
        // field typed through package Baz's OWN "Coord" alias must resolve to
        // Baz's own alias target (int64), not Foo's same-named alias
        // (int32), which — by source order — would otherwise occupy the
        // shared simple-name slot.
        var scope = BindSource(
            "package Foo\ntype Coord = int32",
            """
            package Baz
            type Coord = int64
            class Point { var X Coord }
            """);

        Assert.Empty(scope.Diagnostics);

        var point = scope.Structs.Single(s => s.Name == "Point");
        var xField = point.Fields.Single(f => f.Name == "X");
        Assert.Equal(TypeSymbol.Int64, xField.Type);
    }

    private static BoundGlobalScope BindSource(params string[] sources)
    {
        var trees = sources.Select(s => SyntaxTree.Parse(SourceText.From(s))).ToImmutableArray();
        return Binder.BindGlobalScope(previous: null, trees);
    }
}
