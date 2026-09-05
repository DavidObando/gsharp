// <copyright file="Issue3920BoundOperationShapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.CodeAnalysis.Analyzers.Testing;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3920: the ADR-0169 analyzer surface over the bound tree's
/// PROVENANCE SPLIT.
///
/// <para>
/// G# binds one program construct to different nodes depending on where the
/// operator or callee came from: <c>a == b</c> is a
/// <see cref="BoundBinaryExpression"/> for a built-in operator and a
/// <see cref="BoundClrBinaryOperatorExpression"/> when it resolves to an
/// <c>op_Equality</c> method, and a call is one of three nodes by callee
/// provenance. That is a codegen distinction; to an analyzer it is one shape,
/// which is why <see cref="BoundBinaryOperationExpression"/> and
/// <see cref="BoundCallOperationExpression"/> exist.
/// </para>
///
/// <para>
/// The failure this guards is SILENCE, not a wrong answer: a rule written
/// against the built-in nodes alone sees none of the imported code, and code
/// that compares reflection <see cref="System.Type"/> values is imported by
/// construction — so GSA0002 policed exactly the program it could not observe.
/// Each positive here therefore demands a diagnostic on an imported operand or
/// an imported callee, and its companion demands silence where the construct
/// is genuinely absent.
/// </para>
/// </summary>
public class Issue3920BoundOperationShapeTests
{
    /// <summary>
    /// An <c>==</c> over two imported <c>System.Type</c> values binds to
    /// <see cref="BoundClrBinaryOperatorExpression"/>, and an analyzer
    /// registered for both binary kinds sees it through the shared base —
    /// operands and operator kind included.
    /// </summary>
    [Fact]
    public void ImportedOperandEquality_IsSeenAsABinaryOperation()
    {
        GSharpAnalyzerVerifier<EqualityOverTypeAnalyzer>.VerifyAnalyzer(
            @"package App

import System

class C {
    func Same(left Type, right Type) bool {
        return [|left == right|]
    }
}
",
            "TESTGSA3920A");
    }

    /// <summary>
    /// The built-in operator still arrives at the same handler: the base spans
    /// both provenances rather than swapping one blind spot for the other.
    /// </summary>
    [Fact]
    public void BuiltInOperandEquality_IsSeenAsTheSameBinaryOperation()
    {
        GSharpAnalyzerVerifier<EqualityAnalyzer>.VerifyAnalyzer(
            @"package App

func Same(left int32, right int32) bool {
    return [|left == right|]
}
",
            "TESTGSA3920B");
    }

