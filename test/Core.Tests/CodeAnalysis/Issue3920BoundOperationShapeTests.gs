// <copyright file="Issue3920BoundOperationShapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.CodeAnalysis.Analyzers.Testing
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable
import Xunit

/// Issue #3920: the ADR-0169 analyzer surface over the bound tree's
/// PROVENANCE SPLIT.
///
/// G# binds one program construct to different nodes depending on where the
/// operator or callee came from: `a == b` is a
/// (cref:BoundBinaryExpression) for a built-in operator and a
/// (cref:BoundClrBinaryOperatorExpression) when it resolves to an
/// `op_Equality` method, and a call is one of three nodes by callee
/// provenance. That is a codegen distinction; to an analyzer it is one shape,
/// which is why (cref:BoundBinaryOperationExpression) and
/// (cref:BoundCallOperationExpression) exist.
///
/// The failure this guards is SILENCE, not a wrong answer: a rule written
/// against the built-in nodes alone sees none of the imported code, and code
/// that compares reflection (cref:System.Type) values is imported by
/// construction — so GSA0002 policed exactly the program it could not observe.
/// Each positive here therefore demands a diagnostic on an imported operand or
/// an imported callee, and its companion demands silence where the construct
/// is genuinely absent.
open class Issue3920BoundOperationShapeTests {
    /// An `==` over two imported `System.Type` values binds to
    /// (cref:BoundClrBinaryOperatorExpression), and an analyzer
    /// registered for both binary kinds sees it through the shared base —
    /// operands and operator kind included.
    @Fact
    func ImportedOperandEquality_IsSeenAsABinaryOperation() {
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[EqualityOverTypeAnalyzer].VerifyAnalyzer(`package App

import System

class C {
    func Same(left Type, right Type) bool {
        return [|left == right|]
    }
}
`, "TESTGSA3920A")
    }

    /// The built-in operator still arrives at the same handler: the base spans
    /// both provenances rather than swapping one blind spot for the other.
    @Fact
    func BuiltInOperandEquality_IsSeenAsTheSameBinaryOperation() {
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[EqualityAnalyzer].VerifyAnalyzer(`package App

func Same(left int32, right int32) bool {
    return [|left == right|]
}
`, "TESTGSA3920B")
    }

    /// The falsifier for both: a comparison that is not an equality must not
    /// report, so a handler that fired on every node it received could not
    /// pass the positives above.
    @Fact
    func NonEqualityComparison_IsNotReported() {
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[EqualityAnalyzer].VerifyAnalyzer(`package App

func Less(left int32, right int32) bool {
    return left < right
}
`)
    }

    /// A static call into metadata binds to
    /// `BoundImportedCallExpression`, and the callee's declaring type is
    /// reachable through (cref:Symbol.ContainingType) — which used to be
    /// null for every imported symbol, because nothing anchors them.
    @Fact
    func ImportedStaticCall_ExposesItsDeclaringTypeThroughCalledFunction() {
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[ReferenceEqualsCallAnalyzer].VerifyAnalyzer(`package App

import System

class C {
    func Same(left Type, right Type) bool {
        return object.[|ReferenceEquals(left, right)|]
    }
}
`, "TESTGSA3920C")
    }

    /// The falsifier: a different imported static call reaches the same
    /// handler and is rejected on its name and declaring type, so the positive
    /// above is evidence the gate ran rather than evidence it was skipped.
    @Fact
    func OtherImportedStaticCall_IsNotReported() {
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[ReferenceEqualsCallAnalyzer].VerifyAnalyzer(`package App

import System

class C {
    func Describe(value Type) string {
        return string.Concat(value.Name, value.Name)
    }
}
`)
    }

