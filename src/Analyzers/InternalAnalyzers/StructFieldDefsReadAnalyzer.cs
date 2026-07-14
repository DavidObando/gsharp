// <copyright file="StructFieldDefsReadAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace GSharp.InternalAnalyzers;

/// <summary>
/// Flags direct value reads from <c>StructFieldDefs</c> outside the sanctioned resolver methods.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class StructFieldDefsReadAnalyzer : DiagnosticAnalyzer
{
    private const string StructFieldDefsName = "StructFieldDefs";
    private const string ResolveFieldTokenName = "ResolveFieldToken";
    private const string ResolveInterfaceFieldTokenName = "ResolveInterfaceFieldToken";

    /// <inheritdoc />
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; }
        = ImmutableArray.Create(DiagnosticDescriptors.StructFieldDefsRead);

    /// <inheritdoc />
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(AnalyzeElementAccess, SyntaxKind.ElementAccessExpression);
    }

    private static void AnalyzeElementAccess(SyntaxNodeAnalysisContext context)
    {
        var elementAccess = (ElementAccessExpressionSyntax)context.Node;
        if (!IsStructFieldDefsAccess(elementAccess) || IsAssignmentLeftSide(elementAccess) || IsInsideResolver(elementAccess))
        {
            return;
        }

        context.ReportDiagnostic(Diagnostic.Create(DiagnosticDescriptors.StructFieldDefsRead, elementAccess.GetLocation()));
    }

    private static bool IsStructFieldDefsAccess(ElementAccessExpressionSyntax elementAccess)
    {
        return elementAccess.Expression is MemberAccessExpressionSyntax memberAccess
            && memberAccess.Name.Identifier.ValueText == StructFieldDefsName;
    }

    private static bool IsAssignmentLeftSide(ExpressionSyntax expression)
    {
        var current = (SyntaxNode)expression;
        while (current.Parent is ParenthesizedExpressionSyntax)
        {
            current = current.Parent;
        }

        return current.Parent is AssignmentExpressionSyntax assignment && assignment.Left == current;
    }

    private static bool IsInsideResolver(SyntaxNode node)
    {
        var method = node.FirstAncestorOrSelf<MethodDeclarationSyntax>();
        var name = method?.Identifier.ValueText;
        return name == ResolveFieldTokenName || name == ResolveInterfaceFieldTokenName;
    }
}
