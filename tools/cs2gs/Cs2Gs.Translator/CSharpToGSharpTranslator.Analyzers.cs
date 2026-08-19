// <copyright file="CSharpToGSharpTranslator.Analyzers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.Translator.Analyzers;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Cs2Gs.Translator;

/// <summary>
/// ADR-0169 analyzer translation mode: the per-construct rewrites that turn
/// Roslyn analyzer code into G# analyzer-API code
/// (docs/cs2gs-analyzer-translation.md). Type rewrites live in
/// <see cref="CSharpTypeMapper"/>; this partial holds the member-name, enum-
/// member, invocation-idiom, attribute, and comparison-lowering hooks on the
/// declaration visitor, each an early-out guard in the established
/// TryTranslateGeneratedRegex style.
/// </summary>
public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        private bool InAnalyzerApiMode => this.typeMapper.AnalyzerApiMode;

        private static string RoslynTypeMetadataName(INamedTypeSymbol type)
            => type?.ContainingNamespace is { IsGlobalNamespace: false } ns
                ? $"{ns.ToDisplayString()}.{type.Name}"
                : type?.Name;

        /// <summary>
        /// Rewrites a member name accessed on a Roslyn API type (enum members
        /// and instance members). Identity for unmapped members — the
        /// round-trip binder is the loud backstop when the identity name does
        /// not exist on the G# type.
        /// </summary>
        private string MapAnalyzerMemberName(MemberAccessExpressionSyntax member, string memberName)
        {
            ISymbol symbol = this.context.GetSymbolInfo(member).Symbol;
            INamedTypeSymbol containingType = symbol?.ContainingType;
            string containingName = RoslynTypeMetadataName(containingType);
            if (containingName is null || !RoslynAnalyzerApiMap.IsRoslynNamespace(containingType.ContainingNamespace?.ToDisplayString()))
            {
                return memberName;
            }

            if (symbol is IFieldSymbol { ContainingType.TypeKind: TypeKind.Enum }
                && RoslynAnalyzerApiMap.TryMapEnumMember(containingName, memberName, out RoslynAnalyzerApiMap.Entry enumEntry))
            {
                this.ReportAnalyzerShapeIfAdapted(member, containingName, memberName, enumEntry);
                return enumEntry.GsName;
            }

            if (RoslynAnalyzerApiMap.TryMapMember(containingName, memberName, out RoslynAnalyzerApiMap.Entry memberEntry))
            {
                this.ReportAnalyzerShapeIfAdapted(member, containingName, memberName, memberEntry);
                if (memberEntry.GsName is null)
                {
                    // No G# counterpart. Comparison sites are lowered to a
                    // constant by TryLowerAnalyzerComparison before reaching
                    // here; any other use keeps the C# spelling so the
                    // round-trip binder fails loudly at the exact site.
                    return memberName;
                }

                return memberEntry.GsName;
            }

            return memberName;
        }

        /// <summary>
        /// Member-access-level analyzer idioms that need more than a rename:
        /// <c>name.Identifier</c> on a Roslyn name node becomes
        /// <c>expr.GetLastToken()</c>, because G#'s
        /// <c>AccessorExpressionSyntax.RightPart</c> is an expression with no
        /// Identifier property.
        /// </summary>
        private bool TryTranslateAnalyzerMemberAccess(MemberAccessExpressionSyntax member, out GExpression result)
        {
            result = null;
            if (member.Name.Identifier.Text != "Identifier")
            {
                return false;
            }

            if (this.context.GetSymbolInfo(member).Symbol is not IPropertySymbol { Name: "Identifier" } property
                || RoslynTypeMetadataName(property.ContainingType) is not
                    ("Microsoft.CodeAnalysis.CSharp.Syntax.SimpleNameSyntax"
                    or "Microsoft.CodeAnalysis.CSharp.Syntax.IdentifierNameSyntax"
                    or "Microsoft.CodeAnalysis.CSharp.Syntax.NameSyntax"))
            {
                return false;
            }

            result = new InvocationExpression(
                new MemberAccessExpression(this.TranslateExpression(member.Expression), "GetLastToken", isArrow: false));
            return true;
        }

        /// <summary>
        /// Invocation-level analyzer idioms: Roslyn methods whose G#
        /// counterpart is not a same-shaped method (e.g.
        /// <c>node.GetLocation()</c> → the <c>Location</c> property).
        /// </summary>
        private bool TryTranslateAnalyzerInvocation(InvocationExpressionSyntax invocation, out GExpression result)
        {
            result = null;
            if (this.context.GetSymbolInfo(invocation).Symbol is not IMethodSymbol method
                || !RoslynAnalyzerApiMap.IsRoslynNamespace(method.ContainingType?.ContainingNamespace?.ToDisplayString()))
            {
                return false;
            }

            if (method.Name == "GetLocation"
                && method.Parameters.Length == 0
                && invocation.Expression is MemberAccessExpressionSyntax locationReceiver)
            {
                result = new MemberAccessExpression(
                    this.TranslateExpression(locationReceiver.Expression),
                    "Location",
                    isArrow: false);
                return true;
            }

            return false;
        }

        /// <summary>
        /// Lowers a comparison against a Roslyn member with no G# counterpart
        /// (currently <c>AssignmentExpressionSyntax.Left</c>) to a boolean
        /// constant, with a CS2GS-ANALYZER-SHAPE review warning. In G#, index
        /// and member writes parse as dedicated assignment nodes, so the C#
        /// assignment-LHS check can never be true of a read node.
        /// </summary>
        private bool TryLowerAnalyzerComparison(BinaryExpressionSyntax binary, out GExpression result)
        {
            result = null;
            bool isEquals = binary.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.EqualsExpression);
            bool isNotEquals = binary.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.NotEqualsExpression);
            if (!isEquals && !isNotEquals)
            {
                return false;
            }

            foreach (ExpressionSyntax operand in new[] { binary.Left, binary.Right })
            {
                if (operand is not MemberAccessExpressionSyntax operandAccess
                    || this.context.GetSymbolInfo(operandAccess).Symbol is not { } operandSymbol
                    || operandSymbol.ContainingType is not { } operandContainer)
                {
                    continue;
                }

                string containingName = RoslynTypeMetadataName(operandContainer);
                if (containingName is not null
                    && RoslynAnalyzerApiMap.IsRoslynNamespace(operandContainer.ContainingNamespace?.ToDisplayString())
                    && RoslynAnalyzerApiMap.TryMapMember(containingName, operandSymbol.Name, out RoslynAnalyzerApiMap.Entry entry)
                    && entry.GsName is null)
                {
                    this.context.Report(new TranslationDiagnostic(
                        "analyzer-api",
                        $"Comparison against '{containingName}.{operandSymbol.Name}' lowered to '{(isEquals ? "false" : "true")}': {entry.AdaptationNote}",
                        binary.GetLocation(),
                        TranslationSeverity.Warning)
                    {
                        DiagnosticId = "CS2GS-ANALYZER-SHAPE",
                    });
                    result = LiteralExpression.Bool(!isEquals);
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Substitutes Roslyn analyzer marker attributes:
        /// <c>[DiagnosticAnalyzer(LanguageNames.CSharp)]</c> →
        /// <c>[GSharpDiagnosticAnalyzer]</c>, arguments dropped (G# has one
        /// language).
        /// </summary>
        private bool TryTranslateAnalyzerAttribute(AttributeSyntax attribute, out AttributeUse result)
        {
            result = null;
            if (!this.InAnalyzerApiMode)
            {
                return false;
            }

            ISymbol symbol = this.context.GetSymbolInfo(attribute).Symbol
                ?? this.context.GetSymbolInfo(attribute.Name).Symbol;
            INamedTypeSymbol attributeType = symbol switch
            {
                IMethodSymbol constructor => constructor.ContainingType,
                INamedTypeSymbol namedType => namedType,
                _ => null,
            };

            if (RoslynTypeMetadataName(attributeType) != "Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzerAttribute")
            {
                return false;
            }

            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Analyzers");
            result = new AttributeUse("GSharpDiagnosticAnalyzer", System.Array.Empty<AttributeArgument>(), target: null);
            return true;
        }

        private void ReportAnalyzerShapeIfAdapted(
            SyntaxNode site,
            string containingName,
            string memberName,
            RoslynAnalyzerApiMap.Entry entry)
        {
            if (entry.AdaptationNote is null)
            {
                return;
            }

            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                $"'{containingName}.{memberName}' translated as '{entry.GsName ?? memberName}': {entry.AdaptationNote}",
                site.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });
        }
    }
}