    /// PR #3968 review: `receiver.Method()` — the most ordinary call there
    /// is — binds to `BoundUserInstanceCallExpression`, which was outside
    /// the shared base and outside the dispatch set. A migrated invocation rule
    /// therefore never fired on it AT ALL; measured before the fix, this source
    /// produced no diagnostic.
    @Fact
    func SameCompilationInstanceCall_IsSeenAsACallOperation() {
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[AnyCallAnalyzer].VerifyAnalyzer(`package App

class C {
    func Value() int32 {
        return 1
    }

    func Use() int32 {
        return [|Value()|]
    }
}
`, "TESTGSA3920D")
    }

    /// The falsifier: a body with no call at all must stay silent, so the test
    /// above is evidence the handler ran rather than evidence it fires blindly.
    @Fact
    func BodyWithoutACall_IsNotReported() {
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[AnyCallAnalyzer].VerifyAnalyzer(`package App

func Use(value int32) int32 {
    return value + 1
}
`)
    }

    /// PR #3968 review, and the reason cs2gs answers
    /// `TargetMethod.ReturnType` from the call NODE rather than from the
    /// callee symbol: for a constructed generic call the symbol still carries
    /// the DECLARATION's return type. Measured on
    /// `Identity[int32](1)`: `symbol=T` against
    /// `node=global::System.Int32`. Roslyn's `TargetMethod` is the
    /// constructed method, so the node's type is the faithful reading.
    @Fact
    func ConstructedGenericCall_KeepsTheCallSiteReturnTypeOnTheNode() {
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[GenericReturnTypeAnalyzer].VerifyAnalyzer(`package App

func Identity[T](value T) T {
    return value
}

func Use() int32 {
    return [|Identity[int32](1)|]
}
`, "TESTGSA3920E")
    }

    /// Reports every equality binary operation, whatever node the binder chose
    /// for it.
    @GSharpDiagnosticAnalyzer
    class EqualityAnalyzer : GSharpDiagnosticAnalyzer {
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func Initialize(context AnalysisContext) -> context.RegisterBoundNodeAction(
            Analyze,
            BoundNodeKind.BinaryExpression,
            BoundNodeKind.ClrBinaryOperatorExpression
        )

        shared {
            private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
                "TESTGSA3920B",
                "Equality binary operation",
                "An equality binary operation.",
                "Testing",
                DiagnosticSeverity.Warning,
                isEnabledByDefault: true
            )

