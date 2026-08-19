// <copyright file="CSharpToGSharpTranslator.Analyzers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
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
            if (member.Name.Identifier.Text == "OperatorKind"
                && this.context.GetSymbolInfo(member).Symbol is IPropertySymbol { Name: "OperatorKind" } operatorKind
                && RoslynTypeMetadataName(operatorKind.ContainingType) == "Microsoft.CodeAnalysis.Operations.IBinaryOperation")
            {
                // IBinaryOperation.OperatorKind -> BoundBinaryExpression.Op.Kind.
                result = new MemberAccessExpression(
                    new MemberAccessExpression(this.TranslateExpression(member.Expression), "Op", isArrow: false),
                    "Kind",
                    isArrow: false);
                return true;
            }

            if (member.Name.Identifier.Text == "Value"
                && this.context.GetSymbolInfo(member).Symbol is IPropertySymbol { Name: "Value" } argumentValue
                && RoslynTypeMetadataName(argumentValue.ContainingType) == "Microsoft.CodeAnalysis.Operations.IArgumentOperation")
            {
                // IArgumentOperation.Value drops: G# call arguments are the
                // bound expressions directly.
                result = this.TranslateExpression(member.Expression);
                return true;
            }

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

            if (method.Name == "GetSyntax"
                && RoslynTypeMetadataName(method.ContainingType) == "Microsoft.CodeAnalysis.SyntaxReference"
                && invocation.Expression is MemberAccessExpressionSyntax syntaxReferenceReceiver)
            {
                // SyntaxReference.GetSyntax() drops: DeclaringSyntaxNodes
                // already holds the syntax nodes.
                result = this.TranslateExpression(syntaxReferenceReceiver.Expression);
                return true;
            }

            if (method.Name == "ToDisplayString"
                && invocation.ArgumentList.Arguments.Count == 0
                && RoslynTypeMetadataName(method.ContainingType) is "Microsoft.CodeAnalysis.INamespaceSymbol" or "Microsoft.CodeAnalysis.ISymbol"
                && this.context.GetTypeInfo(invocation.Expression is MemberAccessExpressionSyntax r ? r.Expression : invocation.Expression).Type is INamedTypeSymbol receiverType
                && RoslynTypeMetadataName(receiverType) == "Microsoft.CodeAnalysis.INamespaceSymbol"
                && invocation.Expression is MemberAccessExpressionSyntax displayReceiver)
            {
                // INamespaceSymbol.ToDisplayString() drops: G#'s
                // ContainingNamespace already is the display string.
                result = this.TranslateExpression(displayReceiver.Expression);
                return true;
            }

            return false;
        }

        /// <summary>
        /// Rewrites <c>namespaceSymbol?.ToDisplayString()</c> to the bare
        /// receiver: G#'s <c>ContainingNamespace</c> is already the (nullable)
        /// display string.
        /// </summary>
        private bool TryTranslateAnalyzerConditionalDisplay(ConditionalAccessExpressionSyntax conditionalAccess, out GExpression result)
        {
            result = null;
            if (conditionalAccess.WhenNotNull is not InvocationExpressionSyntax { Expression: MemberBindingExpressionSyntax { Name.Identifier.Text: "ToDisplayString" }, ArgumentList.Arguments.Count: 0 }
                || this.context.GetTypeInfo(conditionalAccess.Expression).Type is not INamedTypeSymbol receiverType
                || RoslynTypeMetadataName(receiverType) != "Microsoft.CodeAnalysis.INamespaceSymbol")
            {
                return false;
            }

            result = this.TranslateExpression(conditionalAccess.Expression);
            return true;
        }

        /// <summary>
        /// Rewrites the Roslyn location-picking ternary
        /// (<c>symbol.Locations.Length &gt; 0 ? symbol.Locations[0] : null</c>)
        /// to G#'s <c>Symbol.Location</c>, which is a struct and cannot be
        /// null-defaulted.
        /// </summary>
        private bool TryTranslateAnalyzerLocationsTernary(ConditionalExpressionSyntax conditional, out GExpression result)
        {
            result = null;
            if (conditional.WhenFalse is not LiteralExpressionSyntax whenFalse
                || !whenFalse.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.NullLiteralExpression)
                || conditional.WhenTrue is not ElementAccessExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.Text: "Locations" } locationsAccess }
                || this.context.GetSymbolInfo(locationsAccess).Symbol is not IPropertySymbol { Name: "Locations" } locations
                || !RoslynAnalyzerApiMap.IsRoslynNamespace(locations.ContainingType?.ContainingNamespace?.ToDisplayString()))
            {
                return false;
            }

            result = new MemberAccessExpression(
                this.TranslateExpression(locationsAccess.Expression),
                "Location",
                isArrow: false);
            return true;
        }

        /// <summary>
        /// Rewrites the C# assignment-LHS idiom
        /// (<c>X.Parent is AssignmentExpressionSyntax a &amp;&amp; a.Left == X</c>)
        /// to the faithful G# form: an expression is a write target exactly
        /// when its parent is one of the dedicated write nodes that embed it
        /// (<c>MemberIndexAssignmentExpression</c>,
        /// <c>CompoundIndexAssignmentExpression</c>,
        /// <c>MemberFieldAssignmentExpression</c>). G#'s plain
        /// <c>AssignmentExpression</c> targets an identifier token, so the
        /// literal translation would be constantly false and, worse, miss the
        /// embedded-target write forms (found by the ADR-0169 parity harness).
        /// </summary>
        private bool TryLowerAssignmentLeftConjunction(BinaryExpressionSyntax binary, out GExpression result)
        {
            result = null;
            if (!binary.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.LogicalAndExpression)
                || binary.Left is not IsPatternExpressionSyntax { Expression: { } parentExpression, Pattern: DeclarationPatternSyntax { Designation: SingleVariableDesignationSyntax designation } declarationPattern }
                || binary.Right is not BinaryExpressionSyntax comparison
                || !comparison.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.EqualsExpression))
            {
                return false;
            }

            if (this.context.GetTypeInfo(declarationPattern.Type).Type is not INamedTypeSymbol patternType
                || RoslynTypeMetadataName(patternType) != "Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax")
            {
                return false;
            }

            bool ComparesDesignationLeft(ExpressionSyntax operand)
                => operand is MemberAccessExpressionSyntax { Expression: IdentifierNameSyntax receiver, Name.Identifier.Text: "Left" }
                && receiver.Identifier.Text == designation.Identifier.Text;

            if (!ComparesDesignationLeft(comparison.Left) && !ComparesDesignationLeft(comparison.Right))
            {
                return false;
            }

            const string adaptationNote =
                "Assignment-LHS idiom rewritten to a write-node parent-kind check: in G#, index/member writes are dedicated "
                + "Member/CompoundIndexAssignment and MemberFieldAssignment nodes that embed their target expression.";
            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                adaptationNote,
                binary.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });

            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax");
            GExpression parentKind = new MemberAccessExpression(
                this.TranslateExpression(parentExpression),
                "Kind",
                isArrow: false);
            GExpression Test(string kindName)
                => new BinaryExpression(
                    parentKind,
                    "==",
                    new MemberAccessExpression(new IdentifierExpression("SyntaxKind"), kindName, isArrow: false));

            result = new BinaryExpression(
                new BinaryExpression(
                    Test("MemberIndexAssignmentExpression"),
                    "||",
                    Test("CompoundIndexAssignmentExpression")),
                "||",
                Test("MemberFieldAssignmentExpression"));
            return true;
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

            // x.SpecialType ==/!= SpecialType.System_Y rewrites to a
            // fully-qualified display-string comparison: G# has no SpecialType.
            foreach ((ExpressionSyntax memberSide, ExpressionSyntax enumSide) in new[]
                {
                    (binary.Left, binary.Right),
                    (binary.Right, binary.Left),
                })
            {
                if (memberSide is not MemberAccessExpressionSyntax { Name.Identifier.Text: "SpecialType" } specialAccess
                    || this.context.GetSymbolInfo(specialAccess).Symbol is not IPropertySymbol { Name: "SpecialType" } specialProperty
                    || !RoslynAnalyzerApiMap.IsRoslynNamespace(specialProperty.ContainingType?.ContainingNamespace?.ToDisplayString())
                    || enumSide is not MemberAccessExpressionSyntax { Name.Identifier.Text: { } specialName } enumAccess
                    || !specialName.StartsWith("System_", System.StringComparison.Ordinal)
                    || this.context.GetSymbolInfo(enumAccess).Symbol is not IFieldSymbol { ContainingType.Name: "SpecialType" })
                {
                    continue;
                }

                this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Symbols");
                result = new BinaryExpression(
                    new InvocationExpression(
                        new MemberAccessExpression(this.TranslateExpression(specialAccess.Expression), "ToDisplayString", isArrow: false),
                        new List<GExpression>
                        {
                            new MemberAccessExpression(new IdentifierExpression("DisplayFormat"), "FullyQualified", isArrow: false),
                        }),
                    isEquals ? "==" : "!=",
                    LiteralExpression.String("global::" + specialName.Replace('_', '.')));
                return true;
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
