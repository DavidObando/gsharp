// <copyright file="Issue2342PackageScopedFunctionAndAliasTests.cs" company="GSharp">
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

/// Issue #2342 follow-up: the top-level declaration-uniqueness fix originally
/// scoped only `TryDeclareTypeAlias`/`IsSameDeclarationScope` (real
/// struct/enum/interface/delegate symbols) to the declaring package. Two
/// deferred gaps remained in the SAME shared, compilation-wide
/// (cref:BoundScope):
/// 1. Top-level FREE FUNCTIONS shared one flat, package-blind name→overload-set table
/// (`TryDeclareFunction`/`TryLookupFunctions`), so two unrelated packages that each declared a
/// same-simple-name, same-signature function collided as a spurious duplicate overload (`GS0264`), and
/// a same-name-different-signature pair silently merged into one cross-package overload set instead of
/// resolving independently per package.
/// 2. A plain `type Name = Target` alias has no dedicated symbol of its own — `target` IS the aliased
/// type — so its package identity for #2342 purposes was inferred (best-effort) from whatever package
/// the ALIASED TARGET belongs to, which is `null` for a primitive/imported/BCL target. Two unrelated
/// packages that each declared a same-simple-name alias to such a target were therefore
/// indistinguishable and collided as a spurious `GS0102`.
/// Both gaps are fixed by reusing the same package-aware key/ambient-package
/// mechanism introduced for #2342, without leaking ambient state across
/// binds. A genuine duplicate (same simple name, same declaring package) must
/// still report the correct diagnostic in both cases.
open class Issue2342PackageScopedFunctionAndAliasTests {
    @Fact
    func UnrelatedPackages_SameSimpleName_SameSignature_FreeFunction_DoesNotCollide() {
        // The exact GS0264 defect: two unrelated packages each declare a
        // free function with the identical name AND signature. This must
        // NOT be treated as a duplicate overload of one shared function.
        let scope_ = BindSource(
            "package Foo\nfunc Describe() string { return \"Foo\" }",
            "package Baz\nfunc Describe() string { return \"Baz\" }"
        )
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0264")
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
        let describers = scope_.Functions.Where((f FunctionSymbol) -> f.Name == "Describe").ToList()
        Assert.Equal(2, describers.Count)
        Assert.Contains(describers, (f FunctionSymbol) -> f.Package?.Name == "Foo")
        Assert.Contains(describers, (f FunctionSymbol) -> f.Package?.Name == "Baz")
    }

    @Fact
    func UnrelatedPackages_SameSimpleName_DifferentSignature_FreeFunction_DoesNotMergeOverloadSets() {
        // A same-name, DIFFERENT-signature pair across unrelated packages
        // must also resolve independently, not merge into a single
        // cross-package overload set.
        let scope_ = BindSource(
            "package Foo\nfunc Describe() string { return \"Foo\" }",
            "package Baz\nfunc Describe(x int32) string { return \"Baz\" }"
        )
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0264")
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
        let describers = scope_.Functions.Where((f FunctionSymbol) -> f.Name == "Describe").ToList()
        Assert.Equal(2, describers.Count)
        Assert.Contains(describers, (f FunctionSymbol) -> f.Package?.Name == "Foo" && f.Parameters.Length == 0)
        Assert.Contains(describers, (f FunctionSymbol) -> f.Package?.Name == "Baz" && f.Parameters.Length == 1)
    }

    @Fact
    func PrefixPackages_FooAndFooBar_FreeFunction_DoesNotCollide() {
        // Package names sharing a dotted prefix ("Foo" vs. "Foo.Bar") are
        // distinct packages, not nested namespaces of one another, matching
        // the type-scoping rule from #2342.
        let scope_ = BindSource(
            "package Foo\nfunc Describe() string { return \"Foo\" }",
            "package Foo.Bar\nfunc Describe() string { return \"Foo.Bar\" }"
        )
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0264")
        let describers = scope_.Functions.Where((f FunctionSymbol) -> f.Name == "Describe").ToList()
        Assert.Equal(2, describers.Count)
        Assert.Contains(describers, (f FunctionSymbol) -> f.Package?.Name == "Foo")
        Assert.Contains(describers, (f FunctionSymbol) -> f.Package?.Name == "Foo.Bar")
    }

    @Fact
    func SamePackageAcrossFiles_DuplicateSignature_FreeFunction_StillReportsGS0264() {
        // Negative control: the SAME package split across two files must
        // still enforce the existing overload-uniqueness rule.
        let scope_ = BindSource(
            "package Foo\nfunc Describe() string { return \"A\" }",
            "package Foo\nfunc Describe() string { return \"B\" }"
        )
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0264")
    }

