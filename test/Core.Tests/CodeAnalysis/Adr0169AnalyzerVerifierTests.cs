// <copyright file="Adr0169AnalyzerVerifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.CodeAnalysis.Analyzers.Testing;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Acceptance test for the ADR-0169 verifier package: a hand-written G#
/// analogue of GSA0001 (StructFieldDefs index reads outside the resolver
/// choke point) runs over G# source through
/// <see cref="GSharpAnalyzerVerifier{TAnalyzer}"/>, pinning the API shape
/// cs2gs will target when migrating the real GSA suite. Note the shape
/// divergence the cs2gs design predicts: G# index writes parse as
/// IndexAssignmentExpression, not IndexExpression, so the write exemption is
/// structural here rather than a Parent-walk.
/// </summary>
public class Adr0169AnalyzerVerifierTests
{
    [Fact]
    public void FlagsIndexReadOutsideResolver_AndHonorsMarkers()
    {
        GSharpAnalyzerVerifier<StructFieldDefsReadAnalogueAnalyzer>.VerifyAnalyzer(
            @"package App

var structFieldDefs = []int32{1, 2, 3}

func ResolveFieldToken(index int32) int32 {
    return structFieldDefs[index]
}

func Leak(index int32) int32 {
    return [|structFieldDefs[index]|]
}

func Populate(index int32) {
    structFieldDefs[index] = 0
}
",
            "TESTGSA0001");
    }

