// <copyright file="Issue2414CrossPackageExtensionVisibilityTests.cs" company="GSharp">
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

/// Regression tests for issue #2414: `BoundScope`'s package-qualified
/// extension bucketing (added for issue #2342 to stop a same-name,
/// same-signature extension declared by two unrelated packages from being
/// treated as a spurious `GS0264` duplicate) only ever probed the
/// CALLER's own qualified bucket, then the plain (first-come-first-served)
/// bucket, before giving up. A THIRD scenario was never handled: when a
/// simple-name collision exists between package A (which wins the plain
/// bucket) and package B (relegated to its own `"B#Name"` qualified
/// bucket), NEITHER a neutral third package NOR package A's own call sites
/// (when A's own colliding overload doesn't match the actual receiver) could
/// ever see package B's extension — `TryLookupExtensionFunction`/
/// `TryLookupExtensionFunctions` never scanned any qualified bucket
/// except the caller's own. This directly reproduced the real-world Oahu
/// shape: Oahu.Core declares its own `IsNullOrEmpty(this HttpHeaders)`
/// extension (a same-simple-name collision with Oahu.Foundation's
/// `IsNullOrEmpty(this string)` / `IsNullOrEmpty<T>(this
/// IEnumerable<T>)`), which made every `IsNullOrEmpty()` call in
/// Oahu.Core fail to resolve (`GS0159`) once sibling projects were
/// consumed as translated G# source (issue #2412) instead of a prebuilt CLR
/// assembly (whose reflection-based lookup, `MemberLookup`, was never
/// package-scoped and so never hit this bug).
///
/// <b>Fix</b>: both lookup methods now fall back to
/// `CollectExtensionFunctionMatchesFromOtherPackages`, which scans every
/// OTHER package's qualified bucket for the same simple name (after the
/// caller's own bucket and the plain bucket both miss), restoring the
/// documented "extensions are broadly visible; packages are not import
/// boundaries" contract while leaving same-package overload resolution,
/// genuine duplicate-declaration detection, and the caller's-own-package
/// disambiguation preference introduced by #2342 unchanged.
open class Issue2414CrossPackageExtensionVisibilityTests {
    @Fact
    func PlainBucketOwner_OwnCollidingExtensionDoesNotMatchReceiver_StillResolvesForeignPackagesExtension() {
        // The exact real-world Oahu shape: package Core declares its OWN
        // extension "IsNullOrEmpty" FIRST (wins the plain bucket) on a
        // receiver type ("Widget") that is unrelated to the call site's
        // actual receiver ("string"). Package Foundation's same-simple-name
        // extension on "string", declared SECOND, is relegated to its own
        // qualified bucket ("Foundation#IsNullOrEmpty"). A call made FROM
        // Core's own code must still resolve to Foundation's extension.
        // "Widget" is declared in a separate "Data" package (neither Core
        // nor Foundation owns it) since ADR-0079 reserves receiver-clause
        // extension syntax for types the extending package does not own —
        // exactly mirroring the real shape, where Oahu.Core's colliding
        // extension targets `HttpHeaders`, a BCL type it doesn't own either.
        let scope_ = BindSource("package Data\nclass Widget { }", `package Core
func (w Data.Widget) IsNullOrEmpty() bool { return true }
func CheckString(s string) bool { return s.IsNullOrEmpty() }`, "package Foundation\nfunc (s string) IsNullOrEmpty() bool { return s == \"\" }")
        Assert.Empty(scope_.Diagnostics)
        let program = Binder.BindProgram(scope_)
        Assert.Empty(program.Diagnostics)
        let checkString = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "CheckString")
        let body = program.Functions[checkString]
        let returnStatement = cast[BoundReturnStatement](body.Statements.Single())
        let call = Assert.IsType[BoundCallExpression](returnStatement.Expression)
        Assert.Equal("Foundation", call.Function.Package?.Name)
    }

    @Fact
    func PlainBucketOwner_OwnCollidingExtensionDoesNotMatchReceiver_ResolvesForeignGenericExtension() {
        // Same shape as above, but the foreign (Foundation) extension is
        // GENERIC (mirrors the real `IsNullOrEmpty<T>(this IEnumerable<T>)`
        // shape exactly) and the call-site receiver is a BCL sequence type,
        // exercising generic-receiver unification through the new fallback
        // path.
        let scope_ = BindSource("package Data\nclass Widget { }", `package Core
import System.Collections.Generic
func (w Data.Widget) IsNullOrEmpty() bool { return true }
func CheckSeq(items IEnumerable[int32]) bool { return items.IsNullOrEmpty() }`, `package Foundation
import System.Collections.Generic
func (items IEnumerable[T]) IsNullOrEmpty[T any]() bool { return true }`)
        Assert.Empty(scope_.Diagnostics)
        let program = Binder.BindProgram(scope_)
        Assert.Empty(program.Diagnostics)
        let checkSeq = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "CheckSeq")
        let body = program.Functions[checkSeq]
        let returnStatement = cast[BoundReturnStatement](body.Statements.Single())
        let call = Assert.IsType[BoundCallExpression](returnStatement.Expression)
        Assert.Equal("Foundation", call.Function.Package?.Name)
    }

    @Fact
    func NeutralThirdPackage_ResolvesEitherCollidingPackagesExtension_BasedOnReceiverType() {
        // A genuinely NEUTRAL third package — one that owns neither the
        // plain bucket nor any qualified bucket for this simple name — must
        // still resolve correctly to WHICHEVER colliding package's extension
        // actually matches the call-site receiver.
        let scope_ = BindSource(
            "package Data\nclass Widget { }",
            "package Core\nfunc (w Data.Widget) IsNullOrEmpty() bool { return true }",
            "package Foundation\nfunc (s string) IsNullOrEmpty() bool { return s == \"\" }",
            `package App
func CheckWidget(w Data.Widget) bool { return w.IsNullOrEmpty() }
func CheckString(s string) bool { return s.IsNullOrEmpty() }`
        )
        Assert.Empty(scope_.Diagnostics)
        let program = Binder.BindProgram(scope_)
        Assert.Empty(program.Diagnostics)
        let checkWidget = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "CheckWidget")
        let widgetBody = program.Functions[checkWidget]
        let widgetReturn = cast[BoundReturnStatement](widgetBody.Statements.Single())
        let widgetCall = Assert.IsType[BoundCallExpression](widgetReturn.Expression)
        Assert.Equal("Core", widgetCall.Function.Package?.Name)
        let checkStringFn = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "CheckString")
        let stringBody = program.Functions[checkStringFn]
        let stringReturn = cast[BoundReturnStatement](stringBody.Statements.Single())
        let stringCall = Assert.IsType[BoundCallExpression](stringReturn.Expression)
        Assert.Equal("Foundation", stringCall.Function.Package?.Name)
    }

    @Fact
    func NoCollidingPackageDeclaresMatchingReceiver_StillReportsCannotFindFunction() {
        // Negative control: even with the fallback in place, a receiver type
        // that NEITHER colliding package's extension actually applies to
        // must still fail to resolve (GS0159), not silently pick an
        // inapplicable candidate.
        let scope_ = BindSource(
            "package Data\nclass Widget { }",
            "package Core\nfunc (w Data.Widget) IsNullOrEmpty() bool { return true }",
            "package Foundation\nfunc (s string) IsNullOrEmpty() bool { return s == \"\" }",
            "package App\nfunc CheckInt(n int32) bool { return n.IsNullOrEmpty() }"
        )
        Assert.Empty(scope_.Diagnostics)
        let program = Binder.BindProgram(scope_)
        Assert.Contains(program.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func OwnPackagePreference_StillWinsOverForeignPackage_WhenOwnBucketMatches() {
        // Existing #2342 own-package disambiguation preference must be
        // unaffected: when the caller's OWN qualified bucket has a matching
        // receiver, that match wins even though a foreign package's
        // qualified bucket also has a same-simple-name entry that could
        // otherwise apply.
        let scope_ = BindSource("package Data\nclass Widget { }", `package Core
func (w Data.Widget) IsNullOrEmpty() bool { return true }
func CheckWidget(w Data.Widget) bool { return w.IsNullOrEmpty() }`, "package Foundation\nfunc (w Data.Widget) IsNullOrEmpty() bool { return false }")
        Assert.Empty(scope_.Diagnostics)
        let program = Binder.BindProgram(scope_)
        Assert.Empty(program.Diagnostics)
        let checkWidget = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "CheckWidget")
        let body = program.Functions[checkWidget]
        let returnStatement = cast[BoundReturnStatement](body.Statements.Single())
        let call = Assert.IsType[BoundCallExpression](returnStatement.Expression)
        Assert.Equal("Core", call.Function.Package?.Name)
    }

    @Fact
    func ThreeCollidingPackages_EachOwnQualifiedBucket_NeutralCallerResolvesByReceiverType() {
        // Broader collision shape: THREE different packages all declare a
        // same-simple-name extension on three DIFFERENT receiver types (only
        // one — the first declared — occupies the plain bucket; the other
        // two are relegated to their own qualified buckets). A neutral
        // fourth package must still resolve every one of them correctly by
        // receiver type.
        let scope_ = BindSource(
            "package PkgA\nfunc (n int32) Describe() string { return \"A\" }",
            "package PkgB\nfunc (s string) Describe() string { return \"B\" }",
            "package PkgC\nfunc (b bool) Describe() string { return \"C\" }",
            `package App
func CheckInt(n int32) string { return n.Describe() }
func CheckString(s string) string { return s.Describe() }
func CheckBool(b bool) string { return b.Describe() }`
        )
        Assert.Empty(scope_.Diagnostics)
        let program = Binder.BindProgram(scope_)
        Assert.Empty(program.Diagnostics)
        AssertResolvesToPackage(scope_, program, "CheckInt", "PkgA")
        AssertResolvesToPackage(scope_, program, "CheckString", "PkgB")
        AssertResolvesToPackage(scope_, program, "CheckBool", "PkgC")
    }

    shared {
        private func AssertResolvesToPackage(
            $scope BoundGlobalScope,
            program BoundProgram,
            callerName string,
            expectedPackage string
        ) {
            let caller = $scope.Functions.Single((f FunctionSymbol) -> f.Name == callerName)
            let body = program.Functions[caller]
            let returnStatement = cast[BoundReturnStatement](body.Statements.Single())
            let call = Assert.IsType[BoundCallExpression](returnStatement.Expression)
            Assert.Equal(expectedPackage, call.Function.Package?.Name)
        }

        private func BindSource(sources ...string) BoundGlobalScope {
            let trees = sources.Select((s string) -> SyntaxTree.Parse(SourceText.From(s))).ToImmutableArray()
            return Binder.BindGlobalScope(previous: nil, trees)
        }
    }
}
