// <copyright file="DescendantsSurfaceAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace GSharp.InternalAnalyzers;

/// <summary>
/// ADR-0169 / issue #4436 parity fixture for the operation-tree walk itself.
/// It reports every local reference, invocation and type pattern that
/// <c>Descendants()</c> yields from each operation block. Three shapes where
/// the G# walker differs from Roslyn's operation tree are covered: an
/// assignment's target is a child, a lambda's body is inside the block, and a
/// plain <c>x is T</c> has no pattern under it.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class DescendantsSurfaceAnalyzer : DiagnosticAnalyzer
{
    /// <inheritdoc />
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; }
        = ImmutableArray.Create(DiagnosticDescriptors.NullabilityFunnelBypass);

    /// <inheritdoc />
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterOperationBlockAction(AnalyzeBlock);
    }

    private static void AnalyzeBlock(OperationBlockAnalysisContext context)
    {
        foreach (IOperation block in context.OperationBlocks)
        {
            foreach (IOperation operation in block.Descendants())
            {
                string? text = null;
                if (operation is ILocalReferenceOperation local)
                {
                    text = "local " + local.Local.Name;
                }
                else if (operation is IInvocationOperation call)
                {
                    text = "call " + call.TargetMethod.Name;
                }
                else if (operation is ITypePatternOperation)
                {
                    text = "pattern";
                }

                if (text != null)
                {
                    context.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticDescriptors.NullabilityFunnelBypass,
                        operation.Syntax.GetLocation(),
                        text));
                }
            }
        }
    }
}
