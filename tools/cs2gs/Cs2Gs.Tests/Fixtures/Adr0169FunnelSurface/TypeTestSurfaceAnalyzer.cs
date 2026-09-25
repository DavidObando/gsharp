// <copyright file="TypeTestSurfaceAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace GSharp.InternalAnalyzers;

/// <summary>
/// ADR-0169 / issue #4436 parity fixture for the type-test surface the
/// ADR-0193 GSA0008 consumer rule (Phase 3) will use: it reports every
/// operation that names a wrapper type — a plain <c>is</c> test, a type,
/// declaration or recursive pattern, and <c>typeof</c>.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class TypeTestSurfaceAnalyzer : DiagnosticAnalyzer
{
    private const string WrapperTypeName = "NullableTypeSymbol";

    /// <inheritdoc />
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; }
        = ImmutableArray.Create(DiagnosticDescriptors.NullabilityFunnelBypass);

    /// <inheritdoc />
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterOperationAction(AnalyzeIsType, OperationKind.IsType);
        context.RegisterOperationAction(
            AnalyzePattern,
            OperationKind.TypePattern,
            OperationKind.DeclarationPattern,
            OperationKind.RecursivePattern);
        context.RegisterOperationAction(AnalyzeTypeOf, OperationKind.TypeOf);
    }

    private static void AnalyzeIsType(OperationAnalysisContext context)
    {
        var operation = (IIsTypeOperation)context.Operation;
        Check(context, operation.TypeOperand, "is");
    }

    private static void AnalyzePattern(OperationAnalysisContext context)
    {
        if (context.Operation is ITypePatternOperation typePattern)
        {
            Check(context, typePattern.MatchedType, "pattern");
        }
        else if (context.Operation is IDeclarationPatternOperation declarationPattern)
        {
            Check(context, declarationPattern.MatchedType, "pattern");
        }
        else if (context.Operation is IRecursivePatternOperation recursivePattern)
        {
            Check(context, recursivePattern.MatchedType, "pattern");
        }
    }

    private static void AnalyzeTypeOf(OperationAnalysisContext context)
    {
        var operation = (ITypeOfOperation)context.Operation;
        Check(context, operation.TypeOperand, "typeof");
    }

    private static void Check(OperationAnalysisContext context, ITypeSymbol? type, string form)
    {
        if (type != null && type.Name == WrapperTypeName)
        {
            context.ReportDiagnostic(Diagnostic.Create(
                DiagnosticDescriptors.NullabilityFunnelBypass,
                context.Operation.Syntax.GetLocation(),
                form + " " + type.Name));
        }
    }
}