            private func Analyze(context BoundNodeAnalysisContext) {
                let operation = cast[BoundBinaryOperationExpression](context.BoundNode)
                if operation.BinaryOperatorKind != BoundBinaryOperatorKind.Equals {
                    return
                }
                Assert.NotNull(operation.Left)
                Assert.NotNull(operation.Right)
                context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax!!.Location))
            }
        }
    }

    /// The same rule, restricted to operands of the imported reflection
    /// `Type` — the shape that reaches the handler only as a
    /// (cref:BoundClrBinaryOperatorExpression).
    @GSharpDiagnosticAnalyzer
    class EqualityOverTypeAnalyzer : GSharpDiagnosticAnalyzer {
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func Initialize(context AnalysisContext) -> context.RegisterBoundNodeAction(
            Analyze,
            BoundNodeKind.BinaryExpression,
            BoundNodeKind.ClrBinaryOperatorExpression
        )

        shared {
            private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
                "TESTGSA3920A",
                "Equality over reflection Type",
                "An equality binary operation over reflection Type operands.",
                "Testing",
                DiagnosticSeverity.Warning,
                isEnabledByDefault: true
            )

            private func Analyze(context BoundNodeAnalysisContext) {
                let operation = cast[BoundBinaryOperationExpression](context.BoundNode)
                if operation.BinaryOperatorKind != BoundBinaryOperatorKind.Equals ||
                    operation
                    .Left
                    .Type
                    ?.ToDisplayString(DisplayFormat.FullyQualified) != "global::System.Type" {
                    return
                }
                context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax!!.Location))
            }
        }
    }

    /// Reports every call, whatever node the binder chose for it.
    @GSharpDiagnosticAnalyzer
    class AnyCallAnalyzer : GSharpDiagnosticAnalyzer {
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func Initialize(context AnalysisContext) -> context.RegisterBoundNodeAction(
            Analyze,
            BoundNodeKind.CallExpression,
            BoundNodeKind.UserInstanceCallExpression,
            BoundNodeKind.ImportedCallExpression,
            BoundNodeKind.ImportedInstanceCallExpression,
            BoundNodeKind.ClrStaticCallExpression,
            BoundNodeKind.ConstrainedStaticCallExpression,
            BoundNodeKind.BaseInterfaceCallExpression
        )

        shared {
            private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
                "TESTGSA3920D",
                "Call operation",
                "A call operation.",
                "Testing",
                DiagnosticSeverity.Warning,
                isEnabledByDefault: true
            )

            private func Analyze(context BoundNodeAnalysisContext) {
                let operation = cast[BoundCallOperationExpression](context.BoundNode)
                Assert.NotNull(operation.CalledFunction)
                context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax!!.Location))
            }
        }
    }

    /// Reports a call whose NODE type is `int32` while its callee symbol
    /// still says `T` — the divergence that makes the node the right
    /// source for a translated `ReturnType` read.
    @GSharpDiagnosticAnalyzer
    class GenericReturnTypeAnalyzer : GSharpDiagnosticAnalyzer {
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func Initialize(context AnalysisContext) -> context.RegisterBoundNodeAction(
            Analyze,
            BoundNodeKind.CallExpression
        )

        shared {
            private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
                "TESTGSA3920E",
                "Constructed generic call",
                "A constructed generic call.",
                "Testing",
                DiagnosticSeverity.Warning,
                isEnabledByDefault: true
            )

            private func Analyze(context BoundNodeAnalysisContext) {
                let operation = cast[BoundCallOperationExpression](context.BoundNode)
                if operation.CalledFunction.Name != "Identity" {
                    return
                }
                Assert.Equal("global::System.Int32", operation.Type.ToDisplayString(DisplayFormat.FullyQualified))
                Assert.Equal(
                    "T",
                    (cast[FunctionSymbol](operation.CalledFunction)).Type.ToDisplayString(DisplayFormat.FullyQualified)
                )
                context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax!!.Location))
            }
        }
    }

    /// Reports `object.ReferenceEquals` calls, identified through
    /// (cref:BoundCallOperationExpression.CalledFunction) and its
    /// declaring type.
    @GSharpDiagnosticAnalyzer
    class ReferenceEqualsCallAnalyzer : GSharpDiagnosticAnalyzer {
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func Initialize(context AnalysisContext) -> context.RegisterBoundNodeAction(
            Analyze,
            BoundNodeKind.CallExpression,
            BoundNodeKind.UserInstanceCallExpression,
            BoundNodeKind.ImportedCallExpression,
            BoundNodeKind.ImportedInstanceCallExpression,
            BoundNodeKind.ClrStaticCallExpression,
            BoundNodeKind.ConstrainedStaticCallExpression,
            BoundNodeKind.BaseInterfaceCallExpression
        )

        shared {
            private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
                "TESTGSA3920C",
                "ReferenceEquals call",
                "A call to object.ReferenceEquals.",
                "Testing",
                DiagnosticSeverity.Warning,
                isEnabledByDefault: true
            )

            private func Analyze(context BoundNodeAnalysisContext) {
                let operation = cast[BoundCallOperationExpression](context.BoundNode)
                if operation
                    .CalledFunction
                    .Name != "ReferenceEquals" ||
                    operation
                    .Arguments
                    .Length != 2 ||
                    operation
                    .CalledFunction
                    .ContainingType
                    ?.ToDisplayString(DisplayFormat.FullyQualified) != "global::System.Object" {
                    return
                }
                context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax!!.Location))
            }
        }
    }
}
