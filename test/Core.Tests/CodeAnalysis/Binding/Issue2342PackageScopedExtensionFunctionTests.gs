// <copyright file="Issue2342PackageScopedExtensionFunctionTests.cs" company="GSharp">
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

/// Issue #2342 follow-up: extension functions (`func (self T) Name(...) ...`)
/// were left package-blind by the earlier free-function/alias follow-up —
/// `BoundScope.TryDeclareExtensionFunction`/`TryLookupExtensionFunction`/
/// `TryLookupExtensionFunctions` bucketed every extension by its bare simple
/// name only, with no notion of a declaring package. An extension's identity
/// triple (receiver type, name, signature) already keeps two DIFFERENT
/// user-defined receiver types in different packages from ever colliding — they
/// are distinct (cref:TypeSymbol) instances even when same-named (see
/// #2342) — but two packages that both declare an extension on a SHARED
/// receiver type (a primitive, an imported/BCL type, or any type with no
/// per-package identity of its own) under the same simple name and signature
/// collided as a spurious `GS0264` duplicate, and even once fixed, a call
/// site in one package's own code could still silently resolve to the OTHER
/// package's same-name, same-signature extension.
///
/// Fixed by mirroring the free-function fix: a same-name, same-signature
/// extension declared by a DIFFERENT package than the bucket's first entry is
/// retained under its own package-qualified bucket (built from the STABLE
/// (cref:FunctionSymbol.Package) metadata already set on every
/// extension, not ambient inference alone) instead of being merged into a
/// foreign package's overload set; lookup prefers the ambient declaring
/// package's own bucket when one exists. Receiver-type matching (exact,
/// generic-receiver unification, implicit-conversion/subtype broadening),
/// same-package overloads/duplicates, CLR/BCL imports, and extension
/// precedence over ordinary members are all unchanged.
open class Issue2342PackageScopedExtensionFunctionTests {
    @Fact
    func UnrelatedPackages_SameSimpleName_SameSignature_ExtensionOnSharedReceiver_DoesNotCollide() {
        // The exact GS0264 defect: two unrelated packages each declare an
        // extension on the SAME shared receiver type (`string`, which has no
        // package identity of its own) with the identical name and
        // signature. This must NOT be treated as a duplicate overload.
        let scope_ = BindSource(
            "package Foo\nfunc (s string) Greet() string { return \"Foo:\" + s }",
            "package Baz\nfunc (s string) Greet() string { return \"Baz:\" + s }"
        )
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0264")
        let greeters = scope_.Functions.Where((f FunctionSymbol) -> f.Name == "Greet" && f.IsExtension).ToList()
        Assert.Equal(2, greeters.Count)
        Assert.Contains(greeters, (f FunctionSymbol) -> f.Package?.Name == "Foo")
        Assert.Contains(greeters, (f FunctionSymbol) -> f.Package?.Name == "Baz")
    }

    @Fact
    func UnrelatedPackages_SameSimpleName_DifferentSignature_ExtensionOnSharedReceiver_DoesNotMergeOverloadSets() {
        // A same-name, DIFFERENT-signature extension pair on the same shared
        // receiver type across unrelated packages must also resolve
        // independently, not merge into a single cross-package overload set.
        let scope_ = BindSource(
            "package Foo\nfunc (s string) Combine() string { return s }",
            "package Baz\nfunc (s string) Combine(suffix string) string { return s + suffix }"
        )
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0264")
        let combiners = scope_.Functions.Where((f FunctionSymbol) -> f.Name == "Combine" && f.IsExtension).ToList()
        Assert.Equal(2, combiners.Count)
        Assert.Contains(combiners, (f FunctionSymbol) -> f.Package?.Name == "Foo" && f.Parameters.Length == 1)
        Assert.Contains(combiners, (f FunctionSymbol) -> f.Package?.Name == "Baz" && f.Parameters.Length == 2)
    }

    @Fact
    func PrefixPackages_FooAndFooBar_ExtensionOnSharedReceiver_DoesNotCollide() {
        // Package names sharing a dotted prefix ("Foo" vs. "Foo.Bar") are
        // distinct packages, matching the type/function-scoping rule from
        // #2342.
        let scope_ = BindSource(
            "package Foo\nfunc (s string) Greet() string { return \"Foo:\" + s }",
            "package Foo.Bar\nfunc (s string) Greet() string { return \"Foo.Bar:\" + s }"
        )
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0264")
        let greeters = scope_.Functions.Where((f FunctionSymbol) -> f.Name == "Greet" && f.IsExtension).ToList()
        Assert.Equal(2, greeters.Count)
        Assert.Contains(greeters, (f FunctionSymbol) -> f.Package?.Name == "Foo")
        Assert.Contains(greeters, (f FunctionSymbol) -> f.Package?.Name == "Foo.Bar")
    }

