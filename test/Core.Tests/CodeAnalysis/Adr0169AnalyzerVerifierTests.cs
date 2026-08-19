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
}
