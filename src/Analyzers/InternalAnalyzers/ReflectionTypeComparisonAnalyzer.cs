// <copyright file="ReflectionTypeComparisonAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace GSharp.InternalAnalyzers;

/// <summary>
/// Flags reference equality comparisons between reflection <see cref="System.Type"/> values.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ReflectionTypeComparisonAnalyzer : DiagnosticAnalyzer
{
    private const string ClrTypeUtilitiesName = "ClrTypeUtilities";
    private const string TypeIdentityComparerName = "TypeIdentityComparer";

    /// <inheritdoc />
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; }
        = ImmutableArray.Create(DiagnosticDescriptors.ReflectionTypeReferenceComparison);

    /// <inheritdoc />
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterOperationAction(AnalyzeBinary, OperationKind.BinaryOperator);
        context.RegisterOperationAction(AnalyzeInvocation, OperationKind.Invocation);
    }

    private static void AnalyzeBinary(OperationAnalysisContext context)
    {
        if (IsInsideExemptType(context.ContainingSymbol) || !IsCompilerMetadataArea(context.ContainingSymbol?.ContainingNamespace))
        {
            return;
        }

        var operation = (IBinaryOperation)context.Operation;
        var left = UnwrapConversion(operation.LeftOperand);
        var right = UnwrapConversion(operation.RightOperand);
        if ((operation.OperatorKind == BinaryOperatorKind.Equals || operation.OperatorKind == BinaryOperatorKind.NotEquals)
            && IsTypeofComparedToReflectionType(left, right))
        {
            context.ReportDiagnostic(Diagnostic.Create(DiagnosticDescriptors.ReflectionTypeReferenceComparison, operation.Syntax.GetLocation()));
        }
    }

    private static void AnalyzeInvocation(OperationAnalysisContext context)
    {
        if (IsInsideExemptType(context.ContainingSymbol) || !IsCompilerMetadataArea(context.ContainingSymbol?.ContainingNamespace))
        {
            return;
        }

        var operation = (IInvocationOperation)context.Operation;
        if (operation.TargetMethod.Name != nameof(object.ReferenceEquals)
            || operation.Arguments.Length != 2
            || operation.TargetMethod.ContainingType.SpecialType != SpecialType.System_Object)
        {
            return;
        }

        var left = UnwrapConversion(operation.Arguments[0].Value);
        var right = UnwrapConversion(operation.Arguments[1].Value);
        if (IsTypeofComparedToReflectionType(left, right))
        {
            context.ReportDiagnostic(Diagnostic.Create(DiagnosticDescriptors.ReflectionTypeReferenceComparison, operation.Syntax.GetLocation()));
        }
    }

    private static bool IsTypeofComparedToReflectionType(IOperation left, IOperation right)
    {
        if (IsNullLiteral(left) || IsNullLiteral(right))
        {
            return false;
        }

        return (IsTypeof(left) && IsReflectionType(right.Type))
            || (IsTypeof(right) && IsReflectionType(left.Type));
    }

    private static bool IsTypeof(IOperation operation)
    {
        return UnwrapConversion(operation).Kind == OperationKind.TypeOf;
    }

    private static bool IsNullLiteral(IOperation operation)
    {
        return operation.ConstantValue.HasValue && operation.ConstantValue.Value == null;
    }

    private static bool IsCompilerMetadataArea(INamespaceSymbol namespaceSymbol)
    {
        var namespaceName = namespaceSymbol?.ToDisplayString();
        return namespaceName == "GSharp.Core.CodeAnalysis.Emit"
            || namespaceName == "GSharp.Core.CodeAnalysis.Symbols"
            || namespaceName == "GSharp.Core.CodeAnalysis.Binding";
    }

    private static IOperation UnwrapConversion(IOperation operation)
    {
        while (operation is IConversionOperation conversion)
        {
            operation = conversion.Operand;
        }

        return operation;
    }

    private static bool IsInsideExemptType(ISymbol symbol)
    {
        for (var type = symbol?.ContainingType; type != null; type = type.ContainingType)
        {
            if (type.Name == ClrTypeUtilitiesName || type.Name == TypeIdentityComparerName)
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsReflectionType(ITypeSymbol type)
    {
        if (type == null)
        {
            return false;
        }

        return type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) == "global::System.Type"
            || (type.Name == "TypeInfo" && type.ContainingNamespace?.ToDisplayString() == "System.Reflection");
    }
}