    /// <summary>
    /// The falsifier for both: a comparison that is not an equality must not
    /// report, so a handler that fired on every node it received could not
    /// pass the positives above.
    /// </summary>
    [Fact]
    public void NonEqualityComparison_IsNotReported()
    {
        GSharpAnalyzerVerifier<EqualityAnalyzer>.VerifyAnalyzer(
            @"package App

func Less(left int32, right int32) bool {
    return left < right
}
");
    }

    /// <summary>
    /// A static call into metadata binds to
    /// <c>BoundImportedCallExpression</c>, and the callee's declaring type is
    /// reachable through <see cref="Symbol.ContainingType"/> — which used to be
    /// null for every imported symbol, because nothing anchors them.
    /// </summary>
    [Fact]
    public void ImportedStaticCall_ExposesItsDeclaringTypeThroughCalledFunction()
    {
        GSharpAnalyzerVerifier<ReferenceEqualsCallAnalyzer>.VerifyAnalyzer(
            @"package App

import System

class C {
    func Same(left Type, right Type) bool {
        return object.[|ReferenceEquals(left, right)|]
    }
}
",
            "TESTGSA3920C");
    }

    /// <summary>
    /// The falsifier: a different imported static call reaches the same
    /// handler and is rejected on its name and declaring type, so the positive
    /// above is evidence the gate ran rather than evidence it was skipped.
    /// </summary>
    [Fact]
    public void OtherImportedStaticCall_IsNotReported()
    {
        GSharpAnalyzerVerifier<ReferenceEqualsCallAnalyzer>.VerifyAnalyzer(
            @"package App

import System

class C {
    func Describe(value Type) string {
        return string.Concat(value.Name, value.Name)
    }
}
");
    }

    /// <summary>
    /// Reports every equality binary operation, whatever node the binder chose
    /// for it.
    /// </summary>
    [GSharpDiagnosticAnalyzer]
    public sealed class EqualityAnalyzer : GSharpDiagnosticAnalyzer
    {
        private static readonly DiagnosticDescriptor Rule = new(
            "TESTGSA3920B",
            "Equality binary operation",
            "An equality binary operation.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true);

        /// <inheritdoc/>
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

        /// <inheritdoc/>
        public override void Initialize(AnalysisContext context)
            => context.RegisterBoundNodeAction(
                Analyze,
                BoundNodeKind.BinaryExpression,
                BoundNodeKind.ClrBinaryOperatorExpression);

        private static void Analyze(BoundNodeAnalysisContext context)
        {
            var operation = (BoundBinaryOperationExpression)context.BoundNode;
            if (operation.BinaryOperatorKind != BoundBinaryOperatorKind.Equals)
            {
                return;
            }

            Assert.NotNull(operation.Left);
            Assert.NotNull(operation.Right);
            context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax.Location));
        }
    }

    /// <summary>
    /// The same rule, restricted to operands of the imported reflection
    /// <c>Type</c> — the shape that reaches the handler only as a
    /// <see cref="BoundClrBinaryOperatorExpression"/>.
    /// </summary>
    [GSharpDiagnosticAnalyzer]
    public sealed class EqualityOverTypeAnalyzer : GSharpDiagnosticAnalyzer
    {
        private static readonly DiagnosticDescriptor Rule = new(
            "TESTGSA3920A",
            "Equality over reflection Type",
            "An equality binary operation over reflection Type operands.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true);

        /// <inheritdoc/>
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

        /// <inheritdoc/>
        public override void Initialize(AnalysisContext context)
            => context.RegisterBoundNodeAction(
                Analyze,
                BoundNodeKind.BinaryExpression,
                BoundNodeKind.ClrBinaryOperatorExpression);

        private static void Analyze(BoundNodeAnalysisContext context)
        {
            var operation = (BoundBinaryOperationExpression)context.BoundNode;
            if (operation.BinaryOperatorKind != BoundBinaryOperatorKind.Equals
                || operation.Left.Type?.ToDisplayString(DisplayFormat.FullyQualified) != "global::System.Type")
            {
                return;
            }

            context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax.Location));
        }
    }

    /// <summary>
    /// Reports <c>object.ReferenceEquals</c> calls, identified through
    /// <see cref="BoundCallOperationExpression.CalledFunction"/> and its
    /// declaring type.
    /// </summary>
    [GSharpDiagnosticAnalyzer]
    public sealed class ReferenceEqualsCallAnalyzer : GSharpDiagnosticAnalyzer
    {
        private static readonly DiagnosticDescriptor Rule = new(
            "TESTGSA3920C",
            "ReferenceEquals call",
            "A call to object.ReferenceEquals.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true);

        /// <inheritdoc/>
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

        /// <inheritdoc/>
        public override void Initialize(AnalysisContext context)
            => context.RegisterBoundNodeAction(
                Analyze,
                BoundNodeKind.CallExpression,
                BoundNodeKind.ImportedCallExpression,
                BoundNodeKind.ImportedInstanceCallExpression);

        private static void Analyze(BoundNodeAnalysisContext context)
        {
            var operation = (BoundCallOperationExpression)context.BoundNode;
            if (operation.CalledFunction.Name != "ReferenceEquals"
                || operation.Arguments.Length != 2
                || operation.CalledFunction.ContainingType?.ToDisplayString(DisplayFormat.FullyQualified)
                    != "global::System.Object")
            {
                return;
            }

            context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax.Location));
        }
    }
}
