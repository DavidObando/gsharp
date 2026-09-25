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
    /// <summary>
    /// Issue #4173 round 3, §4.5: the Roslyn type metadata names this
    /// translator treats as sharing a G# node with their null-conditional
    /// sibling (<see cref="DeclarationVisitor.PlainAccessAnalyzerTypes"/> plus
    /// <see cref="DeclarationVisitor.ConditionalAccessTypeName"/>) — exposed so
    /// a Cs2Gs.Tests drift test can assert this set agrees with
    /// <see cref="RoslynAnalyzerApiMap"/>'s own <c>SharedGsNode</c>-flagged
    /// rows, so a future shared-node row added to one registry but not the
    /// other fails loudly instead of silently shipping the over-match bug a
    /// fourth time.
    /// </summary>
    /// <returns>The flagged rows' Roslyn metadata names.</returns>
    internal static IEnumerable<string> EnumerateAnalyzerSharedGsNodeTypeNames() =>
        DeclarationVisitor.PlainAccessAnalyzerTypes.Keys
            .Append(DeclarationVisitor.ConditionalAccessTypeName);

    private sealed partial class DeclarationVisitor
    {
        /// <summary>
        /// The Roslyn syntax type whose G# counterpart is a PREDICATE
        /// (<c>NullConditionalChain.AsNullConditionalHop(x) != nil</c>), not a node
        /// type — so, unlike <see cref="PlainAccessAnalyzerTypes"/>, it has no pure
        /// G# pattern form and can only be expressed where a boolean is accepted.
        /// </summary>
        internal const string ConditionalAccessTypeName =
            "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax";

        /// <summary>
        /// The Roslyn syntax types whose G# counterpart node is SHARED with the
        /// null-conditional spelling of the same access, so a bare type-name
        /// substitution silently over-matches (issue #4173 §6 and its
        /// ElementAccess sibling). Each entry names the G# node the ORDINARY
        /// (non-null-conditional) access maps to; the faithful rewrite is that
        /// node plus an <c>IsNullConditional: false</c> discriminator, which is
        /// a PURE G# pattern and therefore composes in every pattern position.
        /// </summary>
        internal static readonly Dictionary<string, string> PlainAccessAnalyzerTypes =
            new(System.StringComparer.Ordinal)
            {
                ["Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax"] = "AccessorExpressionSyntax",
                ["Microsoft.CodeAnalysis.CSharp.Syntax.ElementAccessExpressionSyntax"] = "IndexExpressionSyntax",
            };

        /// <summary>
        /// The G# namespace holding the ADR-0169 verifier package that a
        /// migrated Roslyn analyzer test harness delegates to.
        /// </summary>
        private const string AnalyzerVerifierNamespace = "GSharp.CodeAnalysis.Analyzers.Testing";

        private bool InAnalyzerApiMode => this.typeMapper.AnalyzerApiMode;

        private static string RoslynTypeMetadataName(INamedTypeSymbol type)
            => type?.ContainingNamespace is { IsGlobalNamespace: false } ns
                ? $"{ns.ToDisplayString()}.{type.Name}"
                : type?.Name;

        /// <summary>
        /// Builds a call to one of the <c>GSharp.Core.CodeAnalysis.Syntax.NullConditionalChain</c>
        /// static helpers (issue #4173) — the shared entry point every I1/I3/I3a/I4/I5/I8 idiom below
        /// uses to reach the src/Core runtime utility that walks a G# null-conditional access chain.
        /// </summary>
        /// <param name="methodName">The <c>NullConditionalChain</c> member name.</param>
        /// <param name="arguments">The call arguments.</param>
        /// <returns>The invocation expression.</returns>
        private GExpression InvokeNullConditionalChain(string methodName, params GExpression[] arguments)
        {
            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax");
            return new InvocationExpression(
                new MemberAccessExpression(new IdentifierExpression("NullConditionalChain"), methodName, isArrow: false),
                new List<GExpression>(arguments));
        }

        /// <summary>
        /// Builds <c>(expr as TypeName)!!</c> — the same non-smart-castable
        /// narrowing shape <c>BuildPatternNarrowingReplacement</c> already
        /// uses elsewhere in this translator — for a designator whose
        /// SOUNDNESS is proven by a <c>NullConditionalChain</c> predicate
        /// rather than by a native G# type test, so it needs an explicit
        /// downcast to be usable as the narrower type afterward.
        /// </summary>
        /// <param name="expression">The expression to narrow.</param>
        /// <param name="typeName">The G# type to narrow to.</param>
        /// <returns>The narrowed, asserted-non-null expression.</returns>
        private static GExpression NarrowToType(GExpression expression, string typeName)
            => new NonNullAssertionExpression(
                new ParenthesizedExpression(
                    new BinaryExpression(expression, "as", new TypeExpression(new NamedTypeReference(typeName)))));

        /// <summary>Resolves a pattern's type-position expression to its Roslyn metadata name, or null.</summary>
        private string AnalyzerPatternTypeName(ExpressionSyntax typeSyntax)
            => typeSyntax is null || !this.InAnalyzerApiMode
                ? null
                : RoslynTypeMetadataName(
                    (this.context.GetTypeInfo(typeSyntax).Type
                     ?? this.context.GetSymbolInfo(typeSyntax).Symbol as ITypeSymbol) as INamedTypeSymbol);

        private bool IsPlainAccessAnalyzerType(ExpressionSyntax typeSyntax, out string gsNodeName)
        {
            gsNodeName = null;
            string name = this.AnalyzerPatternTypeName(typeSyntax);
            return name != null && PlainAccessAnalyzerTypes.TryGetValue(name, out gsNodeName);
        }

        private bool IsConditionalAccessAnalyzerType(ExpressionSyntax typeSyntax)
            => this.AnalyzerPatternTypeName(typeSyntax) == ConditionalAccessTypeName;

        /// <summary>
        /// True when ANY node anywhere inside <paramref name="pattern"/> names
        /// <c>ConditionalAccessExpressionSyntax</c> (issue #4173, round 3).
        /// <para>
        /// Deliberately a flat <c>SyntaxNode.DescendantNodesAndSelf</c> scan
        /// with NO switch over pattern kinds. Two earlier fixes for this exact
        /// soundness bug discriminated by enumerating C# pattern shapes
        /// (<c>IsPatternTypeSyntax</c>'s three cases), and BOTH failed open on the
        /// shapes the enumeration omitted (<c>not</c>, <c>and</c>/<c>or</c>,
        /// <c>case</c> labels, nested recursive subpatterns). A scan cannot be
        /// defeated by a pattern shape nobody enumerated; do not "simplify" it
        /// back into a shape walk.
        /// </para>
        /// </summary>
        private bool PatternMentionsConditionalAccessType(PatternSyntax pattern, out ExpressionSyntax site)
        {
            site = null;
            if (!this.InAnalyzerApiMode || pattern is null)
            {
                return false;
            }

            foreach (SyntaxNode node in pattern.DescendantNodesAndSelf())
            {
                if (node is ExpressionSyntax candidate && this.IsConditionalAccessAnalyzerType(candidate))
                {
                    site = candidate;
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// The single pattern-position type mapping (issue #4173 round 3). Returns
        /// the G# type the pattern should test, plus the extra property-pattern
        /// field the faithful rewrite needs for a shared-node Roslyn type
        /// (<see cref="PlainAccessAnalyzerTypes"/>), or null for an ordinary type.
        /// </summary>
        private GTypeReference MapPatternTypeSyntax(
            ExpressionSyntax typeSyntax, SyntaxNode site, out PropertyPatternField discriminator)
        {
            discriminator = null;
            if (this.IsPlainAccessAnalyzerType(typeSyntax, out string gsNodeName))
            {
                this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax");
                this.ReportPlainAccessShape(site, gsNodeName);
                discriminator = new PropertyPatternField(
                    "IsNullConditional", new ConstantPattern(LiteralExpression.Bool(false)));
                return new NamedTypeReference(gsNodeName);
            }

            if (this.IsConditionalAccessAnalyzerType(typeSyntax))
            {
                // Reached only from a GPattern-only position (a switch label /
                // switch-expression arm / a nested property subpattern that could
                // not be boolean-lowered). CAE's faithful G# form is a PREDICATE,
                // not a node type, so there is no sound pattern to emit here.
                this.ReportConditionalAccessPatternGap(site);
            }

            return typeSyntax is TypeSyntax type
                ? this.MapTypeSyntax(type)
                : this.MapTypeReferenceExpression(typeSyntax);
        }

        /// <summary>Builds a pattern-position type test, merging any §6 discriminator into the suffix.</summary>
        private GPattern BuildPatternTypeTest(
            string designator,
            ExpressionSyntax typeSyntax,
            SyntaxNode site,
            PropertyPattern suffix = null,
            bool designationAfterType = false)
        {
            GTypeReference mapped = this.MapPatternTypeSyntax(typeSyntax, site, out PropertyPatternField discriminator);
            if (discriminator != null)
            {
                var fields = new List<PropertyPatternField> { discriminator };
                if (suffix != null)
                {
                    fields.AddRange(suffix.Fields);
                }

                suffix = new PropertyPattern(fields, suffix?.Designator);
            }

            return new TypePattern(designator, mapped, suffix, designationAfterType);
        }

        /// <summary>Builds a BOOLEAN-position type test (the `x is T` lowering).</summary>
        private GExpression BuildTypeTestExpression(
            GExpression receiver, ExpressionSyntax typeSyntax, SyntaxNode site)
        {
            if (this.IsConditionalAccessAnalyzerType(typeSyntax))
            {
                // Distinct from MapPatternTypeSyntax's gap path: this IS the
                // sound rewrite, reachable because the caller is a BOOLEAN
                // position, not a G#-pattern-only position.
                this.ReportConditionalAccessBooleanShape(site);
                return new BinaryExpression(
                    this.InvokeNullConditionalChain("AsNullConditionalHop", receiver),
                    "!=",
                    LiteralExpression.Null());
            }

            GPattern test = this.BuildPatternTypeTest(
                "_", typeSyntax, site, suffix: null, designationAfterType: true);
            return test is TypePattern { Suffix: null } bare
                ? new BinaryExpression(receiver, "is", new TypeExpression(bare.Type))
                : new PatternTestExpression(receiver, test);
        }

        private void ReportPlainAccessShape(SyntaxNode site, string gsNodeName)
        {
            string roslynName = gsNodeName == "AccessorExpressionSyntax"
                ? "MemberAccessExpressionSyntax"
                : "ElementAccessExpressionSyntax";
            string shapeNote =
                $"'{roslynName}' in a pattern position translated to "
                + $"'{gsNodeName} {{ IsNullConditional: false }}': G# folds the null-conditional spelling of "
                + "this access onto the SAME node, distinguished only by that flag — a bare type-name "
                + "substitution would silently over-match a null-conditional hop too (issue #4173 round 3).";
            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                shapeNote,
                site.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });
        }

        private void ReportConditionalAccessBooleanShape(SyntaxNode site)
        {
            const string ShapeNote =
                "'ConditionalAccessExpressionSyntax' translated to 'NullConditionalChain.AsNullConditionalHop(expr) "
                + "!= nil': G# folds a?.b onto the SAME node as a.b and a?[i] onto the SAME node as a[i], so the "
                + "faithful test is a predicate, not a type test (issue #4173 round 3).";
            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                ShapeNote,
                site.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });
        }

        private void ReportConditionalAccessPatternGap(SyntaxNode site)
        {
            const string GapNote =
                "'ConditionalAccessExpressionSyntax' in a pattern position that G# can only express as a "
                + "PATTERN (a switch label, a switch-expression arm, or a nested property subpattern) has no "
                + "sound rewrite: G# folds a?.b onto the SAME node as a.b and a?[i] onto the SAME node as a[i], "
                + "so the only faithful test is the PREDICATE NullConditionalChain.AsNullConditionalHop(x) != nil, "
                + "which is not a pattern. Restructure as an 'is'-expression (issue #4173).";
            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                GapNote,
                site.GetLocation(),
                TranslationSeverity.Unsupported)
            {
                DiagnosticId = "CS2GS-GAP",
            });
        }

        /// <summary>
        /// True when <paramref name="expression"/> is <c>&lt;something&gt;.Expression</c> or
        /// <c>&lt;something&gt;.WhenNotNull</c> where <c>&lt;something&gt;</c> is Roslyn's
        /// <c>ConditionalAccessExpressionSyntax</c> — the shape I4/I5 own. Roslyn never puts a CAE
        /// directly in the <c>.Expression</c> position (only its receiverless <c>WhenNotNull</c> chain
        /// does), so I1's naive type-test rewrite over-matches there if it does not step aside.
        /// </summary>
        /// <param name="expression">The is-pattern's scrutinee.</param>
        /// <returns>True when I1 must refuse and let I4/I5 (or a loud gap) handle it instead.</returns>
        private bool IsConditionalAccessReceiverOrTailRead(ExpressionSyntax expression)
            => expression is MemberAccessExpressionSyntax { Name.Identifier.Text: "Expression" or "WhenNotNull" } member
               && this.context.GetTypeInfo(member.Expression).Type is INamedTypeSymbol conditionalAccessType
               && RoslynTypeMetadataName(conditionalAccessType) == "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax";

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

            if (symbol is IFieldSymbol field
                && field.ContainingType.TypeKind == TypeKind.Enum
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

            if (member.Name.Identifier.Text == "Value"
                && this.context.GetSymbolInfo(member).Symbol is IPropertySymbol
                    {
                        Name: "Value",
                        ContainingType.Name: "EqualsValueClauseSyntax",
                    })
            {
                result = this.TranslateExpression(member.Expression);
                return true;
            }

            if (member.Name.Identifier.Text == "Pattern"
                && this.context.GetSymbolInfo(member).Symbol is IPropertySymbol
                    {
                        Name: "Pattern",
                        ContainingType.Name: "CasePatternSwitchLabelSyntax",
                    })
            {
                result = new NonNullAssertionExpression(
                    new MemberAccessExpression(
                        this.TranslateExpression(member.Expression),
                        "Value",
                        isArrow: false));
                return true;
            }

            if (member.Name.Identifier.Text == "Identifier"
                && member.Expression is IdentifierNameSyntax designationName
                && this.context.GetSymbolInfo(designationName).Symbol is ILocalSymbol designationLocal
                && designationLocal.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() is SingleVariableDesignationSyntax
                {
                    Parent.Parent: IsPatternExpressionSyntax
                    {
                        Expression: ConditionalAccessExpressionSyntax
                        {
                            Expression: MemberAccessExpressionSyntax
                            {
                                Name.Identifier.Text: "ExpressionColon",
                            },
                        },
                    },
                })
            {
                result = this.TranslateExpression(member.Expression);
                return true;
            }

            if (this.TryTranslateCalleeSurfaceMember(member, out result))
            {
                return true;
            }

            if (member.Name.Identifier.Text == "OperatorKind"
                && this.context.GetSymbolInfo(member).Symbol is IPropertySymbol { Name: "OperatorKind" } operatorKind
                && RoslynTypeMetadataName(operatorKind.ContainingType) == "Microsoft.CodeAnalysis.Operations.IBinaryOperation")
            {
                // IBinaryOperation.OperatorKind ->
                // BoundBinaryOperationExpression.BinaryOperatorKind. NOT
                // `.Op.Kind` (issue #3920): `Op` exists only on
                // BoundBinaryExpression, and the operand shapes these rules
                // care about bind to BoundClrBinaryOperatorExpression, which
                // carries the operator TOKEN instead. The shared base
                // normalizes both to the language operator vocabulary.
                result = new MemberAccessExpression(
                    this.TranslateExpression(member.Expression),
                    "BinaryOperatorKind",
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

            if (member.Name.Identifier.Text == "Value"
                && this.context.GetSymbolInfo(member).Symbol is IPropertySymbol { Name: "Value" } initializerValue
                && RoslynTypeMetadataName(initializerValue.ContainingType) is "Microsoft.CodeAnalysis.Operations.IVariableInitializerOperation"
                    or "Microsoft.CodeAnalysis.Operations.ISymbolInitializerOperation")
            {
                // Issue #4436: IVariableInitializerOperation.Value drops — a G#
                // declaration's Initializer is the bound expression directly.
                result = this.TranslateExpression(member.Expression);
                return true;
            }

            if (member.Name.Identifier.Text == "ArgumentList"
                && member.Parent is MemberAccessExpressionSyntax { Name.Identifier.Text: "Arguments" }
                && this.context.GetSymbolInfo(member).Symbol is IPropertySymbol { Name: "ArgumentList" } argumentListProperty
                && RoslynTypeMetadataName(argumentListProperty.ContainingType) == "Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax")
            {
                // InvocationExpressionSyntax.ArgumentList.Arguments drops the
                // wrapper: G#'s CallExpressionSyntax exposes Arguments
                // directly, with no ArgumentListSyntax wrapper. Restricted to
                // both the .Arguments chain AND the InvocationExpressionSyntax
                // receiver specifically (each of ElementAccessExpressionSyntax
                // and ObjectCreationExpressionSyntax independently declares
                // its own same-named ArgumentList property, but their mapped
                // G# nodes expose Indices and a nested Target call
                // respectively, not direct Arguments) so other ArgumentList
                // reads/receivers stay a loud gap instead of silently
                // observing a different or nonexistent member.
                result = this.TranslateExpression(member.Expression);
                return true;
            }

            if (member.Name.Identifier.Text == "ParameterList"
                && member.Parent is MemberAccessExpressionSyntax { Name.Identifier.Text: "Parameters" }
                && this.context.GetSymbolInfo(member).Symbol is IPropertySymbol { Name: "ParameterList" } parameterListProperty
                && RoslynTypeMetadataName(parameterListProperty.ContainingType) == "Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax")
            {
                // MethodDeclarationSyntax.ParameterList.Parameters drops the
                // wrapper: G#'s FunctionDeclarationSyntax exposes Parameters
                // directly, with no ParameterListSyntax wrapper. Restricted to
                // both the .Parameters chain AND the MethodDeclarationSyntax
                // receiver specifically: ConstructorDeclarationSyntax,
                // LocalFunctionStatementSyntax, lambda expressions,
                // DelegateDeclarationSyntax, IndexerDeclarationSyntax, and
                // type declarations (primary constructors) each independently
                // declare their own same-named ParameterList property, but
                // none of those receiver types has a G# analyzer-API mapping
                // today, so admitting them here would apply this idiom
                // without knowing whether their (currently unmapped) G#
                // counterpart even exposes a same-shaped Parameters member.
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

            if (member.Name.Identifier.Text == "Expression"
                && this.context.GetTypeInfo(member.Expression).Type is INamedTypeSymbol conditionalAccessReceiverType
                && RoslynTypeMetadataName(conditionalAccessReceiverType) == "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax")
            {
                // Issue #4173, I3: <x>.Expression where x is CAE-typed -> the
                // hop's own receiver slot. Same value as Roslyn's receiverless
                // Expression at every hop, but only extent- and lifted-type-
                // exact at the FIRST hop of a chain; a later hop's receiver
                // slot holds just the next member NAME, not the accumulated
                // receiver (issue #4173 §5 — see ReceiverSpan for the
                // location-exact alternative, wired through I3a below).
                const string ShapeNote =
                    "'.Expression' on a null-conditional-access node translated to 'NullConditionalChain.NullConditionalReceiver(x)': "
                    + "same VALUE as Roslyn's receiverless Expression at every hop, but only extent- and lifted-type-exact at the "
                    + "chain's first hop — a later hop's receiver slot holds just the next member name, not the accumulated "
                    + "receiver (issue #4173 §5).";
                this.context.Report(new TranslationDiagnostic(
                    "analyzer-api",
                    ShapeNote,
                    member.GetLocation(),
                    TranslationSeverity.Warning)
                {
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE",
                });
                result = this.InvokeNullConditionalChain("NullConditionalReceiver", this.TranslateExpression(member.Expression));
                return true;
            }

            if (member.Name.Identifier.Text == "Span"
                && this.TryTranslateAnalyzerNullConditionalSpanRead(member.Expression, asLocation: false, out result))
            {
                return true;
            }

            if (member.Name.Identifier.Text == "Arguments"
                && member.Expression is MemberAccessExpressionSyntax { Name.Identifier.Text: "ArgumentList" } elementBindingArgListAccess
                && this.context.GetSymbolInfo(elementBindingArgListAccess).Symbol is IPropertySymbol { Name: "ArgumentList" } elementBindingArgListProperty
                && RoslynTypeMetadataName(elementBindingArgListProperty.ContainingType) == "Microsoft.CodeAnalysis.CSharp.Syntax.ElementBindingExpressionSyntax")
            {
                // Issue #4173, I6: ElementBindingExpressionSyntax.ArgumentList.Arguments
                // drops the wrapper: G#'s IndexExpressionSyntax exposes Indices
                // directly, with no BracketedArgumentListSyntax wrapper.
                result = new MemberAccessExpression(this.TranslateExpression(elementBindingArgListAccess.Expression), "Indices", isArrow: false);
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
        /// Extracts the type-name expression from a top-level <c>is</c>-pattern
        /// type test (<c>expr is SomeType</c> / <c>expr is SomeType x</c>). Same
        /// ambiguity as <see cref="BaseSubpatternTypeSyntax(PatternSyntax)"/>: a
        /// designated test (<c>is SomeType x</c>) always parses as
        /// <see cref="DeclarationPatternSyntax"/>, but a BARE test with no
        /// designator (<c>is SomeType</c>) is ambiguous with a constant pattern
        /// at parse time and comes through as <see cref="ConstantPatternSyntax"/>
        /// instead — every I1/I1b/I4/I5 type-test hook needs both forms, not
        /// just the designated one every existing test happened to use.
        /// </summary>
        private static ExpressionSyntax IsPatternTypeSyntax(PatternSyntax pattern) => pattern switch
        {
            DeclarationPatternSyntax declaration => declaration.Type,
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
            if (isPattern.Expression is ConditionalAccessExpressionSyntax conditional
                && conditional.Expression is MemberAccessExpressionSyntax expressionColon
                && expressionColon.Name.Identifier.Text == "ExpressionColon"
                && conditional.WhenNotNull is MemberBindingExpressionSyntax { Name.Identifier.Text: "Expression" }
                && expressionColon.Expression is ExpressionSyntax propertyFieldSource
                && this.context.GetTypeInfo(propertyFieldSource).Type is INamedTypeSymbol propertyFieldType
                && RoslynTypeMetadataName(propertyFieldType)
                    == "Microsoft.CodeAnalysis.CSharp.Syntax.SubpatternSyntax"
                && isPattern.Pattern is DeclarationPatternSyntax
                {
                    Type: IdentifierNameSyntax { Identifier.Text: "IdentifierNameSyntax" },
                    Designation: SingleVariableDesignationSyntax
                    {
                        Identifier.Text: { } designation,
                    },
                })
            {
                this.context.Report(new TranslationDiagnostic(
                    "analyzer-api",
                    "SubpatternSyntax.ExpressionColon.Expression identifier test translated to PropertyPatternFieldSyntax.Identifier: G# property-pattern fields always carry the field token directly.",
                    isPattern.GetLocation(),
                    TranslationSeverity.Warning)
                {
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE",
                });

                this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax");
                result = new PatternTestExpression(
                    new MemberAccessExpression(
                        this.TranslateExpression(propertyFieldSource),
                        "Identifier",
                        isArrow: false),
                    new TypePattern(
                        designation,
                        new NamedTypeReference("SyntaxToken"),
                        designationAfterType: true));
                return true;
            }

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
        /// Rewrites the C# null-conditional-access type test
        /// (<c>expr is ConditionalAccessExpressionSyntax [x]</c>) to G#'s
        /// faithful shape (issue #4173): <c>NullConditionalChain.AsNullConditionalHop(expr)
        /// is ExpressionSyntax [x]</c>. Roslyn gives <c>a?.b</c> AND <c>a?[i]</c> the same
        /// <c>ConditionalAccessExpressionSyntax</c> outer kind; G# instead folds <c>a?.b</c>
        /// onto the SAME node as <c>a.b</c> (<c>AccessorExpressionSyntax</c>) and <c>a?[i]</c>
        /// onto the SAME node as <c>a[i]</c> (<c>IndexExpressionSyntax</c>), each distinguished
        /// only by its own <c>IsNullConditional</c> flag — so a naive type/kind rename would
        /// match every ordinary access, not just null-conditional ones, and a rewrite that
        /// covers only the accessor shape would under-match <c>a?[i]</c>.
        /// <c>NullConditionalChain.AsNullConditionalHop</c> answers "is THIS node a
        /// null-conditional hop" uniformly across both G# node kinds, matching Roslyn's
        /// per-node <c>ConditionalAccessExpressionSyntax</c> kind test one for one regardless
        /// of chain depth or accessor-vs-element shape.
        /// <para>
        /// Refuses when <paramref name="scrutinee"/> is itself
        /// <c>&lt;x&gt;.Expression</c>/<c>&lt;x&gt;.WhenNotNull</c> on a CAE-typed <c>x</c>
        /// (<see cref="IsConditionalAccessReceiverOrTailRead(ExpressionSyntax)"/>): Roslyn
        /// never puts a genuine CAE directly in the <c>.Expression</c> position, and a bare
        /// <c>AsNullConditionalHop</c> rewrite of <c>.WhenNotNull</c>/<c>.Expression</c> (which
        /// have no G# counterpart on their own) would silently mistranslate rather than route to
        /// I4/I5's dedicated handling — or, failing that, a loud gap.
        /// </para>
        /// </summary>
        private bool TryTranslateAnalyzerConditionalAccessTypeTest(
            ExpressionSyntax scrutinee, ExpressionSyntax typeSyntax, VariableDesignationSyntax designation, SyntaxNode site, out GExpression result)
        {
            result = null;
            if (typeSyntax is null
                || this.context.GetTypeInfo(typeSyntax).Type is not INamedTypeSymbol typeSymbol
                || RoslynTypeMetadataName(typeSymbol) != "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax")
            {
                return false;
            }

            if (this.IsConditionalAccessReceiverOrTailRead(scrutinee))
            {
                return false;
            }

            const string ShapeNote =
                "'is ConditionalAccessExpressionSyntax' translated to 'NullConditionalChain.AsNullConditionalHop(expr) is ExpressionSyntax': "
                + "G# folds a?.b onto the SAME node as a.b and a?[i] onto the SAME node as a[i], each distinguished only by an "
                + "IsNullConditional flag, not a distinct kind; AsNullConditionalHop matches both shapes uniformly.";
            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                ShapeNote,
                site.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });

            var binders = new List<ILocalSymbol>();
            string designator = this.NativeDesignator(designation, binders);
            foreach (ILocalSymbol binder in binders)
            {
                this.state.PatternBindings[binder] = new IdentifierExpression(this.EmittedName(binder, binder.Name));
                this.state.NativePatternVariables.Add(binder);
            }

            GExpression receiver = this.TranslateExpression(scrutinee);
            result = new PatternTestExpression(
                this.InvokeNullConditionalChain("AsNullConditionalHop", receiver),
                new TypePattern(designator, new NamedTypeReference("ExpressionSyntax"), designationAfterType: true));
            return true;
        }

        /// <summary>
        /// The inverse sibling of <see cref="TryTranslateAnalyzerConditionalAccessTypeTest"/>
        /// (issue #4173 §6): Roslyn's <c>MemberAccessExpressionSyntax</c> (an ORDINARY <c>.b</c>
        /// access) EXCLUDES a <c>?.</c> hop's tail — Roslyn gives that its own receiverless
        /// <c>MemberBindingExpressionSyntax</c> kind — but the existing
        /// <c>MemberAccessExpressionSyntax</c> → <c>AccessorExpressionSyntax</c> map row is
        /// unconditional, so <c>node is MemberAccessExpressionSyntax</c> silently over-matched
        /// every <c>?.</c> hop's tail too (G# has no separate node for it). Same fix shape as
        /// I1, one boolean flipped: <c>is AccessorExpressionSyntax { IsNullConditional: false }</c>.
        /// </summary>
        private bool TryTranslateAnalyzerOrdinaryMemberAccessTypeTest(
            ExpressionSyntax scrutinee, ExpressionSyntax typeSyntax, VariableDesignationSyntax designation, SyntaxNode site, out GExpression result)
        {
            result = null;
            if (typeSyntax is null
                || this.context.GetTypeInfo(typeSyntax).Type is not INamedTypeSymbol typeSymbol
                || RoslynTypeMetadataName(typeSymbol) != "Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax")
            {
                return false;
            }

            const string ShapeNote =
                "'is MemberAccessExpressionSyntax' translated to 'is AccessorExpressionSyntax { IsNullConditional: false }': "
                + "a ?. hop's tail is Roslyn's receiverless MemberBindingExpressionSyntax, not MemberAccessExpressionSyntax, but "
                + "G# folds both onto the SAME node — the unconditional map row silently over-matched a ?. hop's tail too (#4173).";
            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                ShapeNote,
                site.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });

            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax");

            var binders = new List<ILocalSymbol>();
            string designator = this.NativeDesignator(designation, binders);
            foreach (ILocalSymbol binder in binders)
            {
                this.state.PatternBindings[binder] = new IdentifierExpression(this.EmittedName(binder, binder.Name));
                this.state.NativePatternVariables.Add(binder);
            }

            GExpression receiver = this.TranslateExpression(scrutinee);
            var suffix = new PropertyPattern(new List<PropertyPatternField>
            {
                new PropertyPatternField("IsNullConditional", new ConstantPattern(LiteralExpression.Bool(false))),
            });
            result = new PatternTestExpression(
                receiver,
                new TypePattern(designator, new NamedTypeReference("AccessorExpressionSyntax"), suffix, designationAfterType: true));
            return true;
        }

        /// <summary>
        /// Rewrites <c>&lt;x&gt;.WhenNotNull is &lt;Type&gt; [designator]</c> where <c>x</c> is
        /// CAE-typed (issue #4173, I4) — the companion of I1 that a per-node
        /// <c>IsNullConditional</c> flag alone cannot express, since it asks about the NEXT hop,
        /// not this one.
        /// </summary>
        private bool TryTranslateAnalyzerNullConditionalWhenNotNullTest(
            ExpressionSyntax scrutinee, ExpressionSyntax typeSyntax, VariableDesignationSyntax designation, SyntaxNode site, out GExpression result)
        {
            result = null;
            if (scrutinee is not MemberAccessExpressionSyntax { Name.Identifier.Text: "WhenNotNull" } access
                || this.context.GetTypeInfo(access.Expression).Type is not INamedTypeSymbol conditionalAccessType
                || RoslynTypeMetadataName(conditionalAccessType) != "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax")
            {
                return false;
            }

            if (typeSyntax is null || this.context.GetTypeInfo(typeSyntax).Type is not INamedTypeSymbol patternType)
            {
                return false;
            }

            GExpression translatedHop = this.TranslateExpression(access.Expression);
            string metadataName = RoslynTypeMetadataName(patternType);
            string shapeNote;
            switch (metadataName)
            {
                case "Microsoft.CodeAnalysis.CSharp.Syntax.MemberBindingExpressionSyntax":
                    result = this.InvokeNullConditionalChain("TailIsMemberBinding", translatedHop);
                    if (designation is SingleVariableDesignationSyntax)
                    {
                        // TailIsMemberBinding(x) proven true structurally
                        // guarantees x IS an AccessorExpressionSyntax, but
                        // its own static G# type is the wider ExpressionSyntax
                        // (AsNullConditionalHop's uniform return type) — narrow
                        // the binding, same "(x as T)!!" convention
                        // BuildPatternNarrowingReplacement already uses for a
                        // non-smart-castable designator, so a LATER read of
                        // I6's RightPart/DotToken rows actually binds.
                        this.BindPatternDesignation(designation, NarrowToType(translatedHop, "AccessorExpressionSyntax"));
                    }

                    shapeNote =
                        "'WhenNotNull is MemberBindingExpressionSyntax' translated to 'NullConditionalChain.TailIsMemberBinding(x)': "
                        + "a null-conditional hop whose tail is a bare member name IS its own last operator in G#'s right-nested "
                        + "chain shape; a designator binds to '(x as AccessorExpressionSyntax)!!' — proven safe by TailIsMemberBinding.";
                    break;

                case "Microsoft.CodeAnalysis.CSharp.Syntax.ElementBindingExpressionSyntax":
                    result = this.InvokeNullConditionalChain("TailIsElementBinding", translatedHop);
                    if (designation is SingleVariableDesignationSyntax)
                    {
                        this.BindPatternDesignation(designation, NarrowToType(translatedHop, "IndexExpressionSyntax"));
                    }

                    shapeNote =
                        "'WhenNotNull is ElementBindingExpressionSyntax' translated to 'NullConditionalChain.TailIsElementBinding(x)': "
                        + "a designator binds to '(x as IndexExpressionSyntax)!!' — proven safe by TailIsElementBinding.";
                    break;

                case "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax":
                    {
                        var binders = new List<ILocalSymbol>();
                        string designator = designation != null ? this.NativeDesignator(designation, binders) : "_";
                        foreach (ILocalSymbol binder in binders)
                        {
                            this.state.PatternBindings[binder] = new IdentifierExpression(this.EmittedName(binder, binder.Name));
                            this.state.NativePatternVariables.Add(binder);
                        }

                        result = new PatternTestExpression(
                            this.InvokeNullConditionalChain("NextNullConditionalHop", translatedHop),
                            new TypePattern(designator, new NamedTypeReference("ExpressionSyntax"), designationAfterType: true));
                    }

                    shapeNote =
                        "'WhenNotNull is ConditionalAccessExpressionSyntax' translated to "
                        + "'NullConditionalChain.NextNullConditionalHop(x) is ExpressionSyntax': the nearest FURTHER null-conditional "
                        + "hop in the same chain, possibly past an intervening ordinary access.";
                    break;

                default:
                    return false;
            }

            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                shapeNote,
                site.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });
            return true;
        }

        /// <summary>
        /// Rewrites <c>&lt;x&gt;.Expression is &lt;Type&gt; [designator]</c> where <c>x</c> is
        /// CAE-typed (issue #4173, I5) — the companion of I4 for the RECEIVER side of a hop.
        /// </summary>
        private bool TryTranslateAnalyzerNullConditionalExpressionTest(
            ExpressionSyntax scrutinee, ExpressionSyntax typeSyntax, VariableDesignationSyntax designation, SyntaxNode site, out GExpression result)
        {
            result = null;
            if (scrutinee is not MemberAccessExpressionSyntax { Name.Identifier.Text: "Expression" } access
                || this.context.GetTypeInfo(access.Expression).Type is not INamedTypeSymbol conditionalAccessType
                || RoslynTypeMetadataName(conditionalAccessType) != "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax")
            {
                return false;
            }

            if (typeSyntax is null || this.context.GetTypeInfo(typeSyntax).Type is not INamedTypeSymbol patternType)
            {
                return false;
            }

            GExpression translatedHop = this.TranslateExpression(access.Expression);
            string metadataName = RoslynTypeMetadataName(patternType);

            if (metadataName == "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax")
            {
                // Roslyn never places a genuine (unparenthesized) CAE directly in the .Expression
                // position — only a parenthesized sub-chain break does (`(a?.b)?.c`) — and
                // NullConditionalReceiver's best-effort value would make this test vacuously true
                // for an ordinary hop. Not a rewrite this translator can prove sound (the same class
                // of reasoning the removed single-hop idiom failed on); left as a loud gap by
                // constructing the member access directly, bypassing I3's receiver rewrite.
                const string GapNote =
                    "'.Expression is ConditionalAccessExpressionSyntax' has no sound G# rewrite: Roslyn only reaches a genuine "
                    + "CAE there through a parenthesized chain break, which NullConditionalChain cannot distinguish from an "
                    + "ordinary hop without risking a vacuously-true test (issue #4173).";
                this.context.Report(new TranslationDiagnostic(
                    "analyzer-api",
                    GapNote,
                    site.GetLocation(),
                    TranslationSeverity.Unsupported)
                {
                    DiagnosticId = "CS2GS-GAP",
                });

                var binders = new List<ILocalSymbol>();
                string designator = designation != null ? this.NativeDesignator(designation, binders) : "_";
                result = new PatternTestExpression(
                    new MemberAccessExpression(translatedHop, "Expression", isArrow: false),
                    new TypePattern(designator, new NamedTypeReference("ExpressionSyntax"), designationAfterType: true));
                return true;
            }

            GExpression predicate;
            GExpression designatorValue;
            string shapeNote;
            switch (metadataName)
            {
                case "Microsoft.CodeAnalysis.CSharp.Syntax.MemberBindingExpressionSyntax":
                    predicate = this.InvokeNullConditionalChain("ReceiverIsMemberBinding", translatedHop);

                    // ReceiverIsMemberBinding(x) proven true structurally
                    // guarantees NullConditionalReceiver(x) IS an
                    // AccessorExpressionSyntax; narrow it the same
                    // "(x as T)!!" way I4 does, so a later I6 RightPart/
                    // DotToken read actually binds against the receiver's
                    // real G# type instead of the wider ExpressionSyntax.
                    designatorValue = NarrowToType(
                        this.InvokeNullConditionalChain("NullConditionalReceiver", translatedHop), "AccessorExpressionSyntax");
                    shapeNote =
                        "'Expression is MemberBindingExpressionSyntax' translated to 'NullConditionalChain.ReceiverIsMemberBinding(x)': "
                        + "true when x continues directly off a preceding ?. with no ordinary step in between; a designator binds "
                        + "to '(NullConditionalChain.NullConditionalReceiver(x) as AccessorExpressionSyntax)!!' (same value, not "
                        + "extent-exact — issue #4173 §5).";
                    break;

                case "Microsoft.CodeAnalysis.CSharp.Syntax.ElementBindingExpressionSyntax":
                    predicate = this.InvokeNullConditionalChain("ReceiverIsElementBinding", translatedHop);
                    designatorValue = NarrowToType(
                        this.InvokeNullConditionalChain("NullConditionalReceiver", translatedHop), "IndexExpressionSyntax");
                    shapeNote =
                        "'Expression is ElementBindingExpressionSyntax' translated to 'NullConditionalChain.ReceiverIsElementBinding(x)': "
                        + "a designator binds to '(NullConditionalChain.NullConditionalReceiver(x) as IndexExpressionSyntax)!!'.";
                    break;

                case "Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax":
                    predicate = this.InvokeNullConditionalChain("ReceiverIsPlainMemberAccess", translatedHop);
                    designatorValue = NarrowToType(
                        new MemberAccessExpression(translatedHop, "Parent", isArrow: false), "AccessorExpressionSyntax");
                    shapeNote =
                        "'Expression is MemberAccessExpressionSyntax' translated to 'NullConditionalChain.ReceiverIsPlainMemberAccess(x)': "
                        + "true when x continues directly off a preceding ORDINARY '.'; a designator binds to "
                        + "'(x.Parent as AccessorExpressionSyntax)!!', the ordinary accessor that reached x.";
                    break;

                default:
                    return false;
            }

            result = predicate;
            if (designation is SingleVariableDesignationSyntax)
            {
                this.BindPatternDesignation(designation, designatorValue);
            }

            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                shapeNote,
                site.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });
            return true;
        }

        /// <summary>
        /// The single entry point for every null-conditional-access idiom that
        /// hinges on a <c>&lt;scrutinee&gt; is &lt;Type&gt;</c> type test
        /// (issue #4173, I1/I1b/I4/I5) — reached from BOTH C# shapes a type
        /// test can take: <see cref="IsPatternExpressionSyntax"/> (<c>is Type x</c>,
        /// <c>is Type { }</c>, ...) via <c>TranslateIsPattern</c>, and the
        /// classic <see cref="BinaryExpressionSyntax"/>/<c>SyntaxKind.IsExpression</c>
        /// form (a BARE <c>expr is Type</c> with no designator, pattern
        /// combinator, or subpattern parses as this OLDER node kind, not a
        /// pattern, so it never reaches <c>TranslateIsPattern</c> at all) via
        /// the generic <c>as</c>/<c>is</c> binary-expression handler. I4/I5
        /// are tried first: they destructure <paramref name="scrutinee"/>
        /// itself (looking for <c>&lt;x&gt;.WhenNotNull</c>/<c>&lt;x&gt;.Expression</c>),
        /// so trying them first makes I1's own refusal guard belt-and-braces
        /// rather than load-bearing. Without ALL FOUR wired through this one
        /// entry point, I7's deliberately non-discriminating
        /// <c>ConditionalAccessExpressionSyntax</c> → <c>ExpressionSyntax</c>
        /// map row (and the pre-existing, equally unconditional
        /// <c>MemberAccessExpressionSyntax</c> → <c>AccessorExpressionSyntax</c>
        /// row) would make a BARE <c>x is ConditionalAccessExpressionSyntax</c>/
        /// <c>x is MemberAccessExpressionSyntax</c> — with no designator, the
        /// commonest real-world spelling of both — silently vacuous or
        /// over-matching, exactly the class of bug I1/I1b exist to prevent for
        /// the designated form.
        /// </summary>
        /// <param name="scrutinee">The tested expression.</param>
        /// <param name="typeSyntax">The tested type's syntax, however the C# parser shaped the test.</param>
        /// <param name="designation">The bound designator, or null for a bare test.</param>
        /// <param name="site">The node to attribute a diagnostic to.</param>
        /// <param name="result">The rewritten expression.</param>
        /// <returns>True when one of I1/I1b/I4/I5 handled the test.</returns>
        private bool TryTranslateAnalyzerNullConditionalTypeTest(
            ExpressionSyntax scrutinee, ExpressionSyntax typeSyntax, VariableDesignationSyntax designation, SyntaxNode site, out GExpression result)
        {
            result = null;
            return this.InAnalyzerApiMode
                && (this.TryTranslateAnalyzerNullConditionalWhenNotNullTest(scrutinee, typeSyntax, designation, site, out result)
                    || this.TryTranslateAnalyzerNullConditionalExpressionTest(scrutinee, typeSyntax, designation, site, out result)
                    || this.TryTranslateAnalyzerConditionalAccessTypeTest(scrutinee, typeSyntax, designation, site, out result)
                    || this.TryTranslateAnalyzerOrdinaryMemberAccessTypeTest(scrutinee, typeSyntax, designation, site, out result));
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

        private bool TryTranslateAnalyzerDesignationWalk(InvocationExpressionSyntax invocation, out GExpression result)
        {
            result = null;
            if (this.context.GetSymbolInfo(invocation).Symbol is not IMethodSymbol { Name: "OfType", TypeArguments.Length: 1 } method
                || RoslynTypeMetadataName(method.TypeArguments[0] as INamedTypeSymbol)
                    != "Microsoft.CodeAnalysis.CSharp.Syntax.SingleVariableDesignationSyntax"
                || invocation.Expression is not MemberAccessExpressionSyntax { Expression: InvocationExpressionSyntax descendants }
                || this.context.GetSymbolInfo(descendants).Symbol is not IMethodSymbol { Name: "DescendantNodesAndSelf" })
            {
                return false;
            }

            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                "SingleVariableDesignationSyntax walk translated to PatternSyntax nodes with a non-nil BindingIdentifier: G# stores designation tokens directly on pattern nodes.",
                invocation.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });

            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax");
            GExpression patterns = new InvocationExpression(
                new MemberAccessExpression(
                    this.TranslateExpression(descendants),
                    "OfType",
                    isArrow: false),
                typeArguments: new[] { new NamedTypeReference("PatternSyntax") });
            var parameter = new Parameter("pattern", new NamedTypeReference("PatternSyntax"));
            GExpression binding = new MemberAccessExpression(
                new IdentifierExpression("pattern"),
                "BindingIdentifier",
                isArrow: false);
            result = new InvocationExpression(
                new MemberAccessExpression(patterns, "Where", isArrow: false),
                new[]
                {
                    new LambdaExpression(
                        new[] { parameter },
                        expressionBody: new BinaryExpression(binding, "!=", LiteralExpression.Null())),
                });
            return true;
        }

        private bool TryTranslateAnalyzerConstructionForms(InvocationExpressionSyntax invocation, out GExpression result)
        {
            result = null;
            if (this.context.GetSymbolInfo(invocation).Symbol is not IMethodSymbol { Name: "GetMembers" } getMembers
                || RoslynTypeMetadataName(getMembers.ContainingType) != "Microsoft.CodeAnalysis.INamespaceOrTypeSymbol"
                || invocation.Expression is not MemberAccessExpressionSyntax { Expression: ExpressionSyntax receiver }
                || invocation.Parent is not MemberAccessExpressionSyntax { Name: GenericNameSyntax { Identifier.Text: "OfType" } } ofTypeAccess
                || ofTypeAccess.Parent is not InvocationExpressionSyntax ofTypeInvocation
                || this.context.GetSymbolInfo(ofTypeInvocation).Symbol is not IMethodSymbol { Name: "OfType", TypeArguments.Length: 1 } ofType
                || RoslynTypeMetadataName(ofType.TypeArguments[0] as INamedTypeSymbol) != "Microsoft.CodeAnalysis.IMethodSymbol"
                || ofTypeInvocation.Parent is not MemberAccessExpressionSyntax { Name.Identifier.Text: "Where" }
                || ofTypeInvocation.Parent.Parent is not InvocationExpressionSyntax whereInvocation
                || !whereInvocation.ArgumentList.Arguments.Any(argument =>
                    argument.Expression.DescendantNodesAndSelf().OfType<MemberAccessExpressionSyntax>().Any(access =>
                        access.Name.Identifier.Text == "MethodKind"
                        && this.context.GetSymbolInfo(access).Symbol is IPropertySymbol { ContainingType.Name: "IMethodSymbol" })))
            {
                return false;
            }

            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                "TypeSymbol.GetMembers() constructor-form query augmented with TypeSymbol.GetConstructors(): G# keeps constructors outside ordinary member enumeration.",
                invocation.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });

            GExpression translatedReceiver = this.TranslateExpression(receiver);
            GExpression members = new InvocationExpression(
                new MemberAccessExpression(translatedReceiver, "GetMembers", isArrow: false));
            GExpression constructors = new InvocationExpression(
                new MemberAccessExpression(this.TranslateExpression(receiver), "GetConstructors", isArrow: false));
            result = new InvocationExpression(
                new MemberAccessExpression(members, "Concat", isArrow: false),
                new[] { constructors });
            return true;
        }

        /// <summary>
        /// Shared implementation behind I3a: <c>.GetLocation()</c>/<c>.Span</c> on a
        /// null-conditional hop, or on <c>&lt;hop&gt;.Expression</c>, translated to the
        /// Roslyn-exact span computed by <c>NullConditionalChain</c> instead of the
        /// (narrower or differently-anchored) G# node's own natural span (issue #4173, Q2).
        /// </summary>
        /// <param name="target">The receiver of the <c>.GetLocation()</c>/<c>.Span</c> read.</param>
        /// <param name="asLocation">True for <c>.GetLocation()</c> (wrap in a <c>TextLocation</c>); false for <c>.Span</c>.</param>
        /// <param name="result">The rewritten expression.</param>
        /// <returns>True when this hook handled the read.</returns>
        private bool TryTranslateAnalyzerNullConditionalSpanRead(ExpressionSyntax target, bool asLocation, out GExpression result)
        {
            result = null;
            GExpression translatedHop;
            string spanMethodName;
            if (this.context.GetTypeInfo(target).Type is INamedTypeSymbol directHopType
                && RoslynTypeMetadataName(directHopType) == "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax")
            {
                translatedHop = this.TranslateExpression(target);
                spanMethodName = "HopSpan";
            }
            else if (target is MemberAccessExpressionSyntax { Name.Identifier.Text: "Expression" } expressionAccess
                && this.context.GetTypeInfo(expressionAccess.Expression).Type is INamedTypeSymbol receiverHopType
                && RoslynTypeMetadataName(receiverHopType) == "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax")
            {
                translatedHop = this.TranslateExpression(expressionAccess.Expression);
                spanMethodName = "ReceiverSpan";
            }
            else
            {
                return false;
            }

            const string ShapeNote =
                "'.GetLocation()'/'.Span' on a null-conditional-access node (or its '.Expression' receiver) translated to the "
                + "Roslyn-exact span computed by NullConditionalChain, rather than the differently-anchored G# node's own "
                + "natural span (issue #4173).";
            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                ShapeNote,
                target.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });

            GExpression spanCall = this.InvokeNullConditionalChain(spanMethodName, translatedHop);
            if (!asLocation)
            {
                result = spanCall;
                return true;
            }

            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Text");
            result = new InvocationExpression(
                new IdentifierExpression("TextLocation"),
                new List<GExpression>
                {
                    new MemberAccessExpression(
                        new MemberAccessExpression(translatedHop, "SyntaxTree", isArrow: false), "Text", isArrow: false),
                    spanCall,
                });
            return true;
        }

        /// <summary>
        /// Rewrites <c>&lt;seq&gt;.OfType&lt;ConditionalAccessExpressionSyntax&gt;()</c> (issue
        /// #4173, I8): without this, I7's deliberately non-discriminating
        /// <c>ConditionalAccessExpressionSyntax</c> → <c>ExpressionSyntax</c> type-map row would
        /// let the naive translation of <c>OfType&lt;ExpressionSyntax&gt;()</c> silently match
        /// every ordinary access too.
        /// </summary>
        private bool TryTranslateAnalyzerConditionalAccessOfTypeWalk(InvocationExpressionSyntax invocation, out GExpression result)
        {
            result = null;
            if (this.context.GetSymbolInfo(invocation).Symbol is not IMethodSymbol { Name: "OfType", TypeArguments.Length: 1 } method
                || RoslynTypeMetadataName(method.TypeArguments[0] as INamedTypeSymbol) != "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax"
                || invocation.Expression is not MemberAccessExpressionSyntax { Expression: ExpressionSyntax sequenceReceiver })
            {
                return false;
            }

            const string ShapeNote =
                "'OfType<ConditionalAccessExpressionSyntax>()' translated to "
                + "'OfType<ExpressionSyntax>().Where(n -> NullConditionalChain.IsNullConditionalHop(n))': G#'s ExpressionSyntax "
                + "is the non-discriminating supertype for a null-conditional hop, so the OfType<>() filter must be re-narrowed "
                + "explicitly (issue #4173).";
            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                ShapeNote,
                invocation.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });

            GExpression ofTypeCall = new InvocationExpression(
                new MemberAccessExpression(this.TranslateExpression(sequenceReceiver), "OfType", isArrow: false),
                typeArguments: new[] { new NamedTypeReference("ExpressionSyntax") });
            var parameter = new Parameter("n", new NamedTypeReference("ExpressionSyntax"));
            GExpression predicate = this.InvokeNullConditionalChain("IsNullConditionalHop", new IdentifierExpression("n"));
            result = new InvocationExpression(
                new MemberAccessExpression(ofTypeCall, "Where", isArrow: false),
                new[] { new LambdaExpression(new[] { parameter }, expressionBody: predicate) });
            return true;
        }

        /// <summary>
        /// Rewrites <c>&lt;node&gt;.FirstAncestorOrSelf&lt;ConditionalAccessExpressionSyntax&gt;()</c>
        /// (issue #4173, I8): mirrors <see cref="TryTranslateAnalyzerConditionalAccessOfTypeWalk"/>
        /// for the ancestor-walk idiom — G# has no single type for a null-conditional hop, so the
        /// generic <c>FirstAncestorOrSelf&lt;T&gt;()</c> is replaced by an explicit self-or-ancestors
        /// scan filtered by <c>NullConditionalChain.IsNullConditionalHop</c>.
        /// </summary>
        private bool TryTranslateAnalyzerConditionalAccessAncestorWalk(InvocationExpressionSyntax invocation, out GExpression result)
        {
            result = null;
            if (this.context.GetSymbolInfo(invocation).Symbol is not IMethodSymbol { Name: "FirstAncestorOrSelf", TypeArguments.Length: 1 } method
                || RoslynTypeMetadataName(method.TypeArguments[0] as INamedTypeSymbol) != "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax"
                || invocation.Expression is not MemberAccessExpressionSyntax { Expression: ExpressionSyntax nodeReceiver })
            {
                return false;
            }

            const string ShapeNote =
                "'FirstAncestorOrSelf<ConditionalAccessExpressionSyntax>()' translated to a self-or-ancestors scan filtered by "
                + "'NullConditionalChain.IsNullConditionalHop': G# has no single type for a null-conditional hop to pass as a "
                + "type argument (issue #4173).";
            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                ShapeNote,
                invocation.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });

            GExpression translatedNode = this.TranslateExpression(nodeReceiver);
            GExpression selfCheck = this.InvokeNullConditionalChain("IsNullConditionalHop", translatedNode);
            var ancestorParameter = new Parameter("candidate", new NamedTypeReference("SyntaxNode"));
            GExpression ancestorPredicate = this.InvokeNullConditionalChain("IsNullConditionalHop", new IdentifierExpression("candidate"));
            GExpression ancestorsCall = new InvocationExpression(new MemberAccessExpression(translatedNode, "Ancestors", isArrow: false));
            GExpression firstAncestorMatch = new InvocationExpression(
                new MemberAccessExpression(ancestorsCall, "FirstOrDefault", isArrow: false),
                new List<GExpression> { new LambdaExpression(new[] { ancestorParameter }, expressionBody: ancestorPredicate) });
            result = new IfExpression(selfCheck, translatedNode, firstAncestorMatch);
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
            if (this.TryTranslateAnalyzerDesignationWalk(invocation, out result)
                || this.TryTranslateAnalyzerConstructionForms(invocation, out result)
                || this.TryTranslateAnalyzerConditionalAccessOfTypeWalk(invocation, out result)
                || this.TryTranslateAnalyzerConditionalAccessAncestorWalk(invocation, out result))
            {
                return true;
            }

            if (invocation.Expression is IdentifierNameSyntax { Identifier.Text: "TypeNameOf" }
                && invocation.ArgumentList.Arguments.Count == 1
                && invocation.ArgumentList.Arguments[0].Expression is MemberAccessExpressionSyntax typeAccess
                && typeAccess.Name.Identifier.Text == "Type"
                && typeAccess.Expression is ExpressionSyntax creation
                && this.context.GetSymbolInfo(typeAccess).Symbol is IPropertySymbol
                {
                    Name: "Type",
                    ContainingType.Name: "ObjectCreationExpressionSyntax",
                })
            {
                result = new MemberAccessExpression(
                    new MemberAccessExpression(
                        this.TranslateExpression(creation),
                        "Identifier",
                        isArrow: false),
                    "Text",
                    isArrow: false);
                return true;
            }

            if (this.context.GetSymbolInfo(invocation).Symbol is not IMethodSymbol method
                || !RoslynAnalyzerApiMap.IsRoslynNamespace(method.ContainingType?.ContainingNamespace?.ToDisplayString()))
            {
                return false;
            }

            if (method.Name == "RegisterOperationAction"
                && invocation.Expression is MemberAccessExpressionSyntax registrationReceiver
                && this.TryExpandOperationKindRegistration(invocation, registrationReceiver, out result))
            {
                return true;
            }

            if (method.Name == "RegisterSyntaxNodeAction"
                && invocation.Expression is MemberAccessExpressionSyntax syntaxRegistrationReceiver
                && this.TryGuardConditionalAccessRegistration(invocation, syntaxRegistrationReceiver, out result))
            {
                return true;
            }

            if (method.Name == "GetLocation"
                && method.Parameters.Length == 0
                && invocation.Expression is MemberAccessExpressionSyntax locationReceiver)
            {
                if (this.TryTranslateAnalyzerNullConditionalSpanRead(locationReceiver.Expression, asLocation: true, out result))
                {
                    return true;
                }

                // `node.GetLocation()` dereferences `node`, so its receiver
                // takes the ordinary receiver forgiveness (issue #4356): a
                // receiver whose G# counterpart is `T?` (`operation.Syntax`,
                // BoundNode.Syntax) needs the same `!!` a `.Location` read
                // written by hand would.
                result = new MemberAccessExpression(
                    this.TranslateReceiverWithNullForgiveness(locationReceiver.Expression),
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
        /// Expands <c>RegisterOperationAction(handler, OperationKind.X, …)</c>
        /// into a <c>RegisterBoundNodeAction</c> naming EVERY G# bound-node
        /// kind that operation reaches (issue #3920).
        /// </summary>
        /// <remarks>
        /// Roslyn has one operation kind where G# has several bound nodes:
        /// <c>a == b</c> binds to <c>BoundBinaryExpression</c> for a built-in
        /// operator and to <c>BoundClrBinaryOperatorExpression</c> when it
        /// resolves to an operator method, and a call binds to one of three
        /// nodes by callee provenance. Registering only the kind the
        /// <see cref="RoslynAnalyzerApiMap"/> enum rename names dispatched the
        /// migrated GSA0002 zero times over reflection <c>Type</c>
        /// comparisons — whose operands are imported by construction — so the
        /// rule reported nothing at all rather than reporting wrongly.
        /// </remarks>
        /// <param name="invocation">The registration call.</param>
        /// <param name="receiver">Its member-access callee.</param>
        /// <param name="result">The expanded registration.</param>
        /// <returns>True when at least one argument kind fanned out.</returns>
        private bool TryExpandOperationKindRegistration(
            InvocationExpressionSyntax invocation,
            MemberAccessExpressionSyntax receiver,
            out GExpression result)
        {
            result = null;
            var arguments = new List<GExpression>();
            var expanded = false;
            var unexpandable = false;
            foreach (ArgumentSyntax argument in invocation.ArgumentList.Arguments)
            {
                if (argument.Expression is MemberAccessExpressionSyntax kindAccess
                    && this.context.GetSymbolInfo(kindAccess).Symbol is IFieldSymbol kindField
                    && RoslynTypeMetadataName(kindField.ContainingType) == "Microsoft.CodeAnalysis.OperationKind"
                    && RoslynAnalyzerApiMap.TryMapOperationKindDispatch(kindField.Name, out string[] boundNodeKinds))
                {
                    expanded = true;
                    foreach (string boundNodeKind in boundNodeKinds)
                    {
                        arguments.Add(new MemberAccessExpression(
                            new IdentifierExpression("BoundNodeKind"), boundNodeKind, isArrow: false));
                    }

                    continue;
                }

                // An argument that names operation kinds INDIRECTLY — a local, a
                // field, an array or ImmutableArray creation — cannot be fanned
                // out here, and letting it fall through to the one-to-one enum
                // rename emits a registration that binds, runs, and is dispatched
                // zero times over imported code. That is the silence #3920 exists
                // to remove, so it is reported as unsupported instead.
                //
                // The role of an argument comes from the PARAMETER it binds to,
                // never from its position: named arguments reorder freely, and
                // `RegisterOperationAction(operationKinds: Kinds, action: H)`
                // put the indirect array where a positional check expected the
                // handler and slipped past the guard entirely (PR #3968 review).
                //
                // A kind spelled DIRECTLY but carrying no fan-out row is not
                // this failure mode: the enum rename is the whole answer for it,
                // and the round-trip binder already backstops a renamed kind
                // that does not exist. Flagging those would trade a silent wrong
                // answer for a loud wrong one.
                if (BindsToOperationKindsParameter(argument, this.context)
                    && !IsDirectOperationKindAccess(argument.Expression, this.context))
                {
                    unexpandable = true;
                }

                arguments.Add(this.TranslateExpression(argument.Expression));
            }

            if (unexpandable)
            {
                const string GapNote =
                    "'RegisterOperationAction' names its operation kinds indirectly, so cs2gs cannot expand them to "
                    + "the several G# bound-node kinds each Roslyn operation reaches (issue #3920). Spell the kinds "
                    + "as direct 'OperationKind.X' arguments at the registration call.";
                this.context.Report(new TranslationDiagnostic(
                    "analyzer-api",
                    GapNote,
                    invocation.GetLocation(),
                    TranslationSeverity.Unsupported)
                {
                    DiagnosticId = "CS2GS-GAP",
                });
                return false;
            }

            if (!expanded)
            {
                return false;
            }

            const string ShapeNote =
                "'RegisterOperationAction' expanded to every G# bound-node kind the operation reaches: "
                + "G# binds one Roslyn operation kind to several nodes by operator/callee provenance.";
            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                ShapeNote,
                invocation.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });

            result = new InvocationExpression(
                new MemberAccessExpression(
                    this.TranslateExpression(receiver.Expression),
                    "RegisterBoundNodeAction",
                    isArrow: false),
                arguments);
            return true;
        }

        /// <summary>
        /// Rewrites <c>RegisterSyntaxNodeAction(handler, SyntaxKind.ConditionalAccessExpression)</c>
        /// AND its sibling <c>RegisterSyntaxNodeAction(handler, SyntaxKind.SimpleMemberAccessExpression)</c>
        /// (issue #4173, I2 + §6). Unlike a type/kind rename, neither guard can live at the
        /// registration call site alone: G# dispatches EVERY <c>AccessorExpressionSyntax</c>/
        /// <c>IndexExpressionSyntax</c> (null-conditional or not) to a handler registered for that
        /// kind, so the handler must reject the nodes on the OTHER side of <c>IsNullConditional</c>
        /// it would otherwise also receive — <c>ConditionalAccessExpression</c> must reject the
        /// ordinary ones, and <c>SimpleMemberAccessExpression</c> (Roslyn's ordinary <c>.b</c>,
        /// which EXCLUDES a <c>?.</c> hop's receiverless tail) must reject the null-conditional
        /// ones. Rather than reach into the (separately-translated, order-independent) handler
        /// METHOD BODY, the registration is rewritten to pass a small wrapper lambda that runs
        /// the guard and only then forwards to the original handler — the same effect, entirely
        /// local to this call site. <c>ConditionalAccessExpression</c> additionally registers for
        /// <c>SyntaxKind.IndexExpression</c> alongside <c>AccessorExpression</c>, since Roslyn's
        /// <c>?.</c> and <c>?[</c> share one outer kind but G# splits them across two node types.
        /// </summary>
        /// <remarks>
        /// A registration that combines either of these kinds with any OTHER kind in the same
        /// call is left alone (a loud CS2GS-GAP): the wrapper's guard would apply to every kind
        /// the registration dispatches, wrongly rejecting the other kind(s)' nodes too.
        /// </remarks>
        private bool TryGuardConditionalAccessRegistration(
            InvocationExpressionSyntax invocation, MemberAccessExpressionSyntax receiver, out GExpression result)
        {
            result = null;
            ArgumentSyntax handlerArgument = null;
            var kindArguments = new List<ArgumentSyntax>();
            foreach (ArgumentSyntax argument in invocation.ArgumentList.Arguments)
            {
                IParameterSymbol parameter = DetermineParameter(argument, this.context);
                ITypeSymbol parameterType = parameter?.IsParams == true
                    ? (parameter.Type as IArrayTypeSymbol)?.ElementType
                    : parameter?.Type;

                if (RoslynTypeMetadataName(parameterType as INamedTypeSymbol) == "Microsoft.CodeAnalysis.CSharp.SyntaxKind")
                {
                    kindArguments.Add(argument);
                }
                else
                {
                    handlerArgument = argument;
                }
            }

            bool NamesKind(string kindMemberName) => kindArguments.Any(argument =>
                argument.Expression is MemberAccessExpressionSyntax kindAccess
                && this.context.GetSymbolInfo(kindAccess).Symbol is IFieldSymbol kindField
                && kindField.Name == kindMemberName
                && RoslynTypeMetadataName(kindField.ContainingType) == "Microsoft.CodeAnalysis.CSharp.SyntaxKind");

            bool namesConditionalAccess = NamesKind("ConditionalAccessExpression");
            bool namesSimpleMemberAccess = NamesKind("SimpleMemberAccessExpression");

            if ((!namesConditionalAccess && !namesSimpleMemberAccess) || handlerArgument is null)
            {
                return false;
            }

            if (kindArguments.Count != 1)
            {
                const string GapNote =
                    "'RegisterSyntaxNodeAction' combines SyntaxKind.ConditionalAccessExpression and/or "
                    + "SyntaxKind.SimpleMemberAccessExpression with another kind in the same call: G# dispatches every "
                    + "AccessorExpressionSyntax/IndexExpressionSyntax (null-conditional or not) to a handler registered for "
                    + "that kind, so the IsNullConditional-discriminating guard either of these needs would also wrongly "
                    + "reject the other kind(s)' nodes. Split into a separate RegisterSyntaxNodeAction call naming only the "
                    + "kind that needs the guard.";
                this.context.Report(new TranslationDiagnostic(
                    "analyzer-api",
                    GapNote,
                    invocation.GetLocation(),
                    TranslationSeverity.Unsupported)
                {
                    DiagnosticId = "CS2GS-GAP",
                });
                return false;
            }

            // Exactly one of the two, since kindArguments.Count == 1 here.
            bool guardsNullConditional = namesConditionalAccess;
            string shapeNote = guardsNullConditional
                ? "'RegisterSyntaxNodeAction(handler, SyntaxKind.ConditionalAccessExpression)' translated to a wrapper lambda "
                    + "registered for SyntaxKind.AccessorExpression and SyntaxKind.IndexExpression that only forwards to the "
                    + "handler when 'NullConditionalChain.IsNullConditionalHop(ctx.Node)': G# dispatches every accessor/index "
                    + "node (a.b/a[i] as well as a?.b/a?[i]) to those kinds, and the handler must reject the ordinary ones."
                : "'RegisterSyntaxNodeAction(handler, SyntaxKind.SimpleMemberAccessExpression)' translated to a wrapper lambda "
                    + "registered for SyntaxKind.AccessorExpression that only forwards to the handler when "
                    + "'ctx.Node is AccessorExpressionSyntax { IsNullConditional: false }': G# dispatches every accessor node "
                    + "(a.b as well as a?.b) to that kind, and Roslyn's own MemberAccessExpressionSyntax excludes a ?. hop's "
                    + "receiverless tail, so the handler must reject the null-conditional ones (issue #4173 §6).";
            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                shapeNote,
                invocation.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });

            var contextParameter = new Parameter("ctx", new NamedTypeReference("SyntaxNodeAnalysisContext"));
            GExpression ctxNode = new MemberAccessExpression(new IdentifierExpression("ctx"), "Node", isArrow: false);
            GExpression guardTest = guardsNullConditional
                ? this.InvokeNullConditionalChain("IsNullConditionalHop", ctxNode)
                : new PatternTestExpression(
                    ctxNode,
                    new TypePattern(
                        "_",
                        new NamedTypeReference("AccessorExpressionSyntax"),
                        new PropertyPattern(new List<PropertyPatternField>
                        {
                            new PropertyPatternField("IsNullConditional", new ConstantPattern(LiteralExpression.Bool(false))),
                        }),
                        designationAfterType: true));
            GExpression handlerCall = new InvocationExpression(
                this.TranslateExpression(handlerArgument.Expression),
                new List<GExpression> { new IdentifierExpression("ctx") });
            var guardedBody = new BlockStatement(new List<GStatement>
            {
                new IfStatement(guardTest, new BlockStatement(new List<GStatement> { new ExpressionStatement(handlerCall) })),
            });
            var wrapperLambda = new LambdaExpression(new List<Parameter> { contextParameter }, blockBody: guardedBody);

            var registeredKinds = new List<GExpression>
            {
                new MemberAccessExpression(new IdentifierExpression("SyntaxKind"), "AccessorExpression", isArrow: false),
            };
            if (guardsNullConditional)
            {
                registeredKinds.Add(new MemberAccessExpression(new IdentifierExpression("SyntaxKind"), "IndexExpression", isArrow: false));
            }

            result = new InvocationExpression(
                new MemberAccessExpression(this.TranslateExpression(receiver.Expression), "RegisterSyntaxNodeAction", isArrow: false),
                new List<GExpression> { wrapperLambda }.Concat(registeredKinds).ToList());
            return true;
        }

        /// <summary>
        /// The two members a migrated analyzer reaches through
        /// <c>IInvocationOperation.TargetMethod</c> that the callee SYMBOL
        /// cannot answer honestly (PR #3968 review).
        /// </summary>
        /// <remarks>
        /// <para>
        /// <c>ReturnType</c> is answered by the call NODE. G#'s callee symbol
        /// carries the declaration's return type, so a constructed generic call
        /// reports the type parameter — measured directly: an analyzer over
        /// <c>Identity[int32](1)</c> saw <c>symbol=T</c> against
        /// <c>node=global::System.Int32</c>. Roslyn's <c>TargetMethod</c> is the
        /// CONSTRUCTED method, so the node's type is the faithful reading, and
        /// it is right for the imported-generic case too without consulting a
        /// reflected placeholder.
        /// </para>
        /// <para>
        /// <c>OverriddenMethod</c> has no honest answer at a call site: an
        /// imported callee has no G# override chain, so any value would be null
        /// for every call into metadata. It is reported as a gap rather than
        /// answered — a member analyzers branch on must not silently say "no".
        /// </para>
        /// </remarks>
        /// <param name="member">The member access.</param>
        /// <param name="result">The rewritten expression.</param>
        /// <returns>True when this hook handled the access.</returns>
        private bool TryTranslateCalleeSurfaceMember(
            MemberAccessExpressionSyntax member, out GExpression result)
        {
            result = null;
            string name = member.Name.Identifier.Text;
            if (name is not ("ReturnType" or "OverriddenMethod")
                || member.Expression is not MemberAccessExpressionSyntax { Name.Identifier.Text: "TargetMethod" } targetMethod
                || this.context.GetSymbolInfo(targetMethod).Symbol is not IPropertySymbol { Name: "TargetMethod" } property
                || RoslynTypeMetadataName(property.ContainingType) != "Microsoft.CodeAnalysis.Operations.IInvocationOperation")
            {
                return false;
            }

            if (name == "OverriddenMethod")
            {
                const string GapNote =
                    "'TargetMethod.OverriddenMethod' has no G# counterpart at a call site: an imported callee "
                    + "carries no override chain, so every call into metadata would read null. Rewrite the rule "
                    + "against the declaring symbol, where FunctionSymbol.OverriddenMethod is meaningful.";
                this.context.Report(new TranslationDiagnostic(
                    "analyzer-api",
                    GapNote,
                    member.GetLocation(),
                    TranslationSeverity.Unsupported)
                {
                    DiagnosticId = "CS2GS-GAP",
                });
                return false;
            }

            const string ShapeNote =
                "'TargetMethod.ReturnType' translated as the call node's own type: G#'s callee symbol carries "
                + "the DECLARATION's return type, so a constructed generic call would report the type parameter.";
            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                ShapeNote,
                member.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });
            result = new MemberAccessExpression(
                this.TranslateExpression(targetMethod.Expression), "Type", isArrow: false);
            return true;
        }

        /// <summary>
        /// Whether an argument spells one operation kind directly, as
        /// <c>OperationKind.X</c>.
        /// </summary>
        /// <param name="expression">The argument expression.</param>
        /// <param name="context">The translation context.</param>
        /// <returns>True for a direct <c>OperationKind</c> member access.</returns>
        private static bool IsDirectOperationKindAccess(
            ExpressionSyntax expression, TranslationContext context)
            => expression is MemberAccessExpressionSyntax
                && context.GetSymbolInfo(expression).Symbol is IFieldSymbol field
                && RoslynTypeMetadataName(field.ContainingType) == "Microsoft.CodeAnalysis.OperationKind";

        /// <summary>
        /// The parameter an argument binds to, by NAME when the argument is
        /// named and by position otherwise, with a trailing <c>params</c> array
        /// absorbing the tail.
        /// </summary>
        /// <param name="argument">The argument syntax.</param>
        /// <param name="context">The translation context.</param>
        /// <returns>The bound parameter, or null when it cannot be determined.</returns>
        private static IParameterSymbol DetermineParameter(
            ArgumentSyntax argument, TranslationContext context)
        {
            if (argument.Parent is not BaseArgumentListSyntax list
                || list.Parent is null
                || context.GetSymbolInfo(list.Parent).Symbol is not IMethodSymbol method)
            {
                return null;
            }

            if (argument.NameColon is { Name.Identifier.ValueText: { Length: > 0 } named })
            {
                return method.Parameters.FirstOrDefault(p => p.Name == named);
            }

            int index = list.Arguments.IndexOf(argument);
            if (index < 0)
            {
                return null;
            }

            if (index < method.Parameters.Length)
            {
                return method.Parameters[index];
            }

            IParameterSymbol last = method.Parameters.LastOrDefault();
            return last is { IsParams: true } ? last : null;
        }

        /// <summary>
        /// Whether an argument binds to the <c>operationKinds</c> parameter of
        /// <c>RegisterOperationAction</c> — the question "is this argument a
        /// kind?" answered from the SYMBOL, so named arguments in any order are
        /// classified correctly (PR #3968 review).
        /// </summary>
        /// <param name="argument">The argument syntax.</param>
        /// <param name="context">The translation context.</param>
        /// <returns>True when the argument supplies operation kinds.</returns>
        private static bool BindsToOperationKindsParameter(
            ArgumentSyntax argument, TranslationContext context)
        {
            ITypeSymbol type = DetermineParameter(argument, context)?.Type;
            if (type is null)
            {
                return false;
            }

            if (RoslynTypeMetadataName(type as INamedTypeSymbol) == "Microsoft.CodeAnalysis.OperationKind")
            {
                return true;
            }

            ITypeSymbol element = type switch
            {
                IArrayTypeSymbol array => array.ElementType,
                INamedTypeSymbol { TypeArguments.Length: 1 } named => named.TypeArguments[0],
                _ => null,
            };

            return RoslynTypeMetadataName(element as INamedTypeSymbol) == "Microsoft.CodeAnalysis.OperationKind";
        }

        private bool TryTranslateAnalyzerTypeNameSwitch(SwitchExpressionSyntax node, out GExpression result)
        {
            result = null;
            if (node.GoverningExpression is not IdentifierNameSyntax { Identifier.Text: { } parameterName }
                || node.Arms.Count != 4
                || node.Arms[0].Pattern is not DeclarationPatternSyntax first
                || first.Type is not IdentifierNameSyntax { Identifier.Text: "IdentifierNameSyntax" }
                || node.Arms[1].Pattern is not DeclarationPatternSyntax second
                || second.Type is not IdentifierNameSyntax { Identifier.Text: "QualifiedNameSyntax" }
                || node.Arms[2].Pattern is not DeclarationPatternSyntax third
                || third.Type is not IdentifierNameSyntax { Identifier.Text: "GenericNameSyntax" }
                || node.Arms[3].Pattern is not DiscardPatternSyntax)
            {
                return false;
            }

            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                "Roslyn simple/qualified/generic TypeSyntax name switch translated to TypeClauseSyntax.NameIdentifier: G# represents all named type clauses in one node.",
                node.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });

            GExpression nameIdentifier = new MemberAccessExpression(
                new IdentifierExpression(parameterName),
                "NameIdentifier",
                isArrow: false);
            result = new IfExpression(
                new BinaryExpression(nameIdentifier, "!=", LiteralExpression.Null()),
                new MemberAccessExpression(
                    new NonNullAssertionExpression(nameIdentifier),
                    "Text",
                    isArrow: false),
                LiteralExpression.Null());
            return true;
        }

        private string TranslateAnalyzerPatternFieldName(
            RecursivePatternSyntax recursive,
            SubpatternSyntax subpattern,
            string fieldName)
        {
            if (!this.InAnalyzerApiMode
                || fieldName != "Expression"
                || recursive.Type is not IdentifierNameSyntax invocationType
                || invocationType.Identifier.Text != "InvocationExpressionSyntax"
                || this.GetPatternMemberSymbol(subpattern.NameColon?.Name) is not IPropertySymbol property
                || RoslynTypeMetadataName(property.ContainingType)
                    != "Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax")
            {
                return fieldName;
            }

            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                "InvocationExpressionSyntax.Expression property pattern translated to CallExpressionSyntax.Parent.",
                subpattern.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });
            return "Parent";
        }

        /// <summary>
        /// Rewrites <c>namespaceSymbol?.ToDisplayString()</c> to the bare
        /// receiver: G#'s <c>ContainingNamespace</c> is already the (nullable)
        /// display string.
        /// </summary>
        private bool TryTranslateAnalyzerConditionalDisplay(ConditionalAccessExpressionSyntax conditionalAccess, out GExpression result)
        {
            result = null;
            if (conditionalAccess.WhenNotNull is MemberBindingExpressionSyntax { Name.Identifier.Text: "Value" }
                && this.context.GetTypeInfo(conditionalAccess.Expression).Type is INamedTypeSymbol initializerType
                && RoslynTypeMetadataName(initializerType)
                    == "Microsoft.CodeAnalysis.CSharp.Syntax.EqualsValueClauseSyntax")
            {
                this.context.Report(new TranslationDiagnostic(
                    "analyzer-api",
                    "EqualsValueClauseSyntax.Value wrapper dropped: G# VariableDeclarationSyntax exposes Initializer directly.",
                    conditionalAccess.GetLocation(),
                    TranslationSeverity.Warning)
                {
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE",
                });
                result = this.TranslateExpression(conditionalAccess.Expression);
                return true;
            }

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

            // `symbol.Locations` dereferences `symbol`: ordinary receiver
            // forgiveness, as for any member read (issue #4356).
            result = new MemberAccessExpression(
                this.TranslateReceiverWithNullForgiveness(locationsAccess.Expression),
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

            // Issue #4356: the C# is a pattern TEST on `X.Parent` — a nil parent
            // simply fails `is AssignmentExpressionSyntax a` — never a
            // dereference of it. So the synthesized `.Kind` read is
            // null-conditional (`X.Parent?.Kind == SyntaxKind.…`, false for a
            // nil parent), not the `!!` the ordinary receiver forgiveness would
            // pick for a `T?` receiver like `SyntaxNode.Parent`: asserting would
            // turn "not an assignment target" into a NullReferenceException.
            // The lifted `SyntaxKind?` only feeds `==`, so the `?.` result
            // type is harmless here.
            GExpression parentKind = new ConditionalAccessExpression(
                this.TranslateExpression(parentExpression),
                new MemberAccessExpression(new ConditionalReceiverExpression(), "Kind", isArrow: false));
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

            foreach ((ExpressionSyntax methodSide, ExpressionSyntax kindSide) in new[]
                {
                    (binary.Left, binary.Right),
                    (binary.Right, binary.Left),
                })
            {
                if (methodSide is not MemberAccessExpressionSyntax { Name.Identifier.Text: "MethodKind" } methodKindAccess
                    || this.context.GetSymbolInfo(methodKindAccess).Symbol is not IPropertySymbol methodKindProperty
                    || methodKindProperty.Name != "MethodKind"
                    || methodKindProperty.ContainingType.Name != "IMethodSymbol"
                    || kindSide is not MemberAccessExpressionSyntax { Name.Identifier.Text: "Constructor" or "Ordinary" } kindAccess
                    || this.context.GetSymbolInfo(kindAccess).Symbol is not IFieldSymbol kindField
                    || kindField.ContainingType.Name != "MethodKind")
                {
                    continue;
                }

                bool constructorKind = kindAccess.Name.Identifier.Text == "Constructor";
                string op = constructorKind == isEquals ? "==" : "!=";
                result = new BinaryExpression(
                    new MemberAccessExpression(
                        this.TranslateExpression(methodKindAccess.Expression),
                        "Name",
                        isArrow: false),
                    op,
                    LiteralExpression.String(".ctor"));
                this.context.Report(new TranslationDiagnostic(
                    "analyzer-api",
                    $"MethodKind.{kindAccess.Name.Identifier.Text} comparison translated to the G# constructor callable name '.ctor'.",
                    binary.GetLocation(),
                    TranslationSeverity.Warning)
                {
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE",
                });
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

        /// <summary>
        /// Recognizes the entry point of a Roslyn analyzer TEST harness
        /// (ADR-0169 M5, issue #3686): a static method that takes an analyzer
        /// and a source string, i.e. the repo's
        /// <c>AnalyzerTestHelper.AssertDiagnosticsAsync</c> shape.
        /// </summary>
        /// <remarks>
        /// The harness body is the one place where a statement-by-statement
        /// translation would be WRONG rather than merely hard. It builds a
        /// Roslyn <c>CSharpCompilation</c> over metadata references pulled from
        /// <c>TRUSTED_PLATFORM_ASSEMBLIES</c> and drives it with Roslyn's
        /// analyzer driver — a pipeline whose G# counterpart takes NO metadata
        /// references at all, so the faithful translation of
        /// <c>GetReferences()</c> is deletion, not mapping. Translating each
        /// call in isolation would reimplement, inside the migrated test
        /// project, the marker-stripping and assertion logic that
        /// <c>GSharpAnalyzerVerifier</c> already owns and tests. The rewrite
        /// therefore replaces the whole body with a delegation to that
        /// verifier, keeping the harness's own signature — so every call site
        /// in the migrated tests is untouched — and reports the substitution as
        /// a shape adaptation.
        /// <para>
        /// The shape test itself lives on <see cref="AnalyzerProjectDetector"/>
        /// (issue #3789): the presence of a harness is also what decides
        /// whether a project enters analyzer mode at all, and the two must be
        /// one predicate — a project is claimed exactly when there is a harness
        /// here to rewrite.
        /// </para>
        /// </remarks>
        /// <param name="symbol">The method being translated.</param>
        /// <returns>True when this method is the harness entry point.</returns>
        private bool IsAnalyzerHarnessEntry(IMethodSymbol symbol)
            => this.InAnalyzerApiMode && AnalyzerProjectDetector.IsAnalyzerTestHarnessEntry(symbol);

        /// <summary>
        /// True when <paramref name="method"/> is private plumbing that exists
        /// only to serve the harness entry point rewritten above — so once the
        /// body is a one-line delegation, the member is dead code that would
        /// still drag unmapped Roslyn types (<c>MetadataReference</c>) into the
        /// migrated project. Members used from anywhere else are kept.
        /// </summary>
        /// <param name="method">The candidate support method.</param>
        /// <returns>True when the member must not be emitted.</returns>
        private bool IsAnalyzerHarnessSupportMember(MethodDeclarationSyntax method)
        {
            if (!this.InAnalyzerApiMode
                || this.context.GetDeclaredSymbol(method) is not IMethodSymbol symbol
                || !symbol.IsStatic
                || symbol.DeclaredAccessibility != Accessibility.Private
                || method.Parent is not TypeDeclarationSyntax owner)
            {
                return false;
            }

            var entries = owner.Members
                .OfType<MethodDeclarationSyntax>()
                .Where(candidate => this.context.GetDeclaredSymbol(candidate) is IMethodSymbol candidateSymbol
                    && this.IsAnalyzerHarnessEntry(candidateSymbol))
                .ToList();
            if (entries.Count == 0)
            {
                return false;
            }

            var uses = owner.DescendantNodes()
                .OfType<InvocationExpressionSyntax>()
                .Where(invocation => SymbolEqualityComparer.Default.Equals(
                    this.context.GetSymbolInfo(invocation).Symbol?.OriginalDefinition,
                    symbol))
                .ToList();

            return uses.Count > 0
                && uses.All(use => entries.Any(entry => entry.Span.Contains(use.Span)));
        }

        /// <summary>
        /// Builds the delegating body for the harness entry point:
        /// <c>GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, source, ids)</c>,
        /// followed by <c>return Task.CompletedTask</c> when the harness kept
        /// its Task-returning shape (so the migrated <c>[Fact]</c> methods,
        /// which <c>return</c> the harness call, need no rewrite of their own).
        /// </summary>
        /// <param name="symbol">The harness method.</param>
        /// <param name="parameters">Its already-mapped G# parameters.</param>
        /// <param name="site">The syntax node to attribute the shape warning to.</param>
        /// <param name="body">The synthesized body.</param>
        /// <returns>True when a body was synthesized.</returns>
        private bool TryBuildAnalyzerHarnessBody(
            IMethodSymbol symbol,
            IReadOnlyList<Parameter> parameters,
            SyntaxNode site,
            out BlockStatement body)
        {
            body = null;
            if (!this.IsAnalyzerHarnessEntry(symbol) || parameters.Count < 2)
            {
                return false;
            }

            this.typeMapper.TrackSubstitutedNamespace(AnalyzerVerifierNamespace);

            var call = new InvocationExpression(
                new MemberAccessExpression(
                    new IdentifierExpression("GSharpAnalyzerVerifier"),
                    "VerifyAnalyzer"),
                parameters.Select(parameter => (GExpression)new IdentifierExpression(parameter.Name)).ToList());

            var statements = new List<GStatement> { new ExpressionStatement(call) };
            if (ReturnsTask(symbol))
            {
                statements.Add(new ReturnStatement(
                    new MemberAccessExpression(new IdentifierExpression("Task"), "CompletedTask")));
            }

            body = new BlockStatement(statements);
            string message = $"analyzer test harness '{symbol.Name}' rewritten to delegate to "
                + $"{AnalyzerVerifierNamespace}.GSharpAnalyzerVerifier.VerifyAnalyzer: the Roslyn compilation "
                + "pipeline it drove (CSharpCompilation over TRUSTED_PLATFORM_ASSEMBLIES metadata references) "
                + "has no G# counterpart — the G# verifier compiles G# source with no reference set. The "
                + "harness signature and every call site are preserved; verify the expected diagnostic "
                + "locations still hold over the TRANSLATED snippets (ADR-0169 M5, issue #3686).";
            this.context.Report(new TranslationDiagnostic(
                "analyzer-api",
                message,
                site.GetLocation(),
                TranslationSeverity.Warning)
            {
                DiagnosticId = "CS2GS-ANALYZER-SHAPE",
            });
            return true;
        }

        private static bool ReturnsTask(IMethodSymbol symbol)
            => symbol.ReturnType is INamedTypeSymbol { Name: "Task" } returnType
               && returnType.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks";

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
