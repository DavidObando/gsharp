// <copyright file="Issue2414CrossPackageExtensionVisibilityTests.cs" company="GSharp">
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
/// Regression tests for issue #2414: <c>BoundScope</c>'s package-qualified
/// extension bucketing (added for issue #2342 to stop a same-name,
/// same-signature extension declared by two unrelated packages from being
/// treated as a spurious <c>GS0264</c> duplicate) only ever probed the
/// CALLER's own qualified bucket, then the plain (first-come-first-served)
/// bucket, before giving up. A THIRD scenario was never handled: when a
/// simple-name collision exists between package A (which wins the plain
/// bucket) and package B (relegated to its own <c>"B#Name"</c> qualified
/// bucket), NEITHER a neutral third package NOR package A's own call sites
/// (when A's own colliding overload doesn't match the actual receiver) could
/// ever see package B's extension — <c>TryLookupExtensionFunction</c>/
/// <c>TryLookupExtensionFunctions</c> never scanned any qualified bucket
/// except the caller's own. This directly reproduced the real-world Oahu
/// shape: Oahu.Core declares its own <c>IsNullOrEmpty(this HttpHeaders)</c>
/// extension (a same-simple-name collision with Oahu.Foundation's
/// <c>IsNullOrEmpty(this string)</c> / <c>IsNullOrEmpty&lt;T&gt;(this
/// IEnumerable&lt;T&gt;)</c>), which made every <c>IsNullOrEmpty()</c> call in
/// Oahu.Core fail to resolve (<c>GS0159</c>) once sibling projects were
/// consumed as translated G# source (issue #2412) instead of a prebuilt CLR
/// assembly (whose reflection-based lookup, <c>MemberLookup</c>, was never
/// package-scoped and so never hit this bug).
/// <para>
/// <b>Fix</b>: both lookup methods now fall back to
/// <c>CollectExtensionFunctionMatchesFromOtherPackages</c>, which scans every
/// OTHER package's qualified bucket for the same simple name (after the
/// caller's own bucket and the plain bucket both miss), restoring the
/// documented "extensions are broadly visible; packages are not import
/// boundaries" contract while leaving same-package overload resolution,
/// genuine duplicate-declaration detection, and the caller's-own-package
/// disambiguation preference introduced by #2342 unchanged.
/// </para>
/// </summary>
public class Issue2414CrossPackageExtensionVisibilityTests
{
    [Fact]
    public void PlainBucketOwner_OwnCollidingExtensionDoesNotMatchReceiver_StillResolvesForeignPackagesExtension()
    {
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
        var scope = BindSource(
            "package Data\nclass Widget { }",
            """
            package Core
            func (w Data.Widget) IsNullOrEmpty() bool { return true }
            func CheckString(s string) bool { return s.IsNullOrEmpty() }
            """,
            """
            package Foundation
            func (s string) IsNullOrEmpty() bool { return s == "" }
            """);

        Assert.Empty(scope.Diagnostics);

        var program = Binder.BindProgram(scope);
        Assert.Empty(program.Diagnostics);

        var checkString = scope.Functions.Single(f => f.Name == "CheckString");
        var body = program.Functions[checkString];
        var returnStatement = (BoundReturnStatement)body.Statements.Single();
        var call = Assert.IsType<BoundCallExpression>(returnStatement.Expression);
        Assert.Equal("Foundation", call.Function.Package?.Name);
    }

    [Fact]
    public void PlainBucketOwner_OwnCollidingExtensionDoesNotMatchReceiver_ResolvesForeignGenericExtension()
    {
        // Same shape as above, but the foreign (Foundation) extension is
        // GENERIC (mirrors the real `IsNullOrEmpty<T>(this IEnumerable<T>)`
        // shape exactly) and the call-site receiver is a BCL sequence type,
        // exercising generic-receiver unification through the new fallback
        // path.
        var scope = BindSource(
            "package Data\nclass Widget { }",
            """
            package Core
            import System.Collections.Generic
            func (w Data.Widget) IsNullOrEmpty() bool { return true }
            func CheckSeq(items IEnumerable[int32]) bool { return items.IsNullOrEmpty() }
            """,
            """
            package Foundation
            import System.Collections.Generic
            func (items IEnumerable[T]) IsNullOrEmpty[T any]() bool { return true }
            """);

        Assert.Empty(scope.Diagnostics);

        var program = Binder.BindProgram(scope);
        Assert.Empty(program.Diagnostics);

        var checkSeq = scope.Functions.Single(f => f.Name == "CheckSeq");
        var body = program.Functions[checkSeq];
        var returnStatement = (BoundReturnStatement)body.Statements.Single();
        var call = Assert.IsType<BoundCallExpression>(returnStatement.Expression);
        Assert.Equal("Foundation", call.Function.Package?.Name);
    }

