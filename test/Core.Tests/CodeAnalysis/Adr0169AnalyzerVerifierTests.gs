// <copyright file="Adr0169AnalyzerVerifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.CodeAnalysis.Analyzers.Testing
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Reflection
import Xunit

/// Acceptance test for the ADR-0169 verifier package: a hand-written G#
/// analogue of GSA0001 (StructFieldDefs index reads outside the resolver
/// choke point) runs over G# source through
/// (cref:GSharpAnalyzerVerifier{TAnalyzer}), pinning the API shape
/// cs2gs will target when migrating the real GSA suite. Note the shape
/// divergence the cs2gs design predicts: G# index writes parse as
/// IndexAssignmentExpression, not IndexExpression, so the write exemption is
/// structural here rather than a Parent-walk.
open class Adr0169AnalyzerVerifierTests {
    @Fact
    func FlagsIndexReadOutsideResolver_AndHonorsMarkers() {
        GSharp
            .CodeAnalysis
            .Analyzers
            .Testing
            .GSharpAnalyzerVerifier[StructFieldDefsReadAnalogueAnalyzer]
            .VerifyAnalyzer(`package App

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
`, "TESTGSA0001")
    }

    @Fact
    func CleanSource_ProducesNoDiagnostics() {
        GSharp
            .CodeAnalysis
            .Analyzers
            .Testing
            .GSharpAnalyzerVerifier[StructFieldDefsReadAnalogueAnalyzer]
            .VerifyAnalyzer(`package App

var structFieldDefs = []int32{1, 2, 3}

func ResolveFieldToken(index int32) int32 {
    return structFieldDefs[index]
}
`)
    }

    @Fact
    func MismatchedExpectation_ThrowsVerificationException() {
        Assert.Throws[GSharpAnalyzerVerificationException](
            () -> GSharp
                .CodeAnalysis
                .Analyzers
                .Testing
                .GSharpAnalyzerVerifier[StructFieldDefsReadAnalogueAnalyzer]
                .VerifyAnalyzer(`package App

var structFieldDefs = []int32{1, 2, 3}

func Leak(index int32) int32 {
    return structFieldDefs[index]
}
`)
        )
    }

