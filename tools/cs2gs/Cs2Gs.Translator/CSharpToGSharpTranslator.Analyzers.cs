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

            if (member.Name.Identifier.Text == "ArgumentList"
                && member.Parent is MemberAccessExpressionSyntax { Name.Identifier.Text: "Arguments" }
                && this.context.GetSymbolInfo(member).Symbol is IPropertySymbol { Name: "ArgumentList" } argumentListProperty
                && RoslynAnalyzerApiMap.IsRoslynNamespace(argumentListProperty.ContainingType?.ContainingNamespace?.ToDisplayString()))
            {
                // InvocationExpressionSyntax.ArgumentList.Arguments drops the
                // wrapper: G#'s CallExpressionSyntax exposes Arguments
                // directly, with no ArgumentListSyntax wrapper. Restricted to
                // the .Arguments chain so other ArgumentList reads (e.g.
                // `.ArgumentList.Span`) stay a loud gap instead of silently
                // observing a different node.
                result = this.TranslateExpression(member.Expression);
                return true;
            }

            if (member.Name.Identifier.Text == "ParameterList"
                && member.Parent is MemberAccessExpressionSyntax { Name.Identifier.Text: "Parameters" }
                && this.context.GetSymbolInfo(member).Symbol is IPropertySymbol { Name: "ParameterList" } parameterListProperty
                && RoslynAnalyzerApiMap.IsRoslynNamespace(parameterListProperty.ContainingType?.ContainingNamespace?.ToDisplayString()))
            {
                // BaseMethodDeclarationSyntax.ParameterList.Parameters drops
                // the wrapper: G#'s FunctionDeclarationSyntax exposes
                // Parameters directly, with no ParameterListSyntax wrapper.
                // Restricted to the .Parameters chain so other ParameterList
                // reads (e.g. `.ParameterList.Span`) stay a loud gap instead
                // of silently observing a different node.
                result = this.TranslateExpression(member.Expression);
                return true;
            }

            if (member.Name.Identifier.Text == "Expression"
                && this.context.GetSymbolInfo(member).Symbol is IPropertySymbol { Name: "Expression" } argumentExpressionProperty
                && RoslynTypeMetadataName(argumentExpressionProperty.ContainingType) == "Microsoft.CodeAnalysis.CSharp.Syntax.ArgumentSyntax")
            {
                // ArgumentSyntax.Expression drops: G# call arguments are the
                // bound expressions directly, with no ArgumentSyntax wrapper.
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
        /// Extracts the type-name expression from a bare type-test subpattern
        /// (<c>{ Member: SomeType }</c>, no designation). The C# parser emits
        /// this as a <see cref="TypePatternSyntax"/> only when it can tell
        /// syntactically; a bare simple name is ambiguous with a constant
        /// pattern at parse time, so it comes through as a
        /// <see cref="ConstantPatternSyntax"/> whose expression the binder
        /// resolves to a type symbol instead. Returns null for anything else.
        /// </summary>
        private static ExpressionSyntax BaseSubpatternTypeSyntax(PatternSyntax pattern) => pattern switch
        {
            TypePatternSyntax typePattern => typePattern.Type,
            ConstantPatternSyntax constantPattern => constantPattern.Expression,
            _ => null,
        };

        /// <summary>
        /// Rewrites the C# base-call detection idiom
        /// (<c>invocation.Expression is MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax }</c>)
        /// to G#'s faithful shape. G# gives <c>base.M(...)</c> its own
        /// <c>BaseClassCallExpressionSyntax</c> node wrapping an ordinary
        /// <c>CallExpressionSyntax</c> as its <c>Call</c>, rather than parsing
        /// it as a member access on a <c>base</c> receiver (issue #2534) — so a
        /// call found by walking for <c>CallExpressionSyntax</c> nodes is a
        /// base call exactly when its <em>parent</em> is that wrapper node.
        /// </summary>
        private bool TryTranslateAnalyzerBaseCallCheck(IsPatternExpressionSyntax isPattern, out GExpression result)
        {
            result = null;
            if (isPattern.Expression is not MemberAccessExpressionSyntax { Name.Identifier.Text: "Expression" } expressionAccess
                || this.context.GetSymbolInfo(expressionAccess).Symbol is not IPropertySymbol { Name: "Expression" } expressionProperty
                || RoslynTypeMetadataName(expressionProperty.ContainingType) != "Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax"
                || isPattern.Pattern is not RecursivePatternSyntax { Designation: null, PositionalPatternClause: null, PropertyPatternClause.Subpatterns: [SubpatternSyntax subpattern] } recursivePattern
                || subpattern.ExpressionColon?.Expression is not IdentifierNameSyntax { Identifier.Text: "Expression" }
                || BaseSubpatternTypeSyntax(subpattern.Pattern) is not { } baseTypeSyntax
                || this.context.GetTypeInfo(recursivePattern.Type).Type is not INamedTypeSymbol recursiveType
                || RoslynTypeMetadataName(recursiveType) != "Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax"
                || this.context.GetTypeInfo(baseTypeSyntax).Type is not INamedTypeSymbol baseType
                || RoslynTypeMetadataName(baseType) != "Microsoft.CodeAnalysis.CSharp.Syntax.BaseExpressionSyntax")
            {
                return false;
            }

            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                "Base-call detection idiom 'invocation.Expression is MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax }' translated as 'invocation.Parent is BaseClassCallExpressionSyntax': G# gives base.M(...) its own node wrapping an ordinary call, rather than a member access on a base receiver.",
                isPattern.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });

            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax");
            result = new PatternTestExpression(
                new MemberAccessExpression(this.TranslateExpression(expressionAccess.Expression), "Parent", isArrow: false),
                new TypePattern("_", new NamedTypeReference("BaseClassCallExpressionSyntax"), designationAfterType: true));
            return true;
        }

        /// <summary>
        /// Rewrites the C# switch-label walk idiom
        /// (<c>switchStatement.Sections.SelectMany(s => s.Labels).OfType&lt;CasePatternSwitchLabelSyntax&gt;()</c>)
        /// to a direct walk over G#'s cases. G# switch cases carry one pattern
        /// each via <c>SwitchCaseSyntax.Value</c> with no section/label
        /// nesting, and have no <c>default</c>-arm or pattern-label subtype to
        /// filter with <c>OfType</c>. Roslyn's <c>CasePatternSwitchLabelSyntax</c>
        /// excludes both the <c>default</c> arm and plain constant labels
        /// (<c>CaseSwitchLabelSyntax</c>, e.g. <c>case 5:</c>) — cs2gs's own
        /// switch-label translation (<see cref="CSharpToGSharpTranslator"/>'s
        /// case-label lowering) turns a plain constant label into a G#
        /// <c>ConstantPatternSyntax</c> value with no guard, while a guarded
        /// constant (<c>case 5 when b:</c>, still a
        /// <c>CasePatternSwitchLabelSyntax</c> in Roslyn because <c>when</c>
        /// forces pattern-label parsing) keeps a non-null <c>Guard</c>. So the
        /// faithful G# equivalent excludes the <c>default</c> arm and any
        /// unguarded <c>ConstantPatternSyntax</c> value: <c>Cases.Where(c =&gt;
        /// !c.IsDefault &amp;&amp; (c.Guard != nil || c.Value is not
        /// ConstantPatternSyntax))</c> (#3536).
        /// </summary>
        private bool TryTranslateAnalyzerSwitchLabelWalk(InvocationExpressionSyntax invocation, out GExpression result)
        {
            result = null;
            if (this.context.GetSymbolInfo(invocation).Symbol is not IMethodSymbol { Name: "OfType" } ofTypeMethod
                || ofTypeMethod.TypeArguments.Length != 1
                || RoslynTypeMetadataName(ofTypeMethod.TypeArguments[0] as INamedTypeSymbol) != "Microsoft.CodeAnalysis.CSharp.Syntax.CasePatternSwitchLabelSyntax"
                || invocation.Expression is not MemberAccessExpressionSyntax { Expression: InvocationExpressionSyntax selectManyInvocation }
                || this.context.GetSymbolInfo(selectManyInvocation).Symbol is not IMethodSymbol { Name: "SelectMany" }
                || selectManyInvocation.Expression is not MemberAccessExpressionSyntax { Name.Identifier.Text: "SelectMany", Expression: MemberAccessExpressionSyntax { Name.Identifier.Text: "Sections" } sectionsAccess }
                || this.context.GetSymbolInfo(sectionsAccess).Symbol is not IPropertySymbol { Name: "Sections" } sectionsProperty
                || RoslynTypeMetadataName(sectionsProperty.ContainingType) != "Microsoft.CodeAnalysis.CSharp.Syntax.SwitchStatementSyntax"
                || selectManyInvocation.ArgumentList.Arguments.Count != 1
                || selectManyInvocation.ArgumentList.Arguments[0].Expression is not SimpleLambdaExpressionSyntax { Parameter.Identifier.Text: { } sectionParameterName, ExpressionBody: MemberAccessExpressionSyntax { Name.Identifier.Text: "Labels" } labelsAccess }
                || labelsAccess.Expression is not IdentifierNameSyntax { Identifier.Text: { } labelsReceiverName }
                || labelsReceiverName != sectionParameterName
                || this.context.GetSymbolInfo(labelsAccess).Symbol is not IPropertySymbol { Name: "Labels" } labelsProperty
                || RoslynTypeMetadataName(labelsProperty.ContainingType) != "Microsoft.CodeAnalysis.CSharp.Syntax.SwitchSectionSyntax")
            {
                return false;
            }

            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                "'Sections.SelectMany(s => s.Labels).OfType<CasePatternSwitchLabelSyntax>()' translated as 'Cases.Where(c => !c.IsDefault && (c.Guard != nil || c.Value is not ConstantPatternSyntax))': G# switch cases carry one pattern each with no section/label nesting or default-arm/pattern-label subtype, so the walk excludes the default arm and unguarded constant-value cases (Roslyn's plain, non-pattern case labels) to keep only genuine pattern labels.",
                invocation.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });

            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax");
            GExpression cases = new MemberAccessExpression(
                this.TranslateExpression(sectionsAccess.Expression),
                "Cases",
                isArrow: false);
            var filterParameter = new Parameter("switchCase", new NamedTypeReference("SwitchCaseSyntax"));
            GExpression switchCaseIdentifier = new IdentifierExpression("switchCase");
            GExpression notDefault = new UnaryExpression(
                "!",
                new MemberAccessExpression(switchCaseIdentifier, "IsDefault", isArrow: false));
            GExpression hasGuard = new BinaryExpression(
                new MemberAccessExpression(switchCaseIdentifier, "Guard", isArrow: false),
                "!=",
                LiteralExpression.Null());
            GExpression valueIsNotConstant = new PatternTestExpression(
                new MemberAccessExpression(switchCaseIdentifier, "Value", isArrow: false),
                new NotPattern(new TypePattern("_", new NamedTypeReference("ConstantPatternSyntax"), designationAfterType: true)));
            GExpression filterBody = new BinaryExpression(
                notDefault,
                "&&",
                new BinaryExpression(hasGuard, "||", valueIsNotConstant));
            result = new InvocationExpression(
                new MemberAccessExpression(cases, "Where", isArrow: false),
                new List<GExpression>
                {
                    new LambdaExpression(new List<Parameter> { filterParameter }, expressionBody: filterBody),
                });
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

            if (method.Name == "Any"
                && invocation.ArgumentList.Arguments.Count == 1
                && invocation.Expression is MemberAccessExpressionSyntax anyReceiver
                && anyReceiver.Expression is MemberAccessExpressionSyntax { Name.Identifier.Text: "Modifiers" } modifiersReceiver
                && this.context.GetSymbolInfo(modifiersReceiver).Symbol is IPropertySymbol { Name: "Modifiers" } modifiersProperty
                && RoslynAnalyzerApiMap.IsRoslynNamespace(modifiersProperty.ContainingType?.ContainingNamespace?.ToDisplayString())
                && invocation.ArgumentList.Arguments[0].Expression is MemberAccessExpressionSyntax overrideKeywordArgument
                && this.context.GetSymbolInfo(overrideKeywordArgument).Symbol is IFieldSymbol { Name: "OverrideKeyword" } overrideKeywordField
                && RoslynTypeMetadataName(overrideKeywordField.ContainingType) == "Microsoft.CodeAnalysis.CSharp.SyntaxKind")
            {
                // declaration.Modifiers.Any(SyntaxKind.OverrideKeyword) -> G#'s
                // FunctionDeclarationSyntax.IsOverride: there is no modifier
                // token list, only discrete typed modifier properties.
                this.context.Report(new TranslationDiagnostic(
                    "analyzer-api",
                    "'Modifiers.Any(SyntaxKind.OverrideKeyword)' translated as 'IsOverride': G# has no modifier token list, only discrete typed modifier properties.",
                    invocation.GetLocation(),
                    TranslationSeverity.Warning)
                {
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE",
                });
                result = new MemberAccessExpression(
                    this.TranslateExpression(modifiersReceiver.Expression),
                    "IsOverride",
                    isArrow: false);
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