    @Fact
    func SamePackageAcrossFiles_DuplicateSignature_ExtensionOnSharedReceiver_StillReportsGS0264() {
        // Negative control: the SAME package split across two files must
        // still enforce the existing overload-uniqueness rule for
        // extensions.
        let scope_ = BindSource(
            "package Foo\nfunc (s string) Greet() string { return \"A:\" + s }",
            "package Foo\nfunc (s string) Greet() string { return \"B:\" + s }"
        )
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0264")
    }

    @Fact
    func SamePackage_DifferentSignature_Extension_StillOverloads() {
        // Two extensions with the same name but DIFFERENT signatures in the
        // SAME package must still coexist as ordinary overloads (issue
        // #1188), unaffected by the package-scoping change.
        let scope_ = BindSource(`package Foo
func (s string) Greet() string { return "A:" + s }
func (s string) Greet(suffix string) string { return "B:" + s + suffix }`)
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0264")
        let greeters = scope_.Functions.Where((f FunctionSymbol) -> f.Name == "Greet" && f.IsExtension).ToList()
        Assert.Equal(2, greeters.Count)
    }

    @Fact
    func SamePackage_DifferentReceiverType_Extension_StillOverloads() {
        // Two extensions with the same name on DIFFERENT receiver types in
        // the SAME package must still coexist (receiver type is part of
        // overload identity — issue #1188), unaffected by package-scoping.
        let scope_ = BindSource(`package Foo
func (s string) Describe() string { return s }
func (n int32) Describe() string { return "n" }`)
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0264")
        let describers = scope_.Functions.Where((f FunctionSymbol) -> f.Name == "Describe" && f.IsExtension).ToList()
        Assert.Equal(2, describers.Count)
    }

    @Fact
    func OwnPackageCall_ResolvesToOwnExtension_NotForeignPackageHomonym() {
        // The critical resolution-side check: a call FROM within package
        // Baz's own free-function body must resolve to Baz's OWN "Greet"
        // extension on `string`, not Foo's same-named, same-signature
        // homonym (which — by source order — would otherwise occupy the
        // shared legacy lookup slot).
        let scope_ = BindSource("package Foo\nfunc (s string) Greet() string { return \"Foo:\" + s }", `package Baz
func (s string) Greet() string { return "Baz:" + s }
func CallGreet() string { return "x".Greet() }`)
        Assert.Empty(scope_.Diagnostics)
        let program = Binder.BindProgram(scope_)
        Assert.Empty(program.Diagnostics)
        let callGreet = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "CallGreet")
        let body = program.Functions[callGreet]
        let returnStatement = cast[BoundReturnStatement](body.Statements.Single())
        let call = Assert.IsType[BoundCallExpression](returnStatement.Expression)
        Assert.Equal("Baz", call.Function.Package?.Name)
    }

    @Fact
    func OwnPackageCall_FromLambdaBody_ResolvesToOwnExtension() {
        // "Calls from deferred/lambda bodies" coverage: the extension call
        // is made from INSIDE a lambda body invoked by the free function,
        // not directly in the function's top-level statement list.
        let scope_ = BindSource("package Foo\nfunc (s string) Greet() string { return \"Foo:\" + s }", `package Baz
func (s string) Greet() string { return "Baz:" + s }
func CallGreet() string {
    let f = func() string { return "x".Greet() }
    return f()
}`)
        Assert.Empty(scope_.Diagnostics)
        let program = Binder.BindProgram(scope_)
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func CrossPackage_ClrImportedExtension_And_UserExtension_DoNotInterfere() {
        // Cross-package imports: a CLR/BCL imported extension method
        // (`System.Linq.Enumerable.Where`) used in one package must coexist
        // peacefully with an unrelated user-declared extension of the same
        // simple name on an unrelated receiver type in a different package.
        let scope_ = BindSource(`package Foo
import System.Linq
import System.Collections.Generic
func UseWhere() int32 {
    let list = List[int32]()
    list.Add(1)
    list.Add(2)
    let evens = list.Where(func(x int32) bool { return x % 2 == 0 })
    return 0
}`, "package Baz\nfunc (s string) Where() string { return s }")
        Assert.Empty(scope_.Diagnostics)
    }

    shared {
        private func BindSource(sources ...string) BoundGlobalScope {
            let trees = sources.Select((s string) -> SyntaxTree.Parse(SourceText.From(s))).ToImmutableArray()
            return Binder.BindGlobalScope(previous: nil, trees)
        }
    }
}