    [Fact]
    public void NeutralThirdPackage_ResolvesEitherCollidingPackagesExtension_BasedOnReceiverType()
    {
        // A genuinely NEUTRAL third package — one that owns neither the
        // plain bucket nor any qualified bucket for this simple name — must
        // still resolve correctly to WHICHEVER colliding package's extension
        // actually matches the call-site receiver.
        var scope = BindSource(
            "package Data\nclass Widget { }",
            """
            package Core
            func (w Data.Widget) IsNullOrEmpty() bool { return true }
            """,
            """
            package Foundation
            func (s string) IsNullOrEmpty() bool { return s == "" }
            """,
            """
            package App
            func CheckWidget(w Data.Widget) bool { return w.IsNullOrEmpty() }
            func CheckString(s string) bool { return s.IsNullOrEmpty() }
            """);

        Assert.Empty(scope.Diagnostics);

        var program = Binder.BindProgram(scope);
        Assert.Empty(program.Diagnostics);

        var checkWidget = scope.Functions.Single(f => f.Name == "CheckWidget");
        var widgetBody = program.Functions[checkWidget];
        var widgetReturn = (BoundReturnStatement)widgetBody.Statements.Single();
        var widgetCall = Assert.IsType<BoundCallExpression>(widgetReturn.Expression);
        Assert.Equal("Core", widgetCall.Function.Package?.Name);

        var checkStringFn = scope.Functions.Single(f => f.Name == "CheckString");
        var stringBody = program.Functions[checkStringFn];
        var stringReturn = (BoundReturnStatement)stringBody.Statements.Single();
        var stringCall = Assert.IsType<BoundCallExpression>(stringReturn.Expression);
        Assert.Equal("Foundation", stringCall.Function.Package?.Name);
    }

    [Fact]
    public void NoCollidingPackageDeclaresMatchingReceiver_StillReportsCannotFindFunction()
    {
        // Negative control: even with the fallback in place, a receiver type
        // that NEITHER colliding package's extension actually applies to
        // must still fail to resolve (GS0159), not silently pick an
        // inapplicable candidate.
        var scope = BindSource(
            "package Data\nclass Widget { }",
            """
            package Core
            func (w Data.Widget) IsNullOrEmpty() bool { return true }
            """,
            """
            package Foundation
            func (s string) IsNullOrEmpty() bool { return s == "" }
            """,
            """
            package App
            func CheckInt(n int32) bool { return n.IsNullOrEmpty() }
            """);

        Assert.Empty(scope.Diagnostics);

        var program = Binder.BindProgram(scope);
        Assert.Contains(program.Diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void OwnPackagePreference_StillWinsOverForeignPackage_WhenOwnBucketMatches()
    {
        // Existing #2342 own-package disambiguation preference must be
        // unaffected: when the caller's OWN qualified bucket has a matching
        // receiver, that match wins even though a foreign package's
        // qualified bucket also has a same-simple-name entry that could
        // otherwise apply.
        var scope = BindSource(
            "package Data\nclass Widget { }",
            """
            package Core
            func (w Data.Widget) IsNullOrEmpty() bool { return true }
            func CheckWidget(w Data.Widget) bool { return w.IsNullOrEmpty() }
            """,
            """
            package Foundation
            func (w Data.Widget) IsNullOrEmpty() bool { return false }
            """);

        Assert.Empty(scope.Diagnostics);

        var program = Binder.BindProgram(scope);
        Assert.Empty(program.Diagnostics);

        var checkWidget = scope.Functions.Single(f => f.Name == "CheckWidget");
        var body = program.Functions[checkWidget];
        var returnStatement = (BoundReturnStatement)body.Statements.Single();
        var call = Assert.IsType<BoundCallExpression>(returnStatement.Expression);
        Assert.Equal("Core", call.Function.Package?.Name);
    }

    [Fact]
    public void ThreeCollidingPackages_EachOwnQualifiedBucket_NeutralCallerResolvesByReceiverType()
    {
        // Broader collision shape: THREE different packages all declare a
        // same-simple-name extension on three DIFFERENT receiver types (only
        // one — the first declared — occupies the plain bucket; the other
        // two are relegated to their own qualified buckets). A neutral
        // fourth package must still resolve every one of them correctly by
        // receiver type.
        var scope = BindSource(
            "package PkgA\nfunc (n int32) Describe() string { return \"A\" }",
            "package PkgB\nfunc (s string) Describe() string { return \"B\" }",
            "package PkgC\nfunc (b bool) Describe() string { return \"C\" }",
            """
            package App
            func CheckInt(n int32) string { return n.Describe() }
            func CheckString(s string) string { return s.Describe() }
            func CheckBool(b bool) string { return b.Describe() }
            """);

        Assert.Empty(scope.Diagnostics);

        var program = Binder.BindProgram(scope);
        Assert.Empty(program.Diagnostics);

        AssertResolvesToPackage(scope, program, "CheckInt", "PkgA");
        AssertResolvesToPackage(scope, program, "CheckString", "PkgB");
        AssertResolvesToPackage(scope, program, "CheckBool", "PkgC");
    }

    private static void AssertResolvesToPackage(
        BoundGlobalScope scope, BoundProgram program, string callerName, string expectedPackage)
    {
        var caller = scope.Functions.Single(f => f.Name == callerName);
        var body = program.Functions[caller];
        var returnStatement = (BoundReturnStatement)body.Statements.Single();
        var call = Assert.IsType<BoundCallExpression>(returnStatement.Expression);
        Assert.Equal(expectedPackage, call.Function.Package?.Name);
    }

    private static BoundGlobalScope BindSource(params string[] sources)
    {
        var trees = sources.Select(s => SyntaxTree.Parse(SourceText.From(s))).ToImmutableArray();
        return Binder.BindGlobalScope(previous: null, trees);
    }
}
