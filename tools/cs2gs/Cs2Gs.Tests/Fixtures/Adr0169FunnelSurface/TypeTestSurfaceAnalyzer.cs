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
        context.RegisterOperationAction(AnalyzeProperty, OperationKind.PropertyReference);
    }

    // Roslyn never sends a field read here, so the rule reads Property
    // directly. G# binds an imported field read to the same node as an
    // imported property read, with a nil Property; the translated rule must
    // never be handed one.
    private static void AnalyzeProperty(OperationAnalysisContext context)
    {
        var operation = (IPropertyReferenceOperation)context.Operation;
        if (operation.Property.Name == "Length")
        {
            context.ReportDiagnostic(Diagnostic.Create(
                DiagnosticDescriptors.NullabilityFunnelBypass,
                context.Operation.Syntax.GetLocation(),
                "property " + operation.Property.Name));
        }
    }

    private static void AnalyzeIsType(OperationAnalysisContext context)
    {
        // Roslyn's TypeOperand is never null here, so the rule reads it
        // directly. The translated rule must therefore never be handed a
        // declaration-pattern is-expression, whose TypeOperand is nil in G#.
        var operation = (IIsTypeOperation)context.Operation;
        if (operation.TypeOperand.Name == WrapperTypeName)
        {
            Check(context, operation.TypeOperand, "is");
        }
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