    @Fact
    func SamePackage_DifferentSignature_FreeFunction_StillOverloads() {
        // Two functions with the same name but DIFFERENT signatures in the
        // SAME package must still coexist as ordinary overloads (ADR-0063
        // §11), unaffected by the package-scoping change.
        let scope_ = BindSource(`package Foo
func Describe() string { return "A" }
func Describe(x int32) string { return "B" }`)
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0264")
        let describers = scope_.Functions.Where((f FunctionSymbol) -> f.Name == "Describe").ToList()
        Assert.Equal(2, describers.Count)
    }

    @Fact
    func OwnPackageCall_ResolvesToOwnFunction_NotForeignPackageHomonym() {
        // The critical resolution-side check: a call FROM within package
        // Baz's own code must resolve to Baz's OWN "Describe", not Foo's
        // same-named, same-signature homonym (which — by source order —
        // would otherwise occupy the shared legacy lookup slot).
        let scope_ = BindSource("package Foo\nfunc Describe() string { return \"Foo\" }", `package Baz
func Describe() string { return "Baz" }
func CallDescribe() string { return Describe() }`)
        Assert.Empty(scope_.Diagnostics)
        let program = Binder.BindProgram(scope_)
        Assert.Empty(program.Diagnostics)
        let callDescribe = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "CallDescribe")
        let body = program.Functions[callDescribe]
        let returnStatement = cast[BoundReturnStatement](body.Statements.Single())
        let call = Assert.IsType[BoundCallExpression](returnStatement.Expression)
        Assert.Equal("Baz", call.Function.Package?.Name)
    }

    @Fact
    func UnrelatedPackages_SameSimpleName_PrimitiveAliasedAlias_DoesNotCollide() {
        // The exact alias defect: both packages alias a target with NO
        // package identity of its own (a primitive), so a best-effort
        // "infer package from target" scheme cannot tell them apart. The
        // alias's OWN declaring package must give it a stable identity.
        let scope_ = BindSource("package Foo\ntype Coord = int32", "package Baz\ntype Coord = int32")
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
        let coordKeys = scope_.TypeAliases.Keys.Where((k string) -> k.Contains("Coord")).ToList()
        Assert.Equal(2, coordKeys.Count)
    }

    @Fact
    func UnrelatedPackages_SameSimpleName_GenericAliasArity_DoesNotCollide() {
        // Issue #1051 interaction: a GENERIC alias's arity is part of its
        // declaration identity via the same arity-mangled storage key used
        // for real types. Confirm the alias package-scoping fix does not
        // disturb arity-based disambiguation when the packages also differ
        // — mirroring GenericArity_SameSimpleName_DifferentPackages_DoesNotCollide
        // in Issue2342PackageScopedTypeCollisionTests, but for aliases.
        let scope_ = BindSource(
            "package Foo\ndelegate Callback[T any]() T;",
            "package Baz\ndelegate Callback[T any]() T;"
        )
        Assert.Empty(scope_.Diagnostics)
        let callbackKeys = scope_.TypeAliases.Keys.Where((k string) -> k.Contains("Callback")).ToList()
        Assert.Equal(2, callbackKeys.Count)
    }

    @Fact
    func SamePackageAcrossFiles_DuplicateAlias_StillReportsGS0102() {
        // Negative control: the SAME package split across two files must
        // still be treated as one declaration scope for aliases too.
        let scope_ = BindSource("package Foo\ntype Coord = int32", "package Foo\ntype Coord = int64")
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
    }

    @Fact
    func SinglePackage_DuplicateAlias_SameFile_StillReportsGS0102() {
        let scope_ = BindSource(`package Foo
type Coord = int32
type Coord = int64`)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
    }

    @Fact
    func OwnPackageStructField_ResolvesOwnAlias_NotForeignPackageHomonym() {
        // The alias analog of the ambient-package-preference check: a struct
        // field typed through package Baz's OWN "Coord" alias must resolve to
        // Baz's own alias target (int64), not Foo's same-named alias
        // (int32), which — by source order — would otherwise occupy the
        // shared simple-name slot.
        let scope_ = BindSource("package Foo\ntype Coord = int32", `package Baz
type Coord = int64
class Point { var X Coord }`)
        Assert.Empty(scope_.Diagnostics)
        let point = scope_.Structs.Single((s StructSymbol) -> s.Name == "Point")
        let xField = point.Fields.Single((f FieldSymbol) -> f.Name == "X")
        Assert.Equal(TypeSymbol.Int64, xField.Type)
    }

    shared {
        private func BindSource(sources ...string) BoundGlobalScope {
            let trees = sources.Select((s string) -> SyntaxTree.Parse(SourceText.From(s))).ToImmutableArray()
            return Binder.BindGlobalScope(previous: nil, trees)
        }
    }
}