    /// The instance-based entry point (ADR-0169 M5, issue #3686): a migrated
    /// analyzer test harness holds an analyzer VALUE, not a type argument, so
    /// the non-generic overload is the shape cs2gs's harness rewrite targets.
    /// Same source, same markers, same outcome as the generic form above.
    @Fact
    func InstanceOverload_FlagsIndexReadOutsideResolver_AndHonorsMarkers() {
        let analyzer GSharpDiagnosticAnalyzer = StructFieldDefsReadAnalogueAnalyzer()
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, `package App

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
`, "TESTGSA0001")
    }

    /// Anti-vacuity guard for the overload above: it must still FAIL when the
    /// analyzer fires and nothing is expected, so a passing verification is
    /// evidence the analyzer ran rather than evidence it was never invoked.
    @Fact
    func InstanceOverload_MismatchedExpectation_ThrowsVerificationException() {
        let analyzer GSharpDiagnosticAnalyzer = StructFieldDefsReadAnalogueAnalyzer()
        Assert.Throws[GSharpAnalyzerVerificationException](
            () -> GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, `package App

var structFieldDefs = []int32{1, 2, 3}

func Leak(index int32) int32 {
    return structFieldDefs[index]
}
`)
        )
    }

    /// The instance overload takes the analyzer through its BASE type, the
    /// only shape a translated harness can produce: the migrated
    /// `AssertDiagnosticsAsync` parameter is
    /// `GSharpDiagnosticAnalyzer`, and the concrete analyzer is chosen at
    /// the call site. A signature that required the concrete type (or a
    /// `new()` constraint) would not bind there.
    @Fact
    func InstanceOverload_AcceptsAnAnalyzerThroughItsBaseType() {
        let method MethodInfo? = typeof(GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier).GetMethod(
            "VerifyAnalyzer"
        )
        Assert.NotNull(method)
        Assert.False(method!!.IsGenericMethod)
        Assert.Equal(typeof(GSharpDiagnosticAnalyzer), method!!.GetParameters()[0].ParameterType)
    }

    /// Issue #3778: a `[|…|]` marker denotes a REGION, and the assertion
    /// is that the diagnostic falls inside it. That is what lets a snippet
    /// translated from C# keep the C# marker's extent: G#'s syntax shapes are
    /// not always span-identical (its index node is narrower than C#'s element
    /// access), so a translated marker is sometimes wider than the diagnostic.
    /// The marker here is wider on BOTH sides, so it also fails the old
    /// exact-start rule rather than only the end check.
    @Fact
    func MarkerWiderThanTheDiagnostic_IsAccepted() {
        GSharp
            .CodeAnalysis
            .Analyzers
            .Testing
            .GSharpAnalyzerVerifier[StructFieldDefsReadAnalogueAnalyzer]
            .VerifyAnalyzer(`package App

var structFieldDefs = []int32{1, 2, 3}

func Leak(index int32) int32 {
    return[| structFieldDefs[index] |]
}
`, "TESTGSA0001")
    }

    /// The anti-vacuity guard for the region rule, and the reason it is
    /// containment rather than "starts inside": a marker NARROWER than the
    /// diagnostic brackets a different construct — here the receiver rather
    /// than the index expression — and must still fail. Without the end check,
    /// this would pass, and a mis-placed marker would be indistinguishable from
    /// a correct one.
    @Fact
    func MarkerNarrowerThanTheDiagnostic_IsRejected() {
        Assert.Throws[GSharpAnalyzerVerificationException](
            () -> GSharp
                .CodeAnalysis
                .Analyzers
                .Testing
                .GSharpAnalyzerVerifier[StructFieldDefsReadAnalogueAnalyzer]
                .VerifyAnalyzer(`package App

var structFieldDefs = []int32{1, 2, 3}

func Leak(index int32) int32 {
    return [|structFieldDefs|][index]
}
`, "TESTGSA0001")
        )
    }

    /// A marker on an unrelated construct fails too: the region rule bounds
    /// where a diagnostic may land, it does not stop checking placement.
    @Fact
    func MarkerOnADifferentConstruct_IsRejected() {
        Assert.Throws[GSharpAnalyzerVerificationException](
            () -> GSharp
                .CodeAnalysis
                .Analyzers
                .Testing
                .GSharpAnalyzerVerifier[StructFieldDefsReadAnalogueAnalyzer]
                .VerifyAnalyzer(`package App

var structFieldDefs = []int32{1, 2, 3}

func Leak([|index|] int32) int32 {
    return structFieldDefs[index]
}
`, "TESTGSA0001")
        )
    }

    /// Issue #3778: an analyzer that reports without a source location used to
    /// crash the verifier with a NullReferenceException from
    /// `TextLocation.StartLine` — a failure that says nothing about the
    /// analyzer. It now names the cause. (The real case: a migrated
    /// symbol-action analyzer whose G# symbol carries no declaring location.)
    @Fact
    func LocationLessDiagnostic_ReportsTheCauseInsteadOfCrashing() {
        let failure = Assert.Throws[GSharpAnalyzerVerificationException](
            () -> GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[LocationLessAnalyzer].VerifyAnalyzer(`package App

func Leak() int32 {
    return [|1|]
}
`, "TESTGSA0002")
        )
        Assert.Contains("no source location", failure.Message, StringComparison.Ordinal)
    }

    /// Issue #3796: a source-declared field exposes its identifier location so
    /// a migrated symbol-action analyzer can report against the field marker.
    @Fact
    func FieldSymbolAction_ReportsAtDeclaringIdentifier() {
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[FieldLocationAnalyzer].VerifyAnalyzer(`package App

class Cache {
    shared {
        var [|entries|] int32
    }
}
`, "TESTGSA0003")
    }

    @Fact
    func PrimaryConstructorFieldSymbolAction_ReportsAtDeclaringIdentifier() {
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[FieldLocationAnalyzer].VerifyAnalyzer(`package App

class Cache([|entries|] int32) {
}
`, "TESTGSA0003")
    }

    /// Issue #3794: a marked source may declare several compilation units,
    /// separated by (cref:GSharpAnalyzerVerifier.UnitSeparator), and
    /// they compile TOGETHER — which is the only rendering of a multi-namespace
    /// analyzer-test snippet that keeps a package-scoped rule judging the
    /// declarations the C# original meant. Collapsed into one unit, the
    /// `App.Emit` field below would sit in `App.Symbols` and this
    /// analyzer would report nothing at all.
    @Fact
    func MultipleUnits_ArePackageScopedIndependently() {
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[EmitPackageFieldAnalyzer].VerifyAnalyzer(`package App.Symbols

class SymbolCache {
    shared {
        var entries int32
    }
}
` + GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier.UnitSeparator + `
package App.Emit

class EmitCache {
    shared {
        var [|entries|] int32
    }
}
`, "TESTGSA0004")
    }

    /// The companion falsifier: the SAME two units with the marker moved to the
    /// unit the rule does not police must fail. Without this, a rule that fired
    /// everywhere — or nowhere — could still satisfy the test above.
    @Fact
    func MultipleUnits_AMarkerInTheWrongUnit_IsRejected() {
        let exception = Assert.Throws[GSharpAnalyzerVerificationException](
            () -> GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[EmitPackageFieldAnalyzer].VerifyAnalyzer(`package App.Symbols

class SymbolCache {
    shared {
        var [|entries|] int32
    }
}
` + GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier.UnitSeparator + `
package App.Emit

class EmitCache {
    shared {
        var entries int32
    }
}
`, "TESTGSA0004")
        )
        Assert.Contains("compilation unit", exception.Message, StringComparison.Ordinal)
    }

    /// A source with no separator stays exactly one unit, so every
    /// hand-written G# analyzer test is unaffected: the package-scoped rule
    /// sees one package and reports once.
    @Fact
    func SingleUnit_IsUnaffectedBySeparatorSupport() {
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[EmitPackageFieldAnalyzer].VerifyAnalyzer(`package App.Emit

class EmitCache {
    shared {
        var [|entries|] int32
    }
}
`, "TESTGSA0004")
    }

    /// The G# analogue of GSA0001: direct index reads of a member named
    /// `structFieldDefs` outside `ResolveFieldToken` /
    /// `ResolveInterfaceFieldToken` are flagged. Uses
    /// (cref:SyntaxNode.Parent) to find the enclosing function — the
    /// same idiom the Roslyn original uses.
    @GSharpDiagnosticAnalyzer
    class StructFieldDefsReadAnalogueAnalyzer : GSharpDiagnosticAnalyzer {
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func Initialize(context AnalysisContext) {
            context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None)
            context.EnableConcurrentExecution()
            context.RegisterSyntaxNodeAction(AnalyzeIndexExpression, SyntaxKind.IndexExpression)
        }

        shared {
            private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
                "TESTGSA0001",
                "StructFieldDefs read outside resolver",
                "Read struct field tokens through ResolveFieldToken instead of indexing structFieldDefs directly.",
                "Testing",
                DiagnosticSeverity.Warning,
                isEnabledByDefault: true
            )

            private func AnalyzeIndexExpression(context SyntaxNodeAnalysisContext) {
                let indexExpression = cast[IndexExpressionSyntax](context.Node)
                if indexExpression.Target.GetLastToken().Text != "structFieldDefs" {
                    return
                }
                for var ancestor SyntaxNode? = context.Node.Parent; ancestor != nil; ancestor = ancestor!!.Parent {
                    if ancestor is FunctionDeclarationSyntax function {
                        if (function.Identifier.Text is "ResolveFieldToken" or "ResolveInterfaceFieldToken") {
                            return
                        }
                        break
                    }
                }
                context.ReportDiagnostic(Diagnostic.Create(Rule, indexExpression.Location))
            }
        }
    }

    /// Reports one diagnostic with no source location — the shape that used to
    /// crash the verifier (issue #3778).
    @GSharpDiagnosticAnalyzer
    class LocationLessAnalyzer : GSharpDiagnosticAnalyzer {
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func Initialize(context AnalysisContext) {
            context.RegisterSyntaxNodeAction(Report, SyntaxKind.LiteralExpression)
        }

        shared {
            private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
                "TESTGSA0002",
                "Location-less",
                "Reported with no source location.",
                "Testing",
                DiagnosticSeverity.Warning,
                isEnabledByDefault: true
            )

            private func Report(context SyntaxNodeAnalysisContext) {
                context.ReportDiagnostic(Diagnostic.Create(Rule, default(TextLocation)))
            }
        }
    }

    /// A package-scoped analogue of GSA0003/GSA0004: reports every field
    /// declared in package `App.Emit`, and only there. Issue #3794's
    /// discrimination witness — its answer changes when a declaration's package
    /// changes, which is exactly what collapsing several units into one did.
    @GSharpDiagnosticAnalyzer
    class EmitPackageFieldAnalyzer : GSharpDiagnosticAnalyzer {
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func Initialize(context AnalysisContext) {
            context.RegisterSymbolAction(
                (ctx SymbolAnalysisContext) -> {
                    if ctx.Symbol.ContainingNamespace == "App.Emit" {
                        ctx.ReportDiagnostic(Diagnostic.Create(Rule, ctx.Symbol.Location))
                    }
                },
                SymbolKind.Field
            )
        }

        shared {
            private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
                "TESTGSA0004",
                "Field in the Emit package",
                "Field is declared in the Emit package.",
                "Testing",
                DiagnosticSeverity.Warning,
                isEnabledByDefault: true
            )
        }
    }

    @GSharpDiagnosticAnalyzer
    class FieldLocationAnalyzer : GSharpDiagnosticAnalyzer {
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func Initialize(context AnalysisContext) {
            context.RegisterSymbolAction(
                (ctx SymbolAnalysisContext) -> ctx.ReportDiagnostic(Diagnostic.Create(Rule, ctx.Symbol.Location)),
                SymbolKind.Field
            )
        }

        shared {
            private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
                "TESTGSA0003",
                "Field location",
                "Field has a source location.",
                "Testing",
                DiagnosticSeverity.Warning,
                isEnabledByDefault: true
            )
        }
    }
}