    [Fact]
    public void CleanSource_ProducesNoDiagnostics()
    {
        GSharpAnalyzerVerifier<StructFieldDefsReadAnalogueAnalyzer>.VerifyAnalyzer(
            @"package App

var structFieldDefs = []int32{1, 2, 3}

func ResolveFieldToken(index int32) int32 {
    return structFieldDefs[index]
}
");
    }

    [Fact]
    public void MismatchedExpectation_ThrowsVerificationException()
    {
        Assert.Throws<GSharpAnalyzerVerificationException>(() =>
            GSharpAnalyzerVerifier<StructFieldDefsReadAnalogueAnalyzer>.VerifyAnalyzer(
                @"package App

var structFieldDefs = []int32{1, 2, 3}

func Leak(index int32) int32 {
    return structFieldDefs[index]
}
"));
    }

    /// <summary>
    /// The instance-based entry point (ADR-0169 M5, issue #3686): a migrated
    /// analyzer test harness holds an analyzer VALUE, not a type argument, so
    /// the non-generic overload is the shape cs2gs's harness rewrite targets.
    /// Same source, same markers, same outcome as the generic form above.
    /// </summary>
    [Fact]
    public void InstanceOverload_FlagsIndexReadOutsideResolver_AndHonorsMarkers()
    {
        GSharpDiagnosticAnalyzer analyzer = new StructFieldDefsReadAnalogueAnalyzer();
        GSharpAnalyzerVerifier.VerifyAnalyzer(
            analyzer,
            @"package App

var structFieldDefs = []int32{1, 2, 3}

func ResolveFieldToken(index int32) int32 {
    return structFieldDefs[index]
}

func Leak(index int32) int32 {
    return [|structFieldDefs[index]|]
}

func Populate(index int32) {
    structFieldDefs[index] = 0
}
",
            "TESTGSA0001");
    }

    /// <summary>
    /// Anti-vacuity guard for the overload above: it must still FAIL when the
    /// analyzer fires and nothing is expected, so a passing verification is
    /// evidence the analyzer ran rather than evidence it was never invoked.
    /// </summary>
    [Fact]
    public void InstanceOverload_MismatchedExpectation_ThrowsVerificationException()
    {
        GSharpDiagnosticAnalyzer analyzer = new StructFieldDefsReadAnalogueAnalyzer();
        Assert.Throws<GSharpAnalyzerVerificationException>(() =>
            GSharpAnalyzerVerifier.VerifyAnalyzer(
                analyzer,
                @"package App

var structFieldDefs = []int32{1, 2, 3}

func Leak(index int32) int32 {
    return structFieldDefs[index]
}
"));
    }

    /// <summary>
    /// The instance overload takes the analyzer through its BASE type, the
    /// only shape a translated harness can produce: the migrated
    /// <c>AssertDiagnosticsAsync</c> parameter is
    /// <c>GSharpDiagnosticAnalyzer</c>, and the concrete analyzer is chosen at
    /// the call site. A signature that required the concrete type (or a
    /// <c>new()</c> constraint) would not bind there.
    /// </summary>
    [Fact]
    public void InstanceOverload_AcceptsAnAnalyzerThroughItsBaseType()
    {
        var method = typeof(GSharpAnalyzerVerifier).GetMethod(nameof(GSharpAnalyzerVerifier.VerifyAnalyzer));
        Assert.NotNull(method);
        Assert.False(method.IsGenericMethod);
        Assert.Equal(typeof(GSharpDiagnosticAnalyzer), method.GetParameters()[0].ParameterType);
    }

    /// <summary>
    /// Issue #3778: a <c>[|…|]</c> marker denotes a REGION, and the assertion
    /// is that the diagnostic falls inside it. That is what lets a snippet
    /// translated from C# keep the C# marker's extent: G#'s syntax shapes are
    /// not always span-identical (its index node is narrower than C#'s element
    /// access), so a translated marker is sometimes wider than the diagnostic.
    /// The marker here is wider on BOTH sides, so it also fails the old
    /// exact-start rule rather than only the end check.
    /// </summary>
    [Fact]
    public void MarkerWiderThanTheDiagnostic_IsAccepted()
    {
        GSharpAnalyzerVerifier<StructFieldDefsReadAnalogueAnalyzer>.VerifyAnalyzer(
            @"package App

var structFieldDefs = []int32{1, 2, 3}

func Leak(index int32) int32 {
    return[| structFieldDefs[index] |]
}
",
            "TESTGSA0001");
    }

    /// <summary>
    /// The anti-vacuity guard for the region rule, and the reason it is
    /// containment rather than "starts inside": a marker NARROWER than the
    /// diagnostic brackets a different construct — here the receiver rather
    /// than the index expression — and must still fail. Without the end check,
    /// this would pass, and a mis-placed marker would be indistinguishable from
    /// a correct one.
    /// </summary>
    [Fact]
    public void MarkerNarrowerThanTheDiagnostic_IsRejected()
    {
        Assert.Throws<GSharpAnalyzerVerificationException>(() =>
            GSharpAnalyzerVerifier<StructFieldDefsReadAnalogueAnalyzer>.VerifyAnalyzer(
                @"package App

var structFieldDefs = []int32{1, 2, 3}

func Leak(index int32) int32 {
    return [|structFieldDefs|][index]
}
",
                "TESTGSA0001"));
    }

    /// <summary>
    /// A marker on an unrelated construct fails too: the region rule bounds
    /// where a diagnostic may land, it does not stop checking placement.
    /// </summary>
    [Fact]
    public void MarkerOnADifferentConstruct_IsRejected()
    {
        Assert.Throws<GSharpAnalyzerVerificationException>(() =>
            GSharpAnalyzerVerifier<StructFieldDefsReadAnalogueAnalyzer>.VerifyAnalyzer(
                @"package App

var structFieldDefs = []int32{1, 2, 3}

func Leak([|index|] int32) int32 {
    return structFieldDefs[index]
}
",
                "TESTGSA0001"));
    }

    /// <summary>
    /// Issue #3778: an analyzer that reports without a source location used to
    /// crash the verifier with a NullReferenceException from
    /// <c>TextLocation.StartLine</c> — a failure that says nothing about the
    /// analyzer. It now names the cause. (The real case: a migrated
    /// symbol-action analyzer whose G# symbol carries no declaring location.)
    /// </summary>
    [Fact]
    public void LocationLessDiagnostic_ReportsTheCauseInsteadOfCrashing()
    {
        GSharpAnalyzerVerificationException failure =
            Assert.Throws<GSharpAnalyzerVerificationException>(() =>
                GSharpAnalyzerVerifier<LocationLessAnalyzer>.VerifyAnalyzer(
                    @"package App

func Leak() int32 {
    return [|1|]
}
",
                    "TESTGSA0002"));

        Assert.Contains("no source location", failure.Message, System.StringComparison.Ordinal);
    }

    /// <summary>
    /// Issue #3796: a source-declared field exposes its identifier location so
    /// a migrated symbol-action analyzer can report against the field marker.
    /// </summary>
    [Fact]
    public void FieldSymbolAction_ReportsAtDeclaringIdentifier()
    {
        GSharpAnalyzerVerifier<FieldLocationAnalyzer>.VerifyAnalyzer(
            @"package App

class Cache {
    shared {
        var [|entries|] int32
    }
}
",
            "TESTGSA0003");
    }

    [Fact]
    public void PrimaryConstructorFieldSymbolAction_ReportsAtDeclaringIdentifier()
    {
        GSharpAnalyzerVerifier<FieldLocationAnalyzer>.VerifyAnalyzer(
            @"package App

class Cache([|entries|] int32) {
}
",
            "TESTGSA0003");
    }

    /// <summary>
    /// Issue #3794: a marked source may declare several compilation units,
    /// separated by <see cref="GSharpAnalyzerVerifier.UnitSeparator"/>, and
    /// they compile TOGETHER — which is the only rendering of a multi-namespace
    /// analyzer-test snippet that keeps a package-scoped rule judging the
    /// declarations the C# original meant. Collapsed into one unit, the
    /// <c>App.Emit</c> field below would sit in <c>App.Symbols</c> and this
    /// analyzer would report nothing at all.
    /// </summary>
    [Fact]
    public void MultipleUnits_ArePackageScopedIndependently()
    {
        GSharpAnalyzerVerifier<EmitPackageFieldAnalyzer>.VerifyAnalyzer(
            @"package App.Symbols

class SymbolCache {
    shared {
        var entries int32
    }
}
" + GSharpAnalyzerVerifier.UnitSeparator + @"
package App.Emit

class EmitCache {
    shared {
        var [|entries|] int32
    }
}
",
            "TESTGSA0004");
    }

    /// <summary>
    /// The companion falsifier: the SAME two units with the marker moved to the
    /// unit the rule does not police must fail. Without this, a rule that fired
    /// everywhere — or nowhere — could still satisfy the test above.
    /// </summary>
    [Fact]
    public void MultipleUnits_AMarkerInTheWrongUnit_IsRejected()
    {
        var exception = Assert.Throws<GSharpAnalyzerVerificationException>(() =>
            GSharpAnalyzerVerifier<EmitPackageFieldAnalyzer>.VerifyAnalyzer(
                @"package App.Symbols

class SymbolCache {
    shared {
        var [|entries|] int32
    }
}
" + GSharpAnalyzerVerifier.UnitSeparator + @"
package App.Emit

class EmitCache {
    shared {
        var entries int32
    }
}
",
                "TESTGSA0004"));

        Assert.Contains("compilation unit", exception.Message, System.StringComparison.Ordinal);
    }

    /// <summary>
    /// A source with no separator stays exactly one unit, so every
    /// hand-written G# analyzer test is unaffected: the package-scoped rule
    /// sees one package and reports once.
    /// </summary>
    [Fact]
    public void SingleUnit_IsUnaffectedBySeparatorSupport()
    {
        GSharpAnalyzerVerifier<EmitPackageFieldAnalyzer>.VerifyAnalyzer(
            @"package App.Emit

class EmitCache {
    shared {
        var [|entries|] int32
    }
}
",
            "TESTGSA0004");
    }

    /// <summary>
    /// The G# analogue of GSA0001: direct index reads of a member named
    /// <c>structFieldDefs</c> outside <c>ResolveFieldToken</c> /
    /// <c>ResolveInterfaceFieldToken</c> are flagged. Uses
    /// <see cref="SyntaxNode.Parent"/> to find the enclosing function — the
    /// same idiom the Roslyn original uses.
    /// </summary>
    [GSharpDiagnosticAnalyzer]
    public sealed class StructFieldDefsReadAnalogueAnalyzer : GSharpDiagnosticAnalyzer
    {
        private static readonly DiagnosticDescriptor Rule = new(
            "TESTGSA0001",
            "StructFieldDefs read outside resolver",
            "Read struct field tokens through ResolveFieldToken instead of indexing structFieldDefs directly.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true);

        /// <inheritdoc/>
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

        /// <inheritdoc/>
        public override void Initialize(AnalysisContext context)
        {
            context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
            context.EnableConcurrentExecution();
            context.RegisterSyntaxNodeAction(AnalyzeIndexExpression, SyntaxKind.IndexExpression);
        }

        private static void AnalyzeIndexExpression(SyntaxNodeAnalysisContext context)
        {
            var indexExpression = (IndexExpressionSyntax)context.Node;
            if (indexExpression.Target.GetLastToken().Text != "structFieldDefs")
            {
                return;
            }

            for (var ancestor = context.Node.Parent; ancestor is not null; ancestor = ancestor.Parent)
            {
                if (ancestor is FunctionDeclarationSyntax function)
                {
                    if (function.Identifier.Text is "ResolveFieldToken" or "ResolveInterfaceFieldToken")
                    {
                        return;
                    }

                    break;
                }
            }

            context.ReportDiagnostic(Diagnostic.Create(Rule, indexExpression.Location));
        }
    }

    /// <summary>
    /// Reports one diagnostic with no source location — the shape that used to
    /// crash the verifier (issue #3778).
    /// </summary>
    [GSharpDiagnosticAnalyzer]
    public sealed class LocationLessAnalyzer : GSharpDiagnosticAnalyzer
    {
        private static readonly DiagnosticDescriptor Rule = new(
            "TESTGSA0002",
            "Location-less",
            "Reported with no source location.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true);

        /// <inheritdoc/>
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

        /// <inheritdoc/>
        public override void Initialize(AnalysisContext context)
        {
            context.RegisterSyntaxNodeAction(Report, SyntaxKind.LiteralExpression);
        }

        private static void Report(SyntaxNodeAnalysisContext context)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, default(GSharp.Core.CodeAnalysis.Text.TextLocation)));
        }
    }

    /// <summary>
    /// A package-scoped analogue of GSA0003/GSA0004: reports every field
    /// declared in package <c>App.Emit</c>, and only there. Issue #3794's
    /// discrimination witness — its answer changes when a declaration's package
    /// changes, which is exactly what collapsing several units into one did.
    /// </summary>
    [GSharpDiagnosticAnalyzer]
    public sealed class EmitPackageFieldAnalyzer : GSharpDiagnosticAnalyzer
    {
        private static readonly DiagnosticDescriptor Rule = new(
            "TESTGSA0004",
            "Field in the Emit package",
            "Field is declared in the Emit package.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true);

        /// <inheritdoc/>
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

        /// <inheritdoc/>
        public override void Initialize(AnalysisContext context)
        {
            context.RegisterSymbolAction(
                ctx =>
                {
                    if (ctx.Symbol.ContainingNamespace == "App.Emit")
                    {
                        ctx.ReportDiagnostic(Diagnostic.Create(Rule, ctx.Symbol.Location));
                    }
                },
                GSharp.Core.CodeAnalysis.Symbols.SymbolKind.Field);
        }
    }

    [GSharpDiagnosticAnalyzer]
    public sealed class FieldLocationAnalyzer : GSharpDiagnosticAnalyzer
    {
        private static readonly DiagnosticDescriptor Rule = new(
            "TESTGSA0003",
            "Field location",
            "Field has a source location.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true);

        /// <inheritdoc/>
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

        /// <inheritdoc/>
        public override void Initialize(AnalysisContext context)
        {
            context.RegisterSymbolAction(
                ctx => ctx.ReportDiagnostic(Diagnostic.Create(Rule, ctx.Symbol.Location)),
                GSharp.Core.CodeAnalysis.Symbols.SymbolKind.Field);
        }
    }
}
