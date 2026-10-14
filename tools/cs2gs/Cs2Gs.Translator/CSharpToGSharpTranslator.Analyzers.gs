// <copyright file="CSharpToGSharpTranslator.Analyzers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Cs2Gs.Translator.Analyzers
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.Linq

/// ADR-0169 analyzer translation mode: the per-construct rewrites that turn
/// Roslyn analyzer code into G# analyzer-API code
/// (docs/cs2gs-analyzer-translation.md). Type rewrites live in
/// (cref:CSharpTypeMapper); this partial holds the member-name, enum-
/// member, invocation-idiom, attribute, and comparison-lowering hooks on the
/// declaration visitor, each an early-out Try* guard.
partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        private prop InAnalyzerApiMode bool -> this.typeMapper.AnalyzerApiMode

        /// Builds a call to one of the `GSharp.Core.CodeAnalysis.Syntax.NullConditionalChain`
        /// static helpers (issue #4173) — the shared entry point every I1/I3/I3a/I4/I5/I8 idiom below
        /// uses to reach the src/Core runtime utility that walks a G# null-conditional access chain.
        /// @param methodName The `NullConditionalChain` member name.
        /// @param arguments The call arguments.
        /// @returns The invocation expression.
        private func InvokeNullConditionalChain(methodName string, arguments ...GExpression?) GExpression {
            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax")
            return InvocationExpression(
                MemberAccessExpression(IdentifierExpression("NullConditionalChain"), methodName, isArrow: false),
                List[GExpression](arguments)
            )
        }

        /// Resolves a pattern's type-position expression to its Roslyn metadata name, or null.
        private func AnalyzerPatternTypeName(typeSyntax ExpressionSyntax?) string? -> if typeSyntax == nil ||
            !this.InAnalyzerApiMode {
            default(string?)
        } else {
            RoslynTypeMetadataName(
                (
                    this
                        .context
                        .GetTypeInfo(typeSyntax)
                        .Type ??
                        this
                        .context
                        .GetSymbolInfo(typeSyntax)
                        .Symbol as ITypeSymbol
                ) as INamedTypeSymbol
            )
        }

        private func IsPlainAccessAnalyzerType(typeSyntax ExpressionSyntax?, out gsNodeName string?) bool {
            gsNodeName = nil
            let name string? = this.AnalyzerPatternTypeName(typeSyntax)
            return name != nil && PlainAccessAnalyzerTypes.TryGetValue(name, out gsNodeName)
        }

        private func IsConditionalAccessAnalyzerType(typeSyntax ExpressionSyntax?) bool -> this.AnalyzerPatternTypeName(
            typeSyntax
        ) == ConditionalAccessTypeName

        /// True when ANY node anywhere inside [`pattern`](paramref) names
        /// `ConditionalAccessExpressionSyntax` (issue #4173, round 3).
        ///
        /// Deliberately a flat `SyntaxNode.DescendantNodesAndSelf` scan
        /// with NO switch over pattern kinds. Two earlier fixes for this exact
        /// soundness bug discriminated by enumerating C# pattern shapes
        /// (`IsPatternTypeSyntax`'s three cases), and BOTH failed open on the
        /// shapes the enumeration omitted (`not`, `and`/`or`,
        /// `case` labels, nested recursive subpatterns). A scan cannot be
        /// defeated by a pattern shape nobody enumerated; do not "simplify" it
        /// back into a shape walk.
        private func PatternMentionsConditionalAccessType(pattern PatternSyntax?, out site ExpressionSyntax?) bool {
            site = nil
            if !this.InAnalyzerApiMode || pattern == nil {
                return false
            }
            for node in pattern.DescendantNodesAndSelf() {
                if node is ExpressionSyntax candidate && this.IsConditionalAccessAnalyzerType(candidate) {
                    site = candidate
                    return true
                }
            }
            return false
        }

        /// The single pattern-position type mapping (issue #4173 round 3). Returns
        /// the G# type the pattern should test, plus the extra property-pattern
        /// field the faithful rewrite needs for a shared-node Roslyn type
        /// ((cref:PlainAccessAnalyzerTypes)), or null for an ordinary type.
        private func MapPatternTypeSyntax(
            typeSyntax ExpressionSyntax?,
            site SyntaxNode?,
            out discriminator PropertyPatternField?
        ) GTypeReference? {
            discriminator = nil
            if this.IsPlainAccessAnalyzerType(typeSyntax, out var gsNodeName) {
                this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax")
                this.ReportPlainAccessShape(site, gsNodeName)
                discriminator = PropertyPatternField(
                    "IsNullConditional",
                    ConstantPattern(LiteralExpression.Bool(false))
                )
                return NamedTypeReference(gsNodeName)
            }
            if this.IsConditionalAccessAnalyzerType(typeSyntax) {
                // Reached only from a GPattern-only position (a switch label /
                // switch-expression arm / a nested property subpattern that could
                // not be boolean-lowered). CAE's faithful G# form is a PREDICATE,
                // not a node type, so there is no sound pattern to emit here.
                this.ReportConditionalAccessPatternGap(site)
            }
            return if typeSyntax is TypeSyntax type {
                this.MapTypeSyntax(type)
            } else {
                this.MapTypeReferenceExpression(typeSyntax)
            }
        }

        /// Builds a pattern-position type test, merging any §6 discriminator into the suffix.
        private func BuildPatternTypeTest(
            designator string?,
            typeSyntax ExpressionSyntax?,
            site SyntaxNode?,
            suffix PropertyPattern? = nil,
            designationAfterType bool = false
        ) GPattern {
            var suffix = suffix
            let mapped GTypeReference? = this.MapPatternTypeSyntax(typeSyntax, site, out var discriminator)
            if discriminator != nil {
                let fields = List[PropertyPatternField]{discriminator}
                if suffix != nil {
                    fields.AddRange(suffix.Fields)
                }
                suffix = PropertyPattern(fields, suffix?.Designator)
            }
            return TypePattern(designator, mapped, suffix, designationAfterType)
        }

        /// Builds a BOOLEAN-position type test (the `x is T` lowering).
        private func BuildTypeTestExpression(
            receiver GExpression?,
            typeSyntax ExpressionSyntax?,
            site SyntaxNode
        ) GExpression {
            if this.IsConditionalAccessAnalyzerType(typeSyntax) {
                // Distinct from MapPatternTypeSyntax's gap path: this IS the
                // sound rewrite, reachable because the caller is a BOOLEAN
                // position, not a G#-pattern-only position.
                this.ReportConditionalAccessBooleanShape(site)
                return BinaryExpression(
                    this.InvokeNullConditionalChain("AsNullConditionalHop", receiver),
                    "!=",
                    LiteralExpression.Null()
                )
            }
            let test = this.BuildPatternTypeTest("_", typeSyntax, site, suffix: nil, designationAfterType: true)
            return if test is TypePattern{Suffix: nil} bare {
                cast[GExpression](BinaryExpression(receiver, "is", TypeExpression(bare.Type)))
            } else {
                cast[GExpression](PatternTestExpression(receiver, test))
            }
        }

        private func ReportPlainAccessShape(site SyntaxNode?, gsNodeName string?) {
            let roslynName = if gsNodeName == "AccessorExpressionSyntax" {
                "MemberAccessExpressionSyntax"
            } else {
                "ElementAccessExpressionSyntax"
            }
            let shapeNote = "'$roslynName' in a pattern position translated to " +
                "'$gsNodeName { IsNullConditional: false }': G# folds the null-conditional spelling of " +
                "this access onto the SAME node, distinguished only by that flag — a bare type-name " +
                "substitution would silently over-match a null-conditional hop too (issue #4173 round 3)."
            this.context.Report(
                TranslationDiagnostic("analyzer-api", shapeNote, site!!.GetLocation(), TranslationSeverity.Warning){
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE"
                }
            )
        }

        private func ReportConditionalAccessBooleanShape(site SyntaxNode) {
            const ShapeNote = "'ConditionalAccessExpressionSyntax' translated to 'NullConditionalChain.AsNullConditionalHop(expr) " +
                "!= nil': G# folds a?.b onto the SAME node as a.b and a?[i] onto the SAME node as a[i], so the " +
                "faithful test is a predicate, not a type test (issue #4173 round 3)."
            this.context.Report(
                TranslationDiagnostic("analyzer-api", ShapeNote, site.GetLocation(), TranslationSeverity.Warning){
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE"
                }
            )
        }

        private func ReportConditionalAccessPatternGap(site SyntaxNode?) {
            const GapNote = "'ConditionalAccessExpressionSyntax' in a pattern position that G# can only express as a " +
                "PATTERN (a switch label, a switch-expression arm, or a nested property subpattern) has no " +
                "sound rewrite: G# folds a?.b onto the SAME node as a.b and a?[i] onto the SAME node as a[i], " +
                "so the only faithful test is the PREDICATE NullConditionalChain.AsNullConditionalHop(x) != nil, " +
                "which is not a pattern. Restructure as an 'is'-expression (issue #4173)."
            this.context.Report(
                TranslationDiagnostic("analyzer-api", GapNote, site!!.GetLocation(), TranslationSeverity.Unsupported){
                    DiagnosticId = "CS2GS-GAP"
                }
            )
        }

        /// True when [`expression`](paramref) is `<something>.Expression` or
        /// `<something>.WhenNotNull` where `<something>` is Roslyn's
        /// `ConditionalAccessExpressionSyntax` — the shape I4/I5 own. Roslyn never puts a CAE
        /// directly in the `.Expression` position (only its receiverless `WhenNotNull` chain
        /// does), so I1's naive type-test rewrite over-matches there if it does not step aside.
        /// @param expression The is-pattern's scrutinee.
        /// @returns True when I1 must refuse and let I4/I5 (or a loud gap) handle it instead.
        private func IsConditionalAccessReceiverOrTailRead(
            expression ExpressionSyntax
        ) bool -> expression is MemberAccessExpressionSyntax{
            Name: {Identifier: {Text: "Expression" or "WhenNotNull"}}
        } member &&
            this
            .context
            .GetTypeInfo(member.Expression)
            .Type is INamedTypeSymbol conditionalAccessType &&
            RoslynTypeMetadataName(
            conditionalAccessType
        ) == "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax"

        /// Rewrites a member name accessed on a Roslyn API type (enum members
        /// and instance members). Identity for unmapped members — the
        /// round-trip binder is the loud backstop when the identity name does
        /// not exist on the G# type.
        private func MapAnalyzerMemberName(member MemberAccessExpressionSyntax, memberName string?) string? {
            let symbol ISymbol? = this.context.GetSymbolInfo(member).Symbol
            let containingType INamedTypeSymbol? = symbol?.ContainingType
            let containingName string? = RoslynTypeMetadataName(containingType)
            if containingName == nil || !RoslynAnalyzerApiMap.IsRoslynNamespace(
                containingType!!.ContainingNamespace?.ToDisplayString()
            ) {
                return memberName
            }
            if symbol is IFieldSymbol field &&
                field
                .ContainingType
                .TypeKind == TypeKind.Enum &&
                RoslynAnalyzerApiMap
                .TryMapEnumMember(containingName, memberName, out var enumEntry) {
                this.ReportAnalyzerShapeIfAdapted(member, containingName, memberName, enumEntry)
                return enumEntry.GsName
            }
            if RoslynAnalyzerApiMap.TryMapMember(containingName, memberName, out var memberEntry) {
                this.ReportAnalyzerShapeIfAdapted(member, containingName, memberName, memberEntry)
                if memberEntry.GsName == nil {
                    // No G# counterpart. Comparison sites are lowered to a
                    // constant by TryLowerAnalyzerComparison before reaching
                    // here; any other use keeps the C# spelling so the
                    // round-trip binder fails loudly at the exact site.
                    return memberName
                }
                return memberEntry.GsName
            }
            return memberName
        }

        /// Member-access-level analyzer idioms that need more than a rename:
        /// `name.Identifier` on a Roslyn name node becomes
        /// `expr.GetLastToken()`, because G#'s
        /// `AccessorExpressionSyntax.RightPart` is an expression with no
        /// Identifier property.
        private func TryTranslateAnalyzerMemberAccess(
            member MemberAccessExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            if member
                .Name
                .Identifier
                .Text == "Value" &&
                (
                this
                    .context
                    .GetSymbolInfo(member)
                    .Symbol is IPropertySymbol and
                    {Name: "Value", ContainingType: {Name: "EqualsValueClauseSyntax"}}
            ) {
                result = this.TranslateExpression(member.Expression)
                return true
            }
            if member
                .Name
                .Identifier
                .Text == "Pattern" &&
                (
                this
                    .context
                    .GetSymbolInfo(member)
                    .Symbol is IPropertySymbol and
                    {Name: "Pattern", ContainingType: {Name: "CasePatternSwitchLabelSyntax"}}
            ) {
                result = NonNullAssertionExpression(
                    MemberAccessExpression(this.TranslateExpression(member.Expression), "Value", isArrow: false)
                )
                return true
            }
            if member
                .Name
                .Identifier
                .Text == "Identifier" &&
                member.Expression is IdentifierNameSyntax designationName &&
                this
                .context
                .GetSymbolInfo(designationName)
                .Symbol is ILocalSymbol designationLocal &&
                (
                designationLocal
                    .DeclaringSyntaxReferences
                    .FirstOrDefault()
                    ?.GetSyntax() is SingleVariableDesignationSyntax and
                    {
                    Parent: {
                        Parent: IsPatternExpressionSyntax and
                            {
                            Expression: ConditionalAccessExpressionSyntax and
                                {
                                Expression: MemberAccessExpressionSyntax and
                                    {Name: {Identifier: {Text: "ExpressionColon"}}}
                            }
                        }
                    }
                }
            ) {
                result = this.TranslateExpression(member.Expression)
                return true
            }
            if this.TryTranslateCalleeSurfaceMember(member, out result) {
                return true
            }
            if member
                .Name
                .Identifier
                .Text == "OperatorKind" &&
                this
                .context
                .GetSymbolInfo(member)
                .Symbol is IPropertySymbol{Name: "OperatorKind"} operatorKind &&
                RoslynTypeMetadataName(
                operatorKind.ContainingType
            ) == "Microsoft.CodeAnalysis.Operations.IBinaryOperation" {
                // IBinaryOperation.OperatorKind ->
                // BoundBinaryOperationExpression.BinaryOperatorKind. NOT
                // `.Op.Kind` (issue #3920): `Op` exists only on
                // BoundBinaryExpression, and the operand shapes these rules
                // care about bind to BoundClrBinaryOperatorExpression, which
                // carries the operator TOKEN instead. The shared base
                // normalizes both to the language operator vocabulary.
                result = MemberAccessExpression(
                    this.TranslateExpression(member.Expression),
                    "BinaryOperatorKind",
                    isArrow: false
                )
                return true
            }
            if member
                .Name
                .Identifier
                .Text == "Value" &&
                this
                .context
                .GetSymbolInfo(member)
                .Symbol is IPropertySymbol{Name: "Value"} argumentValue &&
                RoslynTypeMetadataName(
                argumentValue.ContainingType
            ) == "Microsoft.CodeAnalysis.Operations.IArgumentOperation" {
                // IArgumentOperation.Value drops: G# call arguments are the
                // bound expressions directly.
                result = this.TranslateExpression(member.Expression)
                return true
            }
            if member
                .Name
                .Identifier
                .Text == "Value" &&
                this
                .context
                .GetSymbolInfo(member)
                .Symbol is IPropertySymbol{Name: "Value"} initializerValue &&
                (
                RoslynTypeMetadataName(
                    initializerValue.ContainingType
                ) is "Microsoft.CodeAnalysis.Operations.IVariableInitializerOperation" or
                    "Microsoft.CodeAnalysis.Operations.ISymbolInitializerOperation"
            ) {
                // Issue #4436: IVariableInitializerOperation.Value drops — a G#
                // declaration's Initializer is the bound expression directly.
                result = this.TranslateExpression(member.Expression)
                return true
            }
            if member
                .Name
                .Identifier
                .Text == "ArgumentList" &&
                (member.Parent is MemberAccessExpressionSyntax and {Name: {Identifier: {Text: "Arguments"}}}) &&
                this
                .context
                .GetSymbolInfo(member)
                .Symbol is IPropertySymbol{Name: "ArgumentList"} argumentListProperty &&
                RoslynTypeMetadataName(
                argumentListProperty.ContainingType
            ) == "Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax" {
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
                result = this.TranslateExpression(member.Expression)
                return true
            }
            if member
                .Name
                .Identifier
                .Text == "ParameterList" &&
                (member.Parent is MemberAccessExpressionSyntax and {Name: {Identifier: {Text: "Parameters"}}}) &&
                this
                .context
                .GetSymbolInfo(member)
                .Symbol is IPropertySymbol{Name: "ParameterList"} parameterListProperty &&
                RoslynTypeMetadataName(
                parameterListProperty.ContainingType
            ) == "Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax" {
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
                result = this.TranslateExpression(member.Expression)
                return true
            }
            if member
                .Name
                .Identifier
                .Text == "Expression" &&
                this
                .context
                .GetSymbolInfo(member)
                .Symbol is IPropertySymbol{Name: "Expression"} argumentExpressionProperty &&
                RoslynTypeMetadataName(
                argumentExpressionProperty.ContainingType
            ) == "Microsoft.CodeAnalysis.CSharp.Syntax.ArgumentSyntax" {
                // ArgumentSyntax.Expression drops: G# call arguments are the
                // bound expressions directly, with no ArgumentSyntax wrapper.
                result = this.TranslateExpression(member.Expression)
                return true
            }
            if member
                .Name
                .Identifier
                .Text == "Expression" &&
                this
                .context
                .GetTypeInfo(member.Expression)
                .Type is INamedTypeSymbol conditionalAccessReceiverType &&
                RoslynTypeMetadataName(
                conditionalAccessReceiverType
            ) == "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax" {
                // Issue #4173, I3: <x>.Expression where x is CAE-typed -> the
                // hop's own receiver slot. Same value as Roslyn's receiverless
                // Expression at every hop, but only extent- and lifted-type-
                // exact at the FIRST hop of a chain; a later hop's receiver
                // slot holds just the next member NAME, not the accumulated
                // receiver (issue #4173 §5 — see ReceiverSpan for the
                // location-exact alternative, wired through I3a below).
                const ShapeNote = "'.Expression' on a null-conditional-access node translated to 'NullConditionalChain.NullConditionalReceiver(x)': " +
                    "same VALUE as Roslyn's receiverless Expression at every hop, but only extent- and lifted-type-exact at the " +
                    "chain's first hop — a later hop's receiver slot holds just the next member name, not the accumulated " +
                    "receiver (issue #4173 §5)."
                this.context.Report(
                    TranslationDiagnostic("analyzer-api", ShapeNote, member.GetLocation(), TranslationSeverity.Warning){
                        DiagnosticId = "CS2GS-ANALYZER-SHAPE"
                    }
                )
                result = this.InvokeNullConditionalChain(
                    "NullConditionalReceiver",
                    this.TranslateExpression(member.Expression)
                )
                return true
            }
            if member.Name.Identifier.Text == "Span" && this.TryTranslateAnalyzerNullConditionalSpanRead(
                member.Expression,
                asLocation: false,
                out result
            ) {
                return true
            }
            if member
                .Name
                .Identifier
                .Text == "Arguments" &&
                member.Expression is MemberAccessExpressionSyntax{
                Name: {Identifier: {Text: "ArgumentList"}}
            } elementBindingArgListAccess &&
                this
                .context
                .GetSymbolInfo(elementBindingArgListAccess)
                .Symbol is IPropertySymbol{Name: "ArgumentList"} elementBindingArgListProperty &&
                RoslynTypeMetadataName(
                elementBindingArgListProperty.ContainingType
            ) == "Microsoft.CodeAnalysis.CSharp.Syntax.ElementBindingExpressionSyntax" {
                // Issue #4173, I6: ElementBindingExpressionSyntax.ArgumentList.Arguments
                // drops the wrapper: G#'s IndexExpressionSyntax exposes Indices
                // directly, with no BracketedArgumentListSyntax wrapper.
                result = MemberAccessExpression(
                    this.TranslateExpression(elementBindingArgListAccess.Expression),
                    "Indices",
                    isArrow: false
                )
                return true
            }
            if member.Name.Identifier.Text != "Identifier" {
                return false
            }
            if this
                .context
                .GetSymbolInfo(member)
                .Symbol is not IPropertySymbol{Name: "Identifier"} property ||
                RoslynTypeMetadataName(property.ContainingType) is not(
                "Microsoft.CodeAnalysis.CSharp.Syntax.SimpleNameSyntax" or
                    "Microsoft.CodeAnalysis.CSharp.Syntax.IdentifierNameSyntax" or
                    "Microsoft.CodeAnalysis.CSharp.Syntax.NameSyntax"
            ) {
                return false
            }
            result = InvocationExpression(
                MemberAccessExpression(this.TranslateExpression(member.Expression), "GetLastToken", isArrow: false)
            )
            return true
        }

        /// Rewrites the C# base-call detection idiom
        /// (`invocation.Expression is MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax }`)
        /// to G#'s faithful shape. G# gives `base.M(...)` its own
        /// `BaseClassCallExpressionSyntax` node wrapping an ordinary
        /// `CallExpressionSyntax` as its `Call`, rather than parsing
        /// it as a member access on a `base` receiver (issue #2534) — so a
        /// call found by walking for `CallExpressionSyntax` nodes is a
        /// base call exactly when its <em>parent</em> is that wrapper node.
        private func TryTranslateAnalyzerBaseCallCheck(
            isPattern IsPatternExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            if isPattern.Expression is ConditionalAccessExpressionSyntax conditional &&
                conditional.Expression is MemberAccessExpressionSyntax expressionColon &&
                expressionColon
                .Name
                .Identifier
                .Text == "ExpressionColon" &&
                (
                conditional.WhenNotNull is MemberBindingExpressionSyntax and {Name: {Identifier: {Text: "Expression"}}}
            ) &&
                expressionColon.Expression is ExpressionSyntax propertyFieldSource &&
                this
                .context
                .GetTypeInfo(propertyFieldSource)
                .Type is INamedTypeSymbol propertyFieldType &&
                RoslynTypeMetadataName(propertyFieldType) == "Microsoft.CodeAnalysis.CSharp.Syntax.SubpatternSyntax" &&
                isPattern.Pattern is DeclarationPatternSyntax{
                Type: IdentifierNameSyntax{Identifier: {Text: "IdentifierNameSyntax"}},
                Designation: SingleVariableDesignationSyntax{Identifier: {Text: {} designation}}
            } {
                this.context.Report(
                    TranslationDiagnostic(
                        "analyzer-api",
                        "SubpatternSyntax.ExpressionColon.Expression identifier test translated to PropertyPatternFieldSyntax.Identifier: G# property-pattern fields always carry the field token directly.",
                        isPattern.GetLocation(),
                        TranslationSeverity.Warning
                    ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
                )
                this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax")
                result = PatternTestExpression(
                    MemberAccessExpression(this.TranslateExpression(propertyFieldSource), "Identifier", isArrow: false),
                    TypePattern(designation, NamedTypeReference("SyntaxToken"), designationAfterType: true)
                )
                return true
            }
            if isPattern.Expression is not MemberAccessExpressionSyntax{
                Name: {Identifier: {Text: "Expression"}}
            } expressionAccess ||
                this
                .context
                .GetSymbolInfo(expressionAccess)
                .Symbol is not IPropertySymbol{Name: "Expression"} expressionProperty ||
                RoslynTypeMetadataName(
                expressionProperty.ContainingType
            ) != "Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax" ||
                !(
                isPattern.Pattern is RecursivePatternSyntax{
                    Designation: nil,
                    PositionalPatternClause: nil,
                    PropertyPatternClause: {Subpatterns: [SubpatternSyntax subpattern]}
                } recursivePattern
            ) ||
                subpattern
                .ExpressionColon
                ?.Expression is not(IdentifierNameSyntax and {Identifier: {Text: "Expression"}}) ||
                BaseSubpatternTypeSyntax(subpattern.Pattern) is not{} baseTypeSyntax ||
                this
                .context
                .GetTypeInfo(recursivePattern.Type)
                .Type is not INamedTypeSymbol recursiveType ||
                RoslynTypeMetadataName(
                recursiveType
            ) != "Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax" ||
                this
                .context
                .GetTypeInfo(baseTypeSyntax)
                .Type is not INamedTypeSymbol baseType ||
                RoslynTypeMetadataName(baseType) != "Microsoft.CodeAnalysis.CSharp.Syntax.BaseExpressionSyntax" {
                return false
            }
            this.context.Report(
                TranslationDiagnostic(
                    "analyzer-api",
                    "Base-call detection idiom 'invocation.Expression is MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax }' translated as 'invocation.Parent is BaseClassCallExpressionSyntax': G# gives base.M(...) its own node wrapping an ordinary call, rather than a member access on a base receiver.",
                    isPattern.GetLocation(),
                    TranslationSeverity.Warning
                ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
            )
            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax")
            result = PatternTestExpression(
                MemberAccessExpression(this.TranslateExpression(expressionAccess.Expression), "Parent", isArrow: false),
                TypePattern("_", NamedTypeReference("BaseClassCallExpressionSyntax"), designationAfterType: true)
            )
            return true
        }

        /// Rewrites the C# null-conditional-access type test
        /// (`expr is ConditionalAccessExpressionSyntax [x]`) to G#'s
        /// faithful shape (issue #4173): `NullConditionalChain.AsNullConditionalHop(expr)
        /// is ExpressionSyntax [x]`. Roslyn gives `a?.b` AND `a?[i]` the same
        /// `ConditionalAccessExpressionSyntax` outer kind; G# instead folds `a?.b`
        /// onto the SAME node as `a.b` (`AccessorExpressionSyntax`) and `a?[i]`
        /// onto the SAME node as `a[i]` (`IndexExpressionSyntax`), each distinguished
        /// only by its own `IsNullConditional` flag — so a naive type/kind rename would
        /// match every ordinary access, not just null-conditional ones, and a rewrite that
        /// covers only the accessor shape would under-match `a?[i]`.
        /// `NullConditionalChain.AsNullConditionalHop` answers "is THIS node a
        /// null-conditional hop" uniformly across both G# node kinds, matching Roslyn's
        /// per-node `ConditionalAccessExpressionSyntax` kind test one for one regardless
        /// of chain depth or accessor-vs-element shape.
        ///
        /// Refuses when [`scrutinee`](paramref) is itself
        /// `<x>.Expression`/`<x>.WhenNotNull` on a CAE-typed `x`
        /// ((cref:IsConditionalAccessReceiverOrTailRead(ExpressionSyntax))): Roslyn
        /// never puts a genuine CAE directly in the `.Expression` position, and a bare
        /// `AsNullConditionalHop` rewrite of `.WhenNotNull`/`.Expression` (which
        /// have no G# counterpart on their own) would silently mistranslate rather than route to
        /// I4/I5's dedicated handling — or, failing that, a loud gap.
        private func TryTranslateAnalyzerConditionalAccessTypeTest(
            scrutinee ExpressionSyntax,
            typeSyntax ExpressionSyntax?,
            designation VariableDesignationSyntax?,
            site SyntaxNode,
            out result GExpression?
        ) bool {
            result = nil
            if typeSyntax == nil ||
                this
                .context
                .GetTypeInfo(typeSyntax)
                .Type is not INamedTypeSymbol typeSymbol ||
                RoslynTypeMetadataName(
                typeSymbol
            ) != "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax" {
                return false
            }
            if this.IsConditionalAccessReceiverOrTailRead(scrutinee) {
                return false
            }
            const ShapeNote = "'is ConditionalAccessExpressionSyntax' translated to 'NullConditionalChain.AsNullConditionalHop(expr) is ExpressionSyntax': " +
                "G# folds a?.b onto the SAME node as a.b and a?[i] onto the SAME node as a[i], each distinguished only by an " +
                "IsNullConditional flag, not a distinct kind; AsNullConditionalHop matches both shapes uniformly."
            this.context.Report(
                TranslationDiagnostic("analyzer-api", ShapeNote, site.GetLocation(), TranslationSeverity.Warning){
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE"
                }
            )
            let binders = List[ILocalSymbol]()
            let designator string? = this.NativeDesignator(designation, binders)
            for binder in binders {
                this.state.PatternBindings[binder] = IdentifierExpression(this.EmittedName(binder, binder.Name))
                this.state.NativePatternVariables.Add(binder)
            }
            let receiver GExpression? = this.TranslateExpression(scrutinee)
            result = PatternTestExpression(
                this.InvokeNullConditionalChain("AsNullConditionalHop", receiver),
                TypePattern(designator, NamedTypeReference("ExpressionSyntax"), designationAfterType: true)
            )
            return true
        }

        /// The inverse sibling of (cref:TryTranslateAnalyzerConditionalAccessTypeTest)
        /// (issue #4173 §6): Roslyn's `MemberAccessExpressionSyntax` (an ORDINARY `.b`
        /// access) EXCLUDES a `?.` hop's tail — Roslyn gives that its own receiverless
        /// `MemberBindingExpressionSyntax` kind — but the existing
        /// `MemberAccessExpressionSyntax` → `AccessorExpressionSyntax` map row is
        /// unconditional, so `node is MemberAccessExpressionSyntax` silently over-matched
        /// every `?.` hop's tail too (G# has no separate node for it). Same fix shape as
        /// I1, one boolean flipped: `is AccessorExpressionSyntax { IsNullConditional: false }`.
        private func TryTranslateAnalyzerOrdinaryMemberAccessTypeTest(
            scrutinee ExpressionSyntax,
            typeSyntax ExpressionSyntax?,
            designation VariableDesignationSyntax?,
            site SyntaxNode,
            out result GExpression?
        ) bool {
            result = nil
            if typeSyntax == nil ||
                this
                .context
                .GetTypeInfo(typeSyntax)
                .Type is not INamedTypeSymbol typeSymbol ||
                RoslynTypeMetadataName(
                typeSymbol
            ) != "Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax" {
                return false
            }
            const ShapeNote = "'is MemberAccessExpressionSyntax' translated to 'is AccessorExpressionSyntax { IsNullConditional: false }': " +
                "a ?. hop's tail is Roslyn's receiverless MemberBindingExpressionSyntax, not MemberAccessExpressionSyntax, but " +
                "G# folds both onto the SAME node — the unconditional map row silently over-matched a ?. hop's tail too (#4173)."
            this.context.Report(
                TranslationDiagnostic("analyzer-api", ShapeNote, site.GetLocation(), TranslationSeverity.Warning){
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE"
                }
            )
            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax")
            let binders = List[ILocalSymbol]()
            let designator string? = this.NativeDesignator(designation, binders)
            for binder in binders {
                this.state.PatternBindings[binder] = IdentifierExpression(this.EmittedName(binder, binder.Name))
                this.state.NativePatternVariables.Add(binder)
            }
            let receiver GExpression? = this.TranslateExpression(scrutinee)
            let suffix = PropertyPattern(
                List[PropertyPatternField]{
                    PropertyPatternField("IsNullConditional", ConstantPattern(LiteralExpression.Bool(false)))
                }
            )
            result = PatternTestExpression(
                receiver,
                TypePattern(
                    designator,
                    NamedTypeReference("AccessorExpressionSyntax"),
                    suffix,
                    designationAfterType: true
                )
            )
            return true
        }

        /// Rewrites `<x>.WhenNotNull is <Type> [designator]` where `x` is
        /// CAE-typed (issue #4173, I4) — the companion of I1 that a per-node
        /// `IsNullConditional` flag alone cannot express, since it asks about the NEXT hop,
        /// not this one.
        private func TryTranslateAnalyzerNullConditionalWhenNotNullTest(
            scrutinee ExpressionSyntax,
            typeSyntax ExpressionSyntax?,
            designation VariableDesignationSyntax?,
            site SyntaxNode,
            out result GExpression?
        ) bool {
            result = nil
            if scrutinee is not MemberAccessExpressionSyntax{Name: {Identifier: {Text: "WhenNotNull"}}} access ||
                this
                .context
                .GetTypeInfo(access.Expression)
                .Type is not INamedTypeSymbol conditionalAccessType ||
                RoslynTypeMetadataName(
                conditionalAccessType
            ) != "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax" {
                return false
            }
            if typeSyntax == nil || this.context.GetTypeInfo(typeSyntax).Type is not INamedTypeSymbol patternType {
                return false
            }
            let translatedHop GExpression? = this.TranslateExpression(access.Expression)
            let metadataName string? = RoslynTypeMetadataName(patternType)
            var shapeNote string
            switch metadataName {
                case "Microsoft.CodeAnalysis.CSharp.Syntax.MemberBindingExpressionSyntax" {
                    result = this.InvokeNullConditionalChain("TailIsMemberBinding", translatedHop)
                    if designation is SingleVariableDesignationSyntax {
                        // TailIsMemberBinding(x) proven true structurally
                        // guarantees x IS an AccessorExpressionSyntax, but
                        // its own static G# type is the wider ExpressionSyntax
                        // (AsNullConditionalHop's uniform return type) — narrow
                        // the binding, same "(x as T)!!" convention
                        // BuildPatternNarrowingReplacement already uses for a
                        // non-smart-castable designator, so a LATER read of
                        // I6's RightPart/DotToken rows actually binds.
                        this.BindPatternDesignation(
                            designation,
                            NarrowToType(translatedHop, "AccessorExpressionSyntax")
                        )
                    }
                    shapeNote = "'WhenNotNull is MemberBindingExpressionSyntax' translated to 'NullConditionalChain.TailIsMemberBinding(x)': " +
                        "a null-conditional hop whose tail is a bare member name IS its own last operator in G#'s right-nested " +
                        "chain shape; a designator binds to '(x as AccessorExpressionSyntax)!!' — proven safe by TailIsMemberBinding."
                }
                case "Microsoft.CodeAnalysis.CSharp.Syntax.ElementBindingExpressionSyntax" {
                    result = this.InvokeNullConditionalChain("TailIsElementBinding", translatedHop)
                    if designation is SingleVariableDesignationSyntax {
                        this.BindPatternDesignation(designation, NarrowToType(translatedHop, "IndexExpressionSyntax"))
                    }
                    shapeNote = "'WhenNotNull is ElementBindingExpressionSyntax' translated to 'NullConditionalChain.TailIsElementBinding(x)': " +
                        "a designator binds to '(x as IndexExpressionSyntax)!!' — proven safe by TailIsElementBinding."
                }
                case "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax" {
                    {
                        let binders = List[ILocalSymbol]()
                        let designator string? = if designation != nil {
                            this.NativeDesignator(designation, binders)
                        } else {
                            "_"
                        }
                        for binder in binders {
                            this
                                .state
                                .PatternBindings[binder] = IdentifierExpression(this.EmittedName(binder, binder.Name))
                            this.state.NativePatternVariables.Add(binder)
                        }
                        result = PatternTestExpression(
                            this.InvokeNullConditionalChain("NextNullConditionalHop", translatedHop),
                            TypePattern(designator, NamedTypeReference("ExpressionSyntax"), designationAfterType: true)
                        )
                    }
                    shapeNote = "'WhenNotNull is ConditionalAccessExpressionSyntax' translated to " +
                        "'NullConditionalChain.NextNullConditionalHop(x) is ExpressionSyntax': the nearest FURTHER null-conditional " +
                        "hop in the same chain, possibly past an intervening ordinary access."
                }
                default {
                    return false
                }
            }
            this.context.Report(
                TranslationDiagnostic("analyzer-api", shapeNote, site.GetLocation(), TranslationSeverity.Warning){
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE"
                }
            )
            return true
        }

        /// Rewrites `<x>.Expression is <Type> [designator]` where `x` is
        /// CAE-typed (issue #4173, I5) — the companion of I4 for the RECEIVER side of a hop.
        private func TryTranslateAnalyzerNullConditionalExpressionTest(
            scrutinee ExpressionSyntax,
            typeSyntax ExpressionSyntax?,
            designation VariableDesignationSyntax?,
            site SyntaxNode,
            out result GExpression?
        ) bool {
            result = nil
            if scrutinee is not MemberAccessExpressionSyntax{Name: {Identifier: {Text: "Expression"}}} access ||
                this
                .context
                .GetTypeInfo(access.Expression)
                .Type is not INamedTypeSymbol conditionalAccessType ||
                RoslynTypeMetadataName(
                conditionalAccessType
            ) != "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax" {
                return false
            }
            if typeSyntax == nil || this.context.GetTypeInfo(typeSyntax).Type is not INamedTypeSymbol patternType {
                return false
            }
            let translatedHop GExpression? = this.TranslateExpression(access.Expression)
            let metadataName string? = RoslynTypeMetadataName(patternType)
            if metadataName == "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax" {
                // Roslyn never places a genuine (unparenthesized) CAE directly in the .Expression
                // position — only a parenthesized sub-chain break does (`(a?.b)?.c`) — and
                // NullConditionalReceiver's best-effort value would make this test vacuously true
                // for an ordinary hop. Not a rewrite this translator can prove sound (the same class
                // of reasoning the removed single-hop idiom failed on); left as a loud gap by
                // constructing the member access directly, bypassing I3's receiver rewrite.
                const GapNote = "'.Expression is ConditionalAccessExpressionSyntax' has no sound G# rewrite: Roslyn only reaches a genuine " +
                    "CAE there through a parenthesized chain break, which NullConditionalChain cannot distinguish from an " +
                    "ordinary hop without risking a vacuously-true test (issue #4173)."
                this.context.Report(
                    TranslationDiagnostic("analyzer-api", GapNote, site.GetLocation(), TranslationSeverity.Unsupported){
                        DiagnosticId = "CS2GS-GAP"
                    }
                )
                let binders = List[ILocalSymbol]()
                let designator string? = if designation != nil {
                    this.NativeDesignator(designation, binders)
                } else {
                    "_"
                }
                result = PatternTestExpression(
                    MemberAccessExpression(translatedHop, "Expression", isArrow: false),
                    TypePattern(designator, NamedTypeReference("ExpressionSyntax"), designationAfterType: true)
                )
                return true
            }
            var predicate GExpression
            var designatorValue GExpression
            var shapeNote string
            switch metadataName {
                case "Microsoft.CodeAnalysis.CSharp.Syntax.MemberBindingExpressionSyntax" {
                    predicate = this.InvokeNullConditionalChain("ReceiverIsMemberBinding", translatedHop)
                    // ReceiverIsMemberBinding(x) proven true structurally
                    // guarantees NullConditionalReceiver(x) IS an
                    // AccessorExpressionSyntax; narrow it the same
                    // "(x as T)!!" way I4 does, so a later I6 RightPart/
                    // DotToken read actually binds against the receiver's
                    // real G# type instead of the wider ExpressionSyntax.
                    designatorValue = NarrowToType(
                        this.InvokeNullConditionalChain("NullConditionalReceiver", translatedHop),
                        "AccessorExpressionSyntax"
                    )
                    shapeNote = "'Expression is MemberBindingExpressionSyntax' translated to 'NullConditionalChain.ReceiverIsMemberBinding(x)': " +
                        "true when x continues directly off a preceding ?. with no ordinary step in between; a designator binds " +
                        "to '(NullConditionalChain.NullConditionalReceiver(x) as AccessorExpressionSyntax)!!' (same value, not " +
                        "extent-exact — issue #4173 §5)."
                }
                case "Microsoft.CodeAnalysis.CSharp.Syntax.ElementBindingExpressionSyntax" {
                    predicate = this.InvokeNullConditionalChain("ReceiverIsElementBinding", translatedHop)
                    designatorValue = NarrowToType(
                        this.InvokeNullConditionalChain("NullConditionalReceiver", translatedHop),
                        "IndexExpressionSyntax"
                    )
                    shapeNote = "'Expression is ElementBindingExpressionSyntax' translated to 'NullConditionalChain.ReceiverIsElementBinding(x)': " +
                        "a designator binds to '(NullConditionalChain.NullConditionalReceiver(x) as IndexExpressionSyntax)!!'."
                }
                case "Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax" {
                    predicate = this.InvokeNullConditionalChain("ReceiverIsPlainMemberAccess", translatedHop)
                    designatorValue = NarrowToType(
                        MemberAccessExpression(translatedHop, "Parent", isArrow: false),
                        "AccessorExpressionSyntax"
                    )
                    shapeNote = "'Expression is MemberAccessExpressionSyntax' translated to 'NullConditionalChain.ReceiverIsPlainMemberAccess(x)': " +
                        "true when x continues directly off a preceding ORDINARY '.'; a designator binds to " +
                        "'(x.Parent as AccessorExpressionSyntax)!!', the ordinary accessor that reached x."
                }
                default {
                    return false
                }
            }
            result = predicate
            if designation is SingleVariableDesignationSyntax {
                this.BindPatternDesignation(designation, designatorValue)
            }
            this.context.Report(
                TranslationDiagnostic("analyzer-api", shapeNote, site.GetLocation(), TranslationSeverity.Warning){
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE"
                }
            )
            return true
        }

        /// The single entry point for every null-conditional-access idiom that
        /// hinges on a `<scrutinee> is <Type>` type test
        /// (issue #4173, I1/I1b/I4/I5) — reached from BOTH C# shapes a type
        /// test can take: (cref:IsPatternExpressionSyntax) (`is Type x`,
        /// `is Type { }`, ...) via `TranslateIsPattern`, and the
        /// classic (cref:BinaryExpressionSyntax)/`SyntaxKind.IsExpression`
        /// form (a BARE `expr is Type` with no designator, pattern
        /// combinator, or subpattern parses as this OLDER node kind, not a
        /// pattern, so it never reaches `TranslateIsPattern` at all) via
        /// the generic `as`/`is` binary-expression handler. I4/I5
        /// are tried first: they destructure [`scrutinee`](paramref)
        /// itself (looking for `<x>.WhenNotNull`/`<x>.Expression`),
        /// so trying them first makes I1's own refusal guard belt-and-braces
        /// rather than load-bearing. Without ALL FOUR wired through this one
        /// entry point, I7's deliberately non-discriminating
        /// `ConditionalAccessExpressionSyntax` → `ExpressionSyntax`
        /// map row (and the pre-existing, equally unconditional
        /// `MemberAccessExpressionSyntax` → `AccessorExpressionSyntax`
        /// row) would make a BARE `x is ConditionalAccessExpressionSyntax`/
        /// `x is MemberAccessExpressionSyntax` — with no designator, the
        /// commonest real-world spelling of both — silently vacuous or
        /// over-matching, exactly the class of bug I1/I1b exist to prevent for
        /// the designated form.
        /// @param scrutinee The tested expression.
        /// @param typeSyntax The tested type's syntax, however the C# parser shaped the test.
        /// @param designation The bound designator, or null for a bare test.
        /// @param site The node to attribute a diagnostic to.
        /// @param result The rewritten expression.
        /// @returns True when one of I1/I1b/I4/I5 handled the test.
        private func TryTranslateAnalyzerNullConditionalTypeTest(
            scrutinee ExpressionSyntax,
            typeSyntax ExpressionSyntax?,
            designation VariableDesignationSyntax?,
            site SyntaxNode,
            out result GExpression?
        ) bool {
            result = nil
            return this.InAnalyzerApiMode &&
                (
                this.TryTranslateAnalyzerNullConditionalWhenNotNullTest(
                    scrutinee,
                    typeSyntax,
                    designation,
                    site,
                    out result
                ) ||
                    this.TryTranslateAnalyzerNullConditionalExpressionTest(
                    scrutinee,
                    typeSyntax,
                    designation,
                    site,
                    out result
                ) ||
                    this.TryTranslateAnalyzerConditionalAccessTypeTest(
                    scrutinee,
                    typeSyntax,
                    designation,
                    site,
                    out result
                ) ||
                    this.TryTranslateAnalyzerOrdinaryMemberAccessTypeTest(
                    scrutinee,
                    typeSyntax,
                    designation,
                    site,
                    out result
                )
            )
        }

        /// Rewrites the C# switch-label walk idiom
        /// (`switchStatement.Sections.SelectMany(s => s.Labels).OfType<CasePatternSwitchLabelSyntax>()`)
        /// to a direct walk over G#'s cases. G# switch cases carry one pattern
        /// each via `SwitchCaseSyntax.Value` with no section/label
        /// nesting, and have no `default`-arm or pattern-label subtype to
        /// filter with `OfType`. Roslyn's `CasePatternSwitchLabelSyntax`
        /// excludes both the `default` arm and plain constant labels
        /// (`CaseSwitchLabelSyntax`, e.g. `case 5:`) — cs2gs's own
        /// switch-label translation ((cref:CSharpToGSharpTranslator)'s
        /// case-label lowering) turns a plain constant label into a G#
        /// `ConstantPatternSyntax` value with no guard, while a guarded
        /// constant (`case 5 when b:`, still a
        /// `CasePatternSwitchLabelSyntax` in Roslyn because `when`
        /// forces pattern-label parsing) keeps a non-null `Guard`. So the
        /// faithful G# equivalent excludes the `default` arm and any
        /// unguarded `ConstantPatternSyntax` value: `Cases.Where(c =>
        /// !c.IsDefault && (c.Guard != nil || c.Value is not
        /// ConstantPatternSyntax))` (#3536).
        private func TryTranslateAnalyzerSwitchLabelWalk(
            invocation InvocationExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            if this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is not IMethodSymbol{Name: "OfType"} ofTypeMethod ||
                ofTypeMethod
                .TypeArguments
                .Length != 1 ||
                RoslynTypeMetadataName(
                ofTypeMethod.TypeArguments[0] as INamedTypeSymbol
            ) != "Microsoft.CodeAnalysis.CSharp.Syntax.CasePatternSwitchLabelSyntax" ||
                !(
                invocation.Expression is MemberAccessExpressionSyntax{
                    Expression: InvocationExpressionSyntax selectManyInvocation
                }
            ) ||
                this
                .context
                .GetSymbolInfo(selectManyInvocation)
                .Symbol is not(IMethodSymbol and {Name: "SelectMany"}) ||
                !(
                selectManyInvocation.Expression is MemberAccessExpressionSyntax{
                    Name: {Identifier: {Text: "SelectMany"}},
                    Expression: MemberAccessExpressionSyntax{Name: {Identifier: {Text: "Sections"}}} sectionsAccess
                }
            ) ||
                this
                .context
                .GetSymbolInfo(sectionsAccess)
                .Symbol is not IPropertySymbol{Name: "Sections"} sectionsProperty ||
                RoslynTypeMetadataName(
                sectionsProperty.ContainingType
            ) != "Microsoft.CodeAnalysis.CSharp.Syntax.SwitchStatementSyntax" ||
                selectManyInvocation
                .ArgumentList
                .Arguments
                .Count != 1 ||
                !(
                selectManyInvocation
                    .ArgumentList
                    .Arguments[0]
                    .Expression is SimpleLambdaExpressionSyntax{
                    Parameter: {Identifier: {Text: {} sectionParameterName}},
                    ExpressionBody: MemberAccessExpressionSyntax{Name: {Identifier: {Text: "Labels"}}} labelsAccess
                }
            ) ||
                !(labelsAccess.Expression is IdentifierNameSyntax{Identifier: {Text: {} labelsReceiverName}}) ||
                labelsReceiverName != sectionParameterName ||
                this
                .context
                .GetSymbolInfo(labelsAccess)
                .Symbol is not IPropertySymbol{Name: "Labels"} labelsProperty ||
                RoslynTypeMetadataName(
                labelsProperty.ContainingType
            ) != "Microsoft.CodeAnalysis.CSharp.Syntax.SwitchSectionSyntax" {
                return false
            }
            this.context.Report(
                TranslationDiagnostic(
                    "analyzer-api",
                    "'Sections.SelectMany(s => s.Labels).OfType<CasePatternSwitchLabelSyntax>()' translated as 'Cases.Where(c => !c.IsDefault && (c.Guard != nil || c.Value is not ConstantPatternSyntax))': G# switch cases carry one pattern each with no section/label nesting or default-arm/pattern-label subtype, so the walk excludes the default arm and unguarded constant-value cases (Roslyn's plain, non-pattern case labels) to keep only genuine pattern labels.",
                    invocation.GetLocation(),
                    TranslationSeverity.Warning
                ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
            )
            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax")
            let cases GExpression = MemberAccessExpression(
                this.TranslateExpression(sectionsAccess.Expression),
                "Cases",
                isArrow: false
            )
            let filterParameter = Parameter("switchCase", NamedTypeReference("SwitchCaseSyntax"))
            let switchCaseIdentifier GExpression = IdentifierExpression("switchCase")
            let notDefault GExpression = UnaryExpression(
                "!",
                MemberAccessExpression(switchCaseIdentifier, "IsDefault", isArrow: false)
            )
            let hasGuard GExpression = BinaryExpression(
                MemberAccessExpression(switchCaseIdentifier, "Guard", isArrow: false),
                "!=",
                LiteralExpression.Null()
            )
            let valueIsNotConstant GExpression = PatternTestExpression(
                MemberAccessExpression(switchCaseIdentifier, "Value", isArrow: false),
                NotPattern(TypePattern("_", NamedTypeReference("ConstantPatternSyntax"), designationAfterType: true))
            )
            let filterBody GExpression = BinaryExpression(
                notDefault,
                "&&",
                BinaryExpression(hasGuard, "||", valueIsNotConstant)
            )
            result = InvocationExpression(
                MemberAccessExpression(cases, "Where", isArrow: false),
                List[GExpression]{LambdaExpression(List[Parameter]{filterParameter}, expressionBody: filterBody)}
            )
            return true
        }

        private func TryTranslateAnalyzerDesignationWalk(
            invocation InvocationExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            if this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is not IMethodSymbol{Name: "OfType", TypeArguments: {Length: 1}} method ||
                RoslynTypeMetadataName(
                method.TypeArguments[0] as INamedTypeSymbol
            ) != "Microsoft.CodeAnalysis.CSharp.Syntax.SingleVariableDesignationSyntax" ||
                !(
                invocation.Expression is MemberAccessExpressionSyntax{
                    Expression: InvocationExpressionSyntax descendants
                }
            ) ||
                this
                .context
                .GetSymbolInfo(descendants)
                .Symbol is not(IMethodSymbol and {Name: "DescendantNodesAndSelf"}) {
                return false
            }
            this.context.Report(
                TranslationDiagnostic(
                    "analyzer-api",
                    "SingleVariableDesignationSyntax walk translated to PatternSyntax nodes with a non-nil BindingIdentifier: G# stores designation tokens directly on pattern nodes.",
                    invocation.GetLocation(),
                    TranslationSeverity.Warning
                ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
            )
            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax")
            let patterns GExpression = InvocationExpression(
                MemberAccessExpression(this.TranslateExpression(descendants), "OfType", isArrow: false),
                typeArguments: []NamedTypeReference{NamedTypeReference("PatternSyntax")}
            )
            let parameter = Parameter("pattern", NamedTypeReference("PatternSyntax"))
            let binding GExpression = MemberAccessExpression(
                IdentifierExpression("pattern"),
                "BindingIdentifier",
                isArrow: false
            )
            result = InvocationExpression(
                MemberAccessExpression(patterns, "Where", isArrow: false),
                []LambdaExpression{
                    LambdaExpression(
                        []Parameter{parameter},
                        expressionBody: BinaryExpression(binding, "!=", LiteralExpression.Null())
                    )
                }
            )
            return true
        }

        private func TryTranslateAnalyzerConstructionForms(
            invocation InvocationExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            if this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is not IMethodSymbol{Name: "GetMembers"} getMembers ||
                RoslynTypeMetadataName(getMembers.ContainingType) != "Microsoft.CodeAnalysis.INamespaceOrTypeSymbol" ||
                !(invocation.Expression is MemberAccessExpressionSyntax{Expression: ExpressionSyntax receiver}) ||
                invocation.Parent is not MemberAccessExpressionSyntax{
                Name: GenericNameSyntax{Identifier: {Text: "OfType"}}
            } ofTypeAccess ||
                ofTypeAccess.Parent is not InvocationExpressionSyntax ofTypeInvocation ||
                this
                .context
                .GetSymbolInfo(ofTypeInvocation)
                .Symbol is not IMethodSymbol{Name: "OfType", TypeArguments: {Length: 1}} ofType ||
                RoslynTypeMetadataName(
                ofType.TypeArguments[0] as INamedTypeSymbol
            ) != "Microsoft.CodeAnalysis.IMethodSymbol" ||
                ofTypeInvocation.Parent is not(
                MemberAccessExpressionSyntax and {Name: {Identifier: {Text: "Where"}}}
            ) ||
                ofTypeInvocation.Parent!!.Parent is not InvocationExpressionSyntax whereInvocation ||
                !whereInvocation
                .ArgumentList
                .Arguments
                .Any(
                (argument ArgumentSyntax) -> argument
                    .Expression
                    .DescendantNodesAndSelf()
                    .OfType[MemberAccessExpressionSyntax]()
                    .Any(
                    (access MemberAccessExpressionSyntax) -> access
                        .Name
                        .Identifier
                        .Text == "MethodKind" &&
                        (
                        this
                            .context
                            .GetSymbolInfo(access)
                            .Symbol is IPropertySymbol and
                            {ContainingType: {Name: "IMethodSymbol"}}
                    )
                )
            ) {
                return false
            }
            this.context.Report(
                TranslationDiagnostic(
                    "analyzer-api",
                    "TypeSymbol.GetMembers() constructor-form query augmented with TypeSymbol.GetConstructors(): G# keeps constructors outside ordinary member enumeration.",
                    invocation.GetLocation(),
                    TranslationSeverity.Warning
                ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
            )
            let translatedReceiver GExpression? = this.TranslateExpression(receiver)
            let members GExpression = InvocationExpression(
                MemberAccessExpression(translatedReceiver, "GetMembers", isArrow: false)
            )
            let constructors GExpression = InvocationExpression(
                MemberAccessExpression(this.TranslateExpression(receiver), "GetConstructors", isArrow: false)
            )
            result = InvocationExpression(
                MemberAccessExpression(members, "Concat", isArrow: false),
                []GExpression{constructors}
            )
            return true
        }

        /// Shared implementation behind I3a: `.GetLocation()`/`.Span` on a
        /// null-conditional hop, or on `<hop>.Expression`, translated to the
        /// Roslyn-exact span computed by `NullConditionalChain` instead of the
        /// (narrower or differently-anchored) G# node's own natural span (issue #4173, Q2).
        /// @param target The receiver of the `.GetLocation()`/`.Span` read.
        /// @param asLocation True for `.GetLocation()` (wrap in a `TextLocation`); false for `.Span`.
        /// @param result The rewritten expression.
        /// @returns True when this hook handled the read.
        private func TryTranslateAnalyzerNullConditionalSpanRead(
            target ExpressionSyntax,
            asLocation bool,
            out result GExpression?
        ) bool {
            result = nil
            var translatedHop GExpression?
            var spanMethodName string
            if this
                .context
                .GetTypeInfo(target)
                .Type is INamedTypeSymbol directHopType &&
                RoslynTypeMetadataName(
                directHopType
            ) == "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax" {
                translatedHop = this.TranslateExpression(target)
                spanMethodName = "HopSpan"
            } else if target is MemberAccessExpressionSyntax{
                Name: {Identifier: {Text: "Expression"}}
            } expressionAccess &&
                this
                .context
                .GetTypeInfo(expressionAccess.Expression)
                .Type is INamedTypeSymbol receiverHopType &&
                RoslynTypeMetadataName(
                receiverHopType
            ) == "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax" {
                translatedHop = this.TranslateExpression(expressionAccess.Expression)
                spanMethodName = "ReceiverSpan"
            } else {
                return false
            }
            const ShapeNote = "'.GetLocation()'/'.Span' on a null-conditional-access node (or its '.Expression' receiver) translated to the " +
                "Roslyn-exact span computed by NullConditionalChain, rather than the differently-anchored G# node's own " +
                "natural span (issue #4173)."
            this.context.Report(
                TranslationDiagnostic("analyzer-api", ShapeNote, target.GetLocation(), TranslationSeverity.Warning){
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE"
                }
            )
            let spanCall = this.InvokeNullConditionalChain(spanMethodName, translatedHop)
            if !asLocation {
                result = spanCall
                return true
            }
            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Text")
            result = InvocationExpression(
                IdentifierExpression("TextLocation"),
                List[GExpression]{
                    MemberAccessExpression(
                        MemberAccessExpression(translatedHop, "SyntaxTree", isArrow: false),
                        "Text",
                        isArrow: false
                    ),
                    spanCall
                }
            )
            return true
        }

        /// Rewrites `<seq>.OfType<ConditionalAccessExpressionSyntax>()` (issue
        /// #4173, I8): without this, I7's deliberately non-discriminating
        /// `ConditionalAccessExpressionSyntax` → `ExpressionSyntax` type-map row would
        /// let the naive translation of `OfType<ExpressionSyntax>()` silently match
        /// every ordinary access too.
        private func TryTranslateAnalyzerConditionalAccessOfTypeWalk(
            invocation InvocationExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            if this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is not IMethodSymbol{Name: "OfType", TypeArguments: {Length: 1}} method ||
                RoslynTypeMetadataName(
                method.TypeArguments[0] as INamedTypeSymbol
            ) != "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax" ||
                !(
                invocation.Expression is MemberAccessExpressionSyntax{Expression: ExpressionSyntax sequenceReceiver}
            ) {
                return false
            }
            const ShapeNote = "'OfType<ConditionalAccessExpressionSyntax>()' translated to " +
                "'OfType<ExpressionSyntax>().Where(n -> NullConditionalChain.IsNullConditionalHop(n))': G#'s ExpressionSyntax " +
                "is the non-discriminating supertype for a null-conditional hop, so the OfType<>() filter must be re-narrowed " +
                "explicitly (issue #4173)."
            this.context.Report(
                TranslationDiagnostic("analyzer-api", ShapeNote, invocation.GetLocation(), TranslationSeverity.Warning){
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE"
                }
            )
            let ofTypeCall GExpression = InvocationExpression(
                MemberAccessExpression(this.TranslateExpression(sequenceReceiver), "OfType", isArrow: false),
                typeArguments: []NamedTypeReference{NamedTypeReference("ExpressionSyntax")}
            )
            let parameter = Parameter("n", NamedTypeReference("ExpressionSyntax"))
            let predicate = this.InvokeNullConditionalChain("IsNullConditionalHop", IdentifierExpression("n"))
            result = InvocationExpression(
                MemberAccessExpression(ofTypeCall, "Where", isArrow: false),
                []LambdaExpression{LambdaExpression([]Parameter{parameter}, expressionBody: predicate)}
            )
            return true
        }

        /// Rewrites `<node>.FirstAncestorOrSelf<ConditionalAccessExpressionSyntax>()`
        /// (issue #4173, I8): mirrors (cref:TryTranslateAnalyzerConditionalAccessOfTypeWalk)
        /// for the ancestor-walk idiom — G# has no single type for a null-conditional hop, so the
        /// generic `FirstAncestorOrSelf<T>()` is replaced by an explicit self-or-ancestors
        /// scan filtered by `NullConditionalChain.IsNullConditionalHop`.
        private func TryTranslateAnalyzerConditionalAccessAncestorWalk(
            invocation InvocationExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            if this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is not IMethodSymbol{Name: "FirstAncestorOrSelf", TypeArguments: {Length: 1}} method ||
                RoslynTypeMetadataName(
                method.TypeArguments[0] as INamedTypeSymbol
            ) != "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax" ||
                !(invocation.Expression is MemberAccessExpressionSyntax{Expression: ExpressionSyntax nodeReceiver}) {
                return false
            }
            const ShapeNote = "'FirstAncestorOrSelf<ConditionalAccessExpressionSyntax>()' translated to a self-or-ancestors scan filtered by " +
                "'NullConditionalChain.IsNullConditionalHop': G# has no single type for a null-conditional hop to pass as a " +
                "type argument (issue #4173)."
            this.context.Report(
                TranslationDiagnostic("analyzer-api", ShapeNote, invocation.GetLocation(), TranslationSeverity.Warning){
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE"
                }
            )
            let translatedNode GExpression? = this.TranslateExpression(nodeReceiver)
            let selfCheck = this.InvokeNullConditionalChain("IsNullConditionalHop", translatedNode)
            let ancestorParameter = Parameter("candidate", NamedTypeReference("SyntaxNode"))
            let ancestorPredicate = this.InvokeNullConditionalChain(
                "IsNullConditionalHop",
                IdentifierExpression("candidate")
            )
            let ancestorsCall GExpression = InvocationExpression(
                MemberAccessExpression(translatedNode, "Ancestors", isArrow: false)
            )
            let firstAncestorMatch GExpression = InvocationExpression(
                MemberAccessExpression(ancestorsCall, "FirstOrDefault", isArrow: false),
                List[GExpression]{LambdaExpression([]Parameter{ancestorParameter}, expressionBody: ancestorPredicate)}
            )
            result = IfExpression(selfCheck, translatedNode, firstAncestorMatch)
            return true
        }

        /// Invocation-level analyzer idioms: Roslyn methods whose G#
        /// counterpart is not a same-shaped method (e.g.
        /// `node.GetLocation()` → the `Location` property).
        private func TryTranslateAnalyzerInvocation(
            invocation InvocationExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            if this.TryTranslateAnalyzerDesignationWalk(invocation, out result) ||
                this.TryTranslateAnalyzerConstructionForms(invocation, out result) ||
                this.TryTranslateAnalyzerConditionalAccessOfTypeWalk(invocation, out result) ||
                this.TryTranslateAnalyzerConditionalAccessAncestorWalk(invocation, out result) {
                return true
            }
            if (invocation.Expression is IdentifierNameSyntax and {Identifier: {Text: "TypeNameOf"}}) &&
                invocation
                .ArgumentList
                .Arguments
                .Count == 1 &&
                invocation
                .ArgumentList
                .Arguments[0]
                .Expression is MemberAccessExpressionSyntax typeAccess &&
                typeAccess
                .Name
                .Identifier
                .Text == "Type" &&
                typeAccess.Expression is ExpressionSyntax creation &&
                (
                this
                    .context
                    .GetSymbolInfo(typeAccess)
                    .Symbol is IPropertySymbol and
                    {Name: "Type", ContainingType: {Name: "ObjectCreationExpressionSyntax"}}
            ) {
                result = MemberAccessExpression(
                    MemberAccessExpression(this.TranslateExpression(creation), "Identifier", isArrow: false),
                    "Text",
                    isArrow: false
                )
                return true
            }
            if this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is not IMethodSymbol method ||
                !RoslynAnalyzerApiMap.IsRoslynNamespace(method.ContainingType?.ContainingNamespace?.ToDisplayString()) {
                return false
            }
            if method.Name == "RegisterOperationAction" &&
                invocation.Expression is MemberAccessExpressionSyntax registrationReceiver &&
                this.TryExpandOperationKindRegistration(invocation, registrationReceiver, out result) {
                return true
            }
            if method.Name == "RegisterSyntaxNodeAction" &&
                invocation.Expression is MemberAccessExpressionSyntax syntaxRegistrationReceiver &&
                this.TryGuardConditionalAccessRegistration(invocation, syntaxRegistrationReceiver, out result) {
                return true
            }
            if method.Name == "GetLocation" &&
                method
                .Parameters
                .Length == 0 &&
                invocation.Expression is MemberAccessExpressionSyntax locationReceiver {
                if this.TryTranslateAnalyzerNullConditionalSpanRead(
                    locationReceiver.Expression,
                    asLocation: true,
                    out result
                ) {
                    return true
                }
                // `node.GetLocation()` dereferences `node`, so its receiver
                // takes the ordinary receiver forgiveness (issue #4356): a
                // receiver whose G# counterpart is `T?` (`operation.Syntax`,
                // BoundNode.Syntax) needs the same `!!` a `.Location` read
                // written by hand would.
                result = MemberAccessExpression(
                    this.TranslateReceiverWithNullForgiveness(locationReceiver.Expression),
                    "Location",
                    isArrow: false
                )
                return true
            }
            if method.Name == "GetSyntax" &&
                RoslynTypeMetadataName(method.ContainingType) == "Microsoft.CodeAnalysis.SyntaxReference" &&
                invocation.Expression is MemberAccessExpressionSyntax syntaxReferenceReceiver {
                // SyntaxReference.GetSyntax() drops: DeclaringSyntaxNodes
                // already holds the syntax nodes.
                result = this.TranslateExpression(syntaxReferenceReceiver.Expression)
                return true
            }
            if method.Name == "Any" &&
                invocation
                .ArgumentList
                .Arguments
                .Count == 1 &&
                invocation.Expression is MemberAccessExpressionSyntax anyReceiver &&
                anyReceiver.Expression is MemberAccessExpressionSyntax{
                Name: {Identifier: {Text: "Modifiers"}}
            } modifiersReceiver &&
                this
                .context
                .GetSymbolInfo(modifiersReceiver)
                .Symbol is IPropertySymbol{Name: "Modifiers"} modifiersProperty &&
                RoslynAnalyzerApiMap.IsRoslynNamespace(
                modifiersProperty.ContainingType?.ContainingNamespace?.ToDisplayString()
            ) &&
                invocation
                .ArgumentList
                .Arguments[0]
                .Expression is MemberAccessExpressionSyntax overrideKeywordArgument &&
                this
                .context
                .GetSymbolInfo(overrideKeywordArgument)
                .Symbol is IFieldSymbol{Name: "OverrideKeyword"} overrideKeywordField &&
                RoslynTypeMetadataName(
                overrideKeywordField.ContainingType
            ) == "Microsoft.CodeAnalysis.CSharp.SyntaxKind" {
                // declaration.Modifiers.Any(SyntaxKind.OverrideKeyword) -> G#'s
                // FunctionDeclarationSyntax.IsOverride: there is no modifier
                // token list, only discrete typed modifier properties.
                this.context.Report(
                    TranslationDiagnostic(
                        "analyzer-api",
                        "'Modifiers.Any(SyntaxKind.OverrideKeyword)' translated as 'IsOverride': G# has no modifier token list, only discrete typed modifier properties.",
                        invocation.GetLocation(),
                        TranslationSeverity.Warning
                    ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
                )
                result = MemberAccessExpression(
                    this.TranslateExpression(modifiersReceiver.Expression),
                    "IsOverride",
                    isArrow: false
                )
                return true
            }
            if method.Name == "ToDisplayString" &&
                invocation
                .ArgumentList
                .Arguments
                .Count == 0 &&
                (
                RoslynTypeMetadataName(method.ContainingType) is "Microsoft.CodeAnalysis.INamespaceSymbol" or
                    "Microsoft.CodeAnalysis.ISymbol"
            ) &&
                this
                .context
                .GetTypeInfo(
                if invocation.Expression is MemberAccessExpressionSyntax r {
                    r.Expression
                } else {
                    invocation.Expression
                }
            )
                .Type is INamedTypeSymbol receiverType &&
                RoslynTypeMetadataName(receiverType) == "Microsoft.CodeAnalysis.INamespaceSymbol" &&
                invocation.Expression is MemberAccessExpressionSyntax displayReceiver {
                // INamespaceSymbol.ToDisplayString() drops: G#'s
                // ContainingNamespace already is the display string.
                result = this.TranslateExpression(displayReceiver.Expression)
                return true
            }
            return false
        }

        /// Expands `RegisterOperationAction(handler, OperationKind.X, …)`
        /// into a `RegisterBoundNodeAction` naming EVERY G# bound-node
        /// kind that operation reaches (issue #3920).
        /// @remarks Roslyn has one operation kind where G# has several bound nodes:
        /// `a == b` binds to `BoundBinaryExpression` for a built-in
        /// operator and to `BoundClrBinaryOperatorExpression` when it
        /// resolves to an operator method, and a call binds to one of three
        /// nodes by callee provenance. Registering only the kind the
        /// (cref:RoslynAnalyzerApiMap) enum rename names dispatched the
        /// migrated GSA0002 zero times over reflection `Type`
        /// comparisons — whose operands are imported by construction — so the
        /// rule reported nothing at all rather than reporting wrongly.
        /// @param invocation The registration call.
        /// @param receiver Its member-access callee.
        /// @param result The expanded registration.
        /// @returns True when at least one argument kind fanned out.
        private func TryExpandOperationKindRegistration(
            invocation InvocationExpressionSyntax,
            receiver MemberAccessExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            let arguments = List[GExpression]()
            var expanded = false
            var unexpandable = false
            let guardedKinds = List[string]()
            var handlerIndex = -1
            for argument in invocation.ArgumentList.Arguments {
                if argument.Expression is MemberAccessExpressionSyntax kindAccess &&
                    this
                    .context
                    .GetSymbolInfo(kindAccess)
                    .Symbol is IFieldSymbol kindField &&
                    RoslynTypeMetadataName(kindField.ContainingType) == "Microsoft.CodeAnalysis.OperationKind" &&
                    RoslynAnalyzerApiMap
                    .TryMapOperationKindDispatch(kindField.Name, out var boundNodeKinds) {
                    expanded = true
                    if (kindField.Name is "IsType" or "PropertyReference" or "MethodReference") {
                        guardedKinds.Add(kindField.Name)
                    }
                    for boundNodeKind in boundNodeKinds {
                        arguments.Add(
                            MemberAccessExpression(IdentifierExpression("BoundNodeKind"), boundNodeKind, isArrow: false)
                        )
                    }
                    continue
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
                if BindsToOperationKindsParameter(argument, this.context) {
                    if !IsDirectOperationKindAccess(argument.Expression, this.context) {
                        unexpandable = true
                    }
                } else {
                    handlerIndex = arguments.Count
                }
                arguments.Add(this.TranslateExpression(argument.Expression)!!)
            }
            if unexpandable {
                const GapNote = "'RegisterOperationAction' names its operation kinds indirectly, so cs2gs cannot expand them to " +
                    "the several G# bound-node kinds each Roslyn operation reaches (issue #3920). Spell the kinds " +
                    "as direct 'OperationKind.X' arguments at the registration call."
                this.context.Report(
                    TranslationDiagnostic(
                        "analyzer-api",
                        GapNote,
                        invocation.GetLocation(),
                        TranslationSeverity.Unsupported
                    ){DiagnosticId = "CS2GS-GAP"}
                )
                return false
            }
            if !expanded {
                return false
            }
            const ShapeNote = "'RegisterOperationAction' expanded to every G# bound-node kind the operation reaches: " +
                "G# binds one Roslyn operation kind to several nodes by operator/callee provenance."
            this.context.Report(
                TranslationDiagnostic("analyzer-api", ShapeNote, invocation.GetLocation(), TranslationSeverity.Warning){
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE"
                }
            )
            if guardedKinds.Count > 0 && handlerIndex >= 0 {
                arguments[handlerIndex] = this.GuardOperationHandler(arguments[handlerIndex], guardedKinds, invocation)
                const GuardNote = "'RegisterOperationAction' registered as a wrapper lambda that drops the nodes G# shares with another Roslyn " +
                    "operation: a pattern 'is' (Roslyn's IsPattern) for IsType, an imported field read (Roslyn's " +
                    "FieldReference) for PropertyReference, and an empty method group for MethodReference."
                this.context.Report(
                    TranslationDiagnostic(
                        "analyzer-api",
                        GuardNote,
                        invocation.GetLocation(),
                        TranslationSeverity.Warning
                    ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
                )
            }
            result = InvocationExpression(
                MemberAccessExpression(
                    this.TranslateExpression(receiver.Expression),
                    "RegisterBoundNodeAction",
                    isArrow: false
                ),
                arguments
            )
            return true
        }

        /// Issue #4436: wraps a handler registered for an operation kind whose
        /// G# node also carries a form Roslyn sends elsewhere, so the handler
        /// never sees that form. Each form shows as a nil member Roslyn
        /// declares non-null, which a handler written against Roslyn would
        /// dereference:
        /// - `IsType`: a declaration or recursive pattern `is` (Roslyn's `IIsPatternOperation`) has a nil
        /// `BoundIsExpression.TypeOperand`;
        /// - `PropertyReference`: an imported field read (Roslyn's `IFieldReferenceOperation`) has a nil
        /// `Property`;
        /// - `MethodReference`: an empty method group has a nil `Method`.
        /// The guard rejects only those nodes, so it composes with any other
        /// kinds named in the same registration.
        /// @param handler The translated handler.
        /// @param guardedKinds The guarded Roslyn kinds the registration names.
        /// @param site The registration site that owns the synthesized wrapper parameter.
        /// @returns The guarded wrapper lambda.
        private func GuardOperationHandler(
            handler GExpression,
            guardedKinds List[string],
            site SyntaxNode
        ) GExpression {
            let contextName = this.AllocateSynthesizedLocalName("ctx", site)
            let context GExpression = IdentifierExpression(contextName)
            let ctxNode GExpression = MemberAccessExpression(context, "BoundNode", isArrow: false)
            var rejected GExpression? = nil
            for kind in guardedKinds {
                let (type, member) = switch kind {
                    case "IsType": ("BoundIsExpression", "TypeOperand")
                    case "PropertyReference": ("BoundPropertyReferenceOperationExpression", "ReferencedProperty")
                    default: ("BoundMethodReferenceOperationExpression", "Method")
                }
                let test GExpression = PatternTestExpression(
                    ctxNode,
                    TypePattern(
                        "_",
                        NamedTypeReference(type),
                        PropertyPattern(
                            List[PropertyPatternField]{
                                PropertyPatternField(member, ConstantPattern(LiteralExpression.Null()))
                            }
                        ),
                        designationAfterType: true
                    )
                )
                rejected = if rejected == nil {
                    test
                } else {
                    cast[GExpression](BinaryExpression(rejected, "||", test))
                }
            }
            let handlerCall GExpression = InvocationExpression(handler, List[GExpression]{context})
            let body = BlockStatement(
                List[GStatement]{
                    IfStatement(
                        UnaryExpression("!", ParenthesizedExpression(rejected)),
                        BlockStatement(List[GStatement]{ExpressionStatement(handlerCall)})
                    )
                }
            )
            return LambdaExpression(
                List[Parameter]{Parameter(contextName, NamedTypeReference("BoundNodeAnalysisContext"))},
                blockBody: body
            )
        }

        /// Rewrites `RegisterSyntaxNodeAction(handler, SyntaxKind.ConditionalAccessExpression)`
        /// AND its sibling `RegisterSyntaxNodeAction(handler, SyntaxKind.SimpleMemberAccessExpression)`
        /// (issue #4173, I2 + §6). Unlike a type/kind rename, neither guard can live at the
        /// registration call site alone: G# dispatches EVERY `AccessorExpressionSyntax`/
        /// `IndexExpressionSyntax` (null-conditional or not) to a handler registered for that
        /// kind, so the handler must reject the nodes on the OTHER side of `IsNullConditional`
        /// it would otherwise also receive — `ConditionalAccessExpression` must reject the
        /// ordinary ones, and `SimpleMemberAccessExpression` (Roslyn's ordinary `.b`,
        /// which EXCLUDES a `?.` hop's receiverless tail) must reject the null-conditional
        /// ones. Rather than reach into the (separately-translated, order-independent) handler
        /// METHOD BODY, the registration is rewritten to pass a small wrapper lambda that runs
        /// the guard and only then forwards to the original handler — the same effect, entirely
        /// local to this call site. `ConditionalAccessExpression` additionally registers for
        /// `SyntaxKind.IndexExpression` alongside `AccessorExpression`, since Roslyn's
        /// `?.` and `?[` share one outer kind but G# splits them across two node types.
        /// @remarks A registration that combines either of these kinds with any OTHER kind in the same
        /// call is left alone (a loud CS2GS-GAP): the wrapper's guard would apply to every kind
        /// the registration dispatches, wrongly rejecting the other kind(s)' nodes too.
        private func TryGuardConditionalAccessRegistration(
            invocation InvocationExpressionSyntax,
            receiver MemberAccessExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            var handlerArgument ArgumentSyntax? = nil
            let kindArguments = List[ArgumentSyntax]()
            for argument in invocation.ArgumentList.Arguments {
                let parameter IParameterSymbol? = DetermineParameter(argument, this.context)
                let parameterType ITypeSymbol? = if parameter?.IsParams == true {
                    (parameter!!.Type as IArrayTypeSymbol)?.ElementType
                } else {
                    parameter?.Type
                }
                if RoslynTypeMetadataName(
                    parameterType as INamedTypeSymbol
                ) == "Microsoft.CodeAnalysis.CSharp.SyntaxKind" {
                    kindArguments.Add(argument)
                } else {
                    handlerArgument = argument
                }
            }
            let NamesKind = func (kindMemberName string) bool {
                return kindArguments.Any(
                    (argument ArgumentSyntax) -> argument.Expression is MemberAccessExpressionSyntax kindAccess &&
                        this
                        .context
                        .GetSymbolInfo(kindAccess)
                        .Symbol is IFieldSymbol kindField &&
                        kindField.Name == kindMemberName &&
                        RoslynTypeMetadataName(kindField.ContainingType) == "Microsoft.CodeAnalysis.CSharp.SyntaxKind"
                )
            }
            let namesConditionalAccess = NamesKind("ConditionalAccessExpression")
            let namesSimpleMemberAccess = NamesKind("SimpleMemberAccessExpression")
            if (!namesConditionalAccess && !namesSimpleMemberAccess) || handlerArgument == nil {
                return false
            }
            if kindArguments.Count != 1 {
                const GapNote = "'RegisterSyntaxNodeAction' combines SyntaxKind.ConditionalAccessExpression and/or " +
                    "SyntaxKind.SimpleMemberAccessExpression with another kind in the same call: G# dispatches every " +
                    "AccessorExpressionSyntax/IndexExpressionSyntax (null-conditional or not) to a handler registered for " +
                    "that kind, so the IsNullConditional-discriminating guard either of these needs would also wrongly " +
                    "reject the other kind(s)' nodes. Split into a separate RegisterSyntaxNodeAction call naming only the " +
                    "kind that needs the guard."
                this.context.Report(
                    TranslationDiagnostic(
                        "analyzer-api",
                        GapNote,
                        invocation.GetLocation(),
                        TranslationSeverity.Unsupported
                    ){DiagnosticId = "CS2GS-GAP"}
                )
                return false
            }
            // Exactly one of the two, since kindArguments.Count == 1 here.
            let guardsNullConditional = namesConditionalAccess
            let shapeNote = if guardsNullConditional {
                "'RegisterSyntaxNodeAction(handler, SyntaxKind.ConditionalAccessExpression)' translated to a wrapper lambda " +
                    "registered for SyntaxKind.AccessorExpression and SyntaxKind.IndexExpression that only forwards to the " +
                    "handler when 'NullConditionalChain.IsNullConditionalHop(ctx.Node)': G# dispatches every accessor/index " +
                    "node (a.b/a[i] as well as a?.b/a?[i]) to those kinds, and the handler must reject the ordinary ones."
            } else {
                "'RegisterSyntaxNodeAction(handler, SyntaxKind.SimpleMemberAccessExpression)' translated to a wrapper lambda " +
                    "registered for SyntaxKind.AccessorExpression that only forwards to the handler when " +
                    "'ctx.Node is AccessorExpressionSyntax { IsNullConditional: false }': G# dispatches every accessor node " +
                    "(a.b as well as a?.b) to that kind, and Roslyn's own MemberAccessExpressionSyntax excludes a ?. hop's " +
                    "receiverless tail, so the handler must reject the null-conditional ones (issue #4173 §6)."
            }
            this.context.Report(
                TranslationDiagnostic("analyzer-api", shapeNote, invocation.GetLocation(), TranslationSeverity.Warning){
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE"
                }
            )
            let contextName = this.AllocateSynthesizedLocalName("ctx", invocation)
            let contextParameter = Parameter(contextName, NamedTypeReference("SyntaxNodeAnalysisContext"))
            let context GExpression = IdentifierExpression(contextName)
            let ctxNode GExpression = MemberAccessExpression(context, "Node", isArrow: false)
            let guardTest = if guardsNullConditional {
                this.InvokeNullConditionalChain("IsNullConditionalHop", ctxNode)
            } else {
                cast[GExpression](
                    PatternTestExpression(
                        ctxNode,
                        TypePattern(
                            "_",
                            NamedTypeReference("AccessorExpressionSyntax"),
                            PropertyPattern(
                                List[PropertyPatternField]{
                                    PropertyPatternField(
                                        "IsNullConditional",
                                        ConstantPattern(LiteralExpression.Bool(false))
                                    )
                                }
                            ),
                            designationAfterType: true
                        )
                    )
                )
            }
            let handlerCall GExpression = InvocationExpression(
                this.TranslateExpression(handlerArgument.Expression),
                List[GExpression]{context}
            )
            let guardedBody = BlockStatement(
                List[GStatement]{
                    IfStatement(guardTest, BlockStatement(List[GStatement]{ExpressionStatement(handlerCall)}))
                }
            )
            let wrapperLambda = LambdaExpression(List[Parameter]{contextParameter}, blockBody: guardedBody)
            let registeredKinds = List[GExpression]{
                MemberAccessExpression(IdentifierExpression("SyntaxKind"), "AccessorExpression", isArrow: false)
            }
            if guardsNullConditional {
                registeredKinds.Add(
                    MemberAccessExpression(IdentifierExpression("SyntaxKind"), "IndexExpression", isArrow: false)
                )
            }
            result = InvocationExpression(
                MemberAccessExpression(
                    this.TranslateExpression(receiver.Expression),
                    "RegisterSyntaxNodeAction",
                    isArrow: false
                ),
                List[GExpression]{wrapperLambda}.Concat(registeredKinds).ToList()
            )
            return true
        }

        /// The two members a migrated analyzer reaches through
        /// `IInvocationOperation.TargetMethod` that the callee SYMBOL
        /// cannot answer honestly (PR #3968 review).
        /// @remarks `ReturnType` is answered by the call NODE. G#'s callee symbol
        /// carries the declaration's return type, so a constructed generic call
        /// reports the type parameter — measured directly: an analyzer over
        /// `Identity[int32](1)` saw `symbol=T` against
        /// `node=global::System.Int32`. Roslyn's `TargetMethod` is the
        /// CONSTRUCTED method, so the node's type is the faithful reading, and
        /// it is right for the imported-generic case too without consulting a
        /// reflected placeholder.
        ///
        /// `OverriddenMethod` has no honest answer at a call site: an
        /// imported callee has no G# override chain, so any value would be null
        /// for every call into metadata. It is reported as a gap rather than
        /// answered — a member analyzers branch on must not silently say "no".
        /// @param member The member access.
        /// @param result The rewritten expression.
        /// @returns True when this hook handled the access.
        private func TryTranslateCalleeSurfaceMember(
            member MemberAccessExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            let name = member.Name.Identifier.Text
            if !((name == "ReturnType" || name == "OverriddenMethod")) ||
                member.Expression is not MemberAccessExpressionSyntax{
                Name: {Identifier: {Text: "TargetMethod"}}
            } targetMethod ||
                this
                .context
                .GetSymbolInfo(targetMethod)
                .Symbol is not IPropertySymbol{Name: "TargetMethod"} property ||
                RoslynTypeMetadataName(
                property.ContainingType
            ) != "Microsoft.CodeAnalysis.Operations.IInvocationOperation" {
                return false
            }
            if name == "OverriddenMethod" {
                const GapNote = "'TargetMethod.OverriddenMethod' has no G# counterpart at a call site: an imported callee " +
                    "carries no override chain, so every call into metadata would read null. Rewrite the rule " +
                    "against the declaring symbol, where FunctionSymbol.OverriddenMethod is meaningful."
                this.context.Report(
                    TranslationDiagnostic(
                        "analyzer-api",
                        GapNote,
                        member.GetLocation(),
                        TranslationSeverity.Unsupported
                    ){DiagnosticId = "CS2GS-GAP"}
                )
                return false
            }
            const ShapeNote = "'TargetMethod.ReturnType' translated as the call node's own type: G#'s callee symbol carries " +
                "the DECLARATION's return type, so a constructed generic call would report the type parameter."
            this.context.Report(
                TranslationDiagnostic("analyzer-api", ShapeNote, member.GetLocation(), TranslationSeverity.Warning){
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE"
                }
            )
            result = MemberAccessExpression(this.TranslateExpression(targetMethod.Expression), "Type", isArrow: false)
            return true
        }

        private func TryTranslateAnalyzerTypeNameSwitch(node SwitchExpressionSyntax, out result GExpression?) bool {
            result = nil
            if !(node.GoverningExpression is IdentifierNameSyntax{Identifier: {Text: {} parameterName}}) ||
                node
                .Arms
                .Count != 4 ||
                node
                .Arms[0]
                .Pattern is not DeclarationPatternSyntax first ||
                first.Type is not(IdentifierNameSyntax and {Identifier: {Text: "IdentifierNameSyntax"}}) ||
                node
                .Arms[1]
                .Pattern is not DeclarationPatternSyntax second ||
                second.Type is not(IdentifierNameSyntax and {Identifier: {Text: "QualifiedNameSyntax"}}) ||
                node
                .Arms[2]
                .Pattern is not DeclarationPatternSyntax third ||
                third.Type is not(IdentifierNameSyntax and {Identifier: {Text: "GenericNameSyntax"}}) ||
                !(node.Arms[3].Pattern is DiscardPatternSyntax) {
                return false
            }
            this.context.Report(
                TranslationDiagnostic(
                    "analyzer-api",
                    "Roslyn simple/qualified/generic TypeSyntax name switch translated to TypeClauseSyntax.NameIdentifier: G# represents all named type clauses in one node.",
                    node.GetLocation(),
                    TranslationSeverity.Warning
                ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
            )
            let nameIdentifier GExpression = MemberAccessExpression(
                IdentifierExpression(parameterName),
                "NameIdentifier",
                isArrow: false
            )
            result = IfExpression(
                BinaryExpression(nameIdentifier, "!=", LiteralExpression.Null()),
                MemberAccessExpression(NonNullAssertionExpression(nameIdentifier), "Text", isArrow: false),
                LiteralExpression.Null()
            )
            return true
        }

        private func TranslateAnalyzerPatternFieldName(
            recursive RecursivePatternSyntax?,
            subpattern SubpatternSyntax,
            fieldName string?
        ) string? {
            if !this.InAnalyzerApiMode ||
                fieldName != "Expression" ||
                recursive!!.Type is not IdentifierNameSyntax invocationType ||
                invocationType
                .Identifier
                .Text != "InvocationExpressionSyntax" ||
                this.GetPatternMemberSymbol(subpattern.NameColon?.Name) is not IPropertySymbol property ||
                RoslynTypeMetadataName(
                property.ContainingType
            ) != "Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax" {
                return fieldName
            }
            this.context.Report(
                TranslationDiagnostic(
                    "analyzer-api",
                    "InvocationExpressionSyntax.Expression property pattern translated to CallExpressionSyntax.Parent.",
                    subpattern.GetLocation(),
                    TranslationSeverity.Warning
                ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
            )
            return "Parent"
        }

        /// Rewrites `namespaceSymbol?.ToDisplayString()` to the bare
        /// receiver: G#'s `ContainingNamespace` is already the (nullable)
        /// display string.
        private func TryTranslateAnalyzerConditionalDisplay(
            conditionalAccess ConditionalAccessExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            if (
                conditionalAccess.WhenNotNull is MemberBindingExpressionSyntax and {Name: {Identifier: {Text: "Value"}}}
            ) &&
                this
                .context
                .GetTypeInfo(conditionalAccess.Expression)
                .Type is INamedTypeSymbol initializerType &&
                RoslynTypeMetadataName(
                initializerType
            ) == "Microsoft.CodeAnalysis.CSharp.Syntax.EqualsValueClauseSyntax" {
                this.context.Report(
                    TranslationDiagnostic(
                        "analyzer-api",
                        "EqualsValueClauseSyntax.Value wrapper dropped: G# VariableDeclarationSyntax exposes Initializer directly.",
                        conditionalAccess.GetLocation(),
                        TranslationSeverity.Warning
                    ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
                )
                result = this.TranslateExpression(conditionalAccess.Expression)
                return true
            }
            if conditionalAccess.WhenNotNull is not(
                InvocationExpressionSyntax and
                    {
                    Expression: MemberBindingExpressionSyntax and {Name: {Identifier: {Text: "ToDisplayString"}}},
                    ArgumentList: {Arguments: {Count: 0}}
                }
            ) ||
                this
                .context
                .GetTypeInfo(conditionalAccess.Expression)
                .Type is not INamedTypeSymbol receiverType ||
                RoslynTypeMetadataName(receiverType) != "Microsoft.CodeAnalysis.INamespaceSymbol" {
                return false
            }
            result = this.TranslateExpression(conditionalAccess.Expression)
            return true
        }

        /// Rewrites the Roslyn location-picking ternary
        /// (`symbol.Locations.Length > 0 ? symbol.Locations[0] : null`)
        /// to G#'s `Symbol.Location`, which is a struct and cannot be
        /// null-defaulted.
        private func TryTranslateAnalyzerLocationsTernary(
            conditional ConditionalExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            if conditional.WhenFalse is not LiteralExpressionSyntax whenFalse || !whenFalse.IsKind(
                SyntaxKind.NullLiteralExpression
            ) ||
                !(
                conditional.WhenTrue is ElementAccessExpressionSyntax{
                    Expression: MemberAccessExpressionSyntax{Name: {Identifier: {Text: "Locations"}}} locationsAccess
                }
            ) ||
                this
                .context
                .GetSymbolInfo(locationsAccess)
                .Symbol is not IPropertySymbol{Name: "Locations"} locations ||
                !RoslynAnalyzerApiMap.IsRoslynNamespace(
                locations.ContainingType?.ContainingNamespace?.ToDisplayString()
            ) {
                return false
            }
            // `symbol.Locations` dereferences `symbol`: ordinary receiver
            // forgiveness, as for any member read (issue #4356).
            result = MemberAccessExpression(
                this.TranslateReceiverWithNullForgiveness(locationsAccess.Expression),
                "Location",
                isArrow: false
            )
            return true
        }

        /// Rewrites the C# assignment-LHS idiom
        /// (`X.Parent is AssignmentExpressionSyntax a && a.Left == X`)
        /// to the faithful G# form: an expression is a write target exactly
        /// when its parent is one of the dedicated write nodes that embed it
        /// (`MemberIndexAssignmentExpression`,
        /// `CompoundIndexAssignmentExpression`,
        /// `MemberFieldAssignmentExpression`). G#'s plain
        /// `AssignmentExpression` targets an identifier token, so the
        /// literal translation would be constantly false and, worse, miss the
        /// embedded-target write forms (found by the ADR-0169 parity harness).
        private func TryLowerAssignmentLeftConjunction(binary BinaryExpressionSyntax, out result GExpression?) bool {
            result = nil
            if !binary.IsKind(SyntaxKind.LogicalAndExpression) ||
                !(
                binary.Left is IsPatternExpressionSyntax{
                    Expression: {} parentExpression,
                    Pattern: DeclarationPatternSyntax{
                        Designation: SingleVariableDesignationSyntax designation
                    } declarationPattern
                }
            ) ||
                binary.Right is not BinaryExpressionSyntax comparison ||
                !comparison.IsKind(SyntaxKind.EqualsExpression) {
                return false
            }
            if this
                .context
                .GetTypeInfo(declarationPattern.Type)
                .Type is not INamedTypeSymbol patternType ||
                RoslynTypeMetadataName(
                patternType
            ) != "Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax" {
                return false
            }
            let ComparesDesignationLeft = func (operand ExpressionSyntax) bool {
                return operand is MemberAccessExpressionSyntax{
                    Expression: IdentifierNameSyntax receiver,
                    Name: {Identifier: {Text: "Left"}}
                } &&
                    receiver
                    .Identifier
                    .Text == designation
                    .Identifier
                    .Text
            }
            if !ComparesDesignationLeft(comparison.Left) && !ComparesDesignationLeft(comparison.Right) {
                return false
            }
            const adaptationNote = "Assignment-LHS idiom rewritten to a write-node parent-kind check: in G#, index/member writes are dedicated " +
                "Member/CompoundIndexAssignment and MemberFieldAssignment nodes that embed their target expression."
            this.context.Report(
                TranslationDiagnostic(
                    "analyzer-api",
                    adaptationNote,
                    binary.GetLocation(),
                    TranslationSeverity.Warning
                ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
            )
            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Syntax")
            // Issue #4356: the C# is a pattern TEST on `X.Parent` — a nil parent
            // simply fails `is AssignmentExpressionSyntax a` — never a
            // dereference of it. So the synthesized `.Kind` read is
            // null-conditional (`X.Parent?.Kind == SyntaxKind.…`, false for a
            // nil parent), not the `!!` the ordinary receiver forgiveness would
            // pick for a `T?` receiver like `SyntaxNode.Parent`: asserting would
            // turn "not an assignment target" into a NullReferenceException.
            // The lifted `SyntaxKind?` only feeds `==`, so the `?.` result
            // type is harmless here.
            let parentKind GExpression = ConditionalAccessExpression(
                this.TranslateExpression(parentExpression),
                MemberAccessExpression(ConditionalReceiverExpression(), "Kind", isArrow: false)
            )
            let Test = func (kindName string) GExpression {
                return BinaryExpression(
                    parentKind,
                    "==",
                    MemberAccessExpression(IdentifierExpression("SyntaxKind"), kindName, isArrow: false)
                )
            }
            result = BinaryExpression(
                BinaryExpression(
                    Test("MemberIndexAssignmentExpression"),
                    "||",
                    Test("CompoundIndexAssignmentExpression")
                ),
                "||",
                Test("MemberFieldAssignmentExpression")
            )
            return true
        }

        /// Lowers a comparison against a Roslyn member with no G# counterpart
        /// (currently `AssignmentExpressionSyntax.Left`) to a boolean
        /// constant, with a CS2GS-ANALYZER-SHAPE review warning. In G#, index
        /// and member writes parse as dedicated assignment nodes, so the C#
        /// assignment-LHS check can never be true of a read node.
        private func TryLowerAnalyzerComparison(binary BinaryExpressionSyntax, out result GExpression?) bool {
            result = nil
            let isEquals = binary.IsKind(SyntaxKind.EqualsExpression)
            let isNotEquals = binary.IsKind(SyntaxKind.NotEqualsExpression)
            if !isEquals && !isNotEquals {
                return false
            }
            // x.SpecialType ==/!= SpecialType.System_Y rewrites to a
            // fully-qualified display-string comparison: G# has no SpecialType.
            for (memberSide, enumSide) in[](ExpressionSyntax, ExpressionSyntax){
                (binary.Left, binary.Right),
                (binary.Right, binary.Left)
            } {
                if memberSide is not MemberAccessExpressionSyntax{
                    Name: {Identifier: {Text: "SpecialType"}}
                } specialAccess ||
                    this
                    .context
                    .GetSymbolInfo(specialAccess)
                    .Symbol is not IPropertySymbol{Name: "SpecialType"} specialProperty ||
                    !RoslynAnalyzerApiMap.IsRoslynNamespace(
                    specialProperty.ContainingType?.ContainingNamespace?.ToDisplayString()
                ) ||
                    !(
                    enumSide is MemberAccessExpressionSyntax{Name: {Identifier: {Text: {} specialName}}} enumAccess
                ) ||
                    !specialName.StartsWith("System_", StringComparison.Ordinal) ||
                    this
                    .context
                    .GetSymbolInfo(enumAccess)
                    .Symbol is not(IFieldSymbol and {ContainingType: {Name: "SpecialType"}}) {
                    continue
                }
                this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Symbols")
                // Issue #4287: the synthesized `.ToDisplayString(…)` CALL
                // dereferences `x` exactly as the C# `x.SpecialType` read did,
                // so its receiver takes the same forgiveness as any other
                // dereference. `method.ContainingType` is `T?` on the G#
                // analyzer API, and gsc now rejects an instance call on a stated
                // `T?` receiver (GS0159) as it already rejected a member read.
                result = BinaryExpression(
                    InvocationExpression(
                        MemberAccessExpression(
                            this.TranslateReceiverWithNullForgiveness(specialAccess.Expression),
                            "ToDisplayString",
                            isArrow: false
                        ),
                        List[GExpression]{
                            MemberAccessExpression(
                                IdentifierExpression("DisplayFormat"),
                                "FullyQualified",
                                isArrow: false
                            )
                        }
                    ),
                    if isEquals {
                        "=="
                    } else {
                        "!="
                    },
                    LiteralExpression.String("global::" + specialName.Replace('_', '.'))
                )
                return true
            }
            for (methodSide, kindSide) in[](ExpressionSyntax, ExpressionSyntax){
                (binary.Left, binary.Right),
                (binary.Right, binary.Left)
            } {
                if methodSide is not MemberAccessExpressionSyntax{
                    Name: {Identifier: {Text: "MethodKind"}}
                } methodKindAccess ||
                    this
                    .context
                    .GetSymbolInfo(methodKindAccess)
                    .Symbol is not IPropertySymbol methodKindProperty ||
                    methodKindProperty.Name != "MethodKind" ||
                    methodKindProperty
                    .ContainingType
                    .Name != "IMethodSymbol" ||
                    kindSide is not MemberAccessExpressionSyntax{
                    Name: {Identifier: {Text: "Constructor" or "Ordinary"}}
                } kindAccess ||
                    this
                    .context
                    .GetSymbolInfo(kindAccess)
                    .Symbol is not IFieldSymbol kindField ||
                    kindField
                    .ContainingType
                    .Name != "MethodKind" {
                    continue
                }
                let constructorKind = kindAccess.Name.Identifier.Text == "Constructor"
                let op = if constructorKind == isEquals {
                    "=="
                } else {
                    "!="
                }
                result = BinaryExpression(
                    MemberAccessExpression(
                        this.TranslateReceiverWithNullForgiveness(methodKindAccess.Expression),
                        "Name",
                        isArrow: false
                    ),
                    op,
                    LiteralExpression.String(".ctor")
                )
                this.context.Report(
                    TranslationDiagnostic(
                        "analyzer-api",
                        "MethodKind.${kindAccess.Name.Identifier.Text} comparison translated to the G# constructor callable name '.ctor'.",
                        binary.GetLocation(),
                        TranslationSeverity.Warning
                    ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
                )
                return true
            }
            for operand in[]ExpressionSyntax{binary.Left, binary.Right} {
                if operand is not MemberAccessExpressionSyntax operandAccess ||
                    this
                    .context
                    .GetSymbolInfo(operandAccess)
                    .Symbol is not{} operandSymbol ||
                    operandSymbol.ContainingType is not{} operandContainer {
                    continue
                }
                let containingName string? = RoslynTypeMetadataName(operandContainer)
                if containingName != nil && RoslynAnalyzerApiMap.IsRoslynNamespace(
                    operandContainer.ContainingNamespace?.ToDisplayString()
                ) &&
                    RoslynAnalyzerApiMap.TryMapMember(containingName, operandSymbol.Name, out var entry) &&
                    entry.GsName == nil {
                    this.context.Report(
                        TranslationDiagnostic(
                            "analyzer-api",
                            "Comparison against '$containingName.${operandSymbol.Name}' lowered to '${(if isEquals { "false" } else { "true" })}': ${entry.AdaptationNote}",
                            binary.GetLocation(),
                            TranslationSeverity.Warning
                        ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
                    )
                    result = LiteralExpression.Bool(!isEquals)
                    return true
                }
            }
            return false
        }

        /// Substitutes Roslyn analyzer marker attributes:
        /// `[DiagnosticAnalyzer(LanguageNames.CSharp)]` →
        /// `[GSharpDiagnosticAnalyzer]`, arguments dropped (G# has one
        /// language).
        private func TryTranslateAnalyzerAttribute(attribute AttributeSyntax, out result AttributeUse?) bool {
            result = nil
            if !this.InAnalyzerApiMode {
                return false
            }
            let symbol ISymbol? = this
                .context
                .GetSymbolInfo(attribute)
                .Symbol ??
                this
                .context
                .GetSymbolInfo(attribute.Name)
                .Symbol
            let attributeType INamedTypeSymbol? = switch symbol {
                case constructor is IMethodSymbol: constructor.ContainingType
                case namedType is INamedTypeSymbol: namedType
                default: default(INamedTypeSymbol?)
            }
            if RoslynTypeMetadataName(
                attributeType
            ) != "Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzerAttribute" {
                return false
            }
            this.typeMapper.TrackSubstitutedNamespace("GSharp.Core.CodeAnalysis.Analyzers")
            result = AttributeUse("GSharpDiagnosticAnalyzer", Array.Empty[AttributeArgument](), target: nil)
            return true
        }

        /// Recognizes the entry point of a Roslyn analyzer TEST harness
        /// (ADR-0169 M5, issue #3686): a static method that takes an analyzer
        /// and a source string, i.e. the repo's
        /// `AnalyzerTestHelper.AssertDiagnosticsAsync` shape.
        /// @remarks The harness body is the one place where a statement-by-statement
        /// translation would be WRONG rather than merely hard. It builds a
        /// Roslyn `CSharpCompilation` over metadata references pulled from
        /// `TRUSTED_PLATFORM_ASSEMBLIES` and drives it with Roslyn's
        /// analyzer driver — a pipeline whose G# counterpart takes NO metadata
        /// references at all, so the faithful translation of
        /// `GetReferences()` is deletion, not mapping. Translating each
        /// call in isolation would reimplement, inside the migrated test
        /// project, the marker-stripping and assertion logic that
        /// `GSharpAnalyzerVerifier` already owns and tests. The rewrite
        /// therefore replaces the whole body with a delegation to that
        /// verifier, keeping the harness's own signature — so every call site
        /// in the migrated tests is untouched — and reports the substitution as
        /// a shape adaptation.
        ///
        /// The shape test itself lives on (cref:AnalyzerProjectDetector)
        /// (issue #3789): the presence of a harness is also what decides
        /// whether a project enters analyzer mode at all, and the two must be
        /// one predicate — a project is claimed exactly when there is a harness
        /// here to rewrite.
        /// @param symbol The method being translated.
        /// @returns True when this method is the harness entry point.
        private func IsAnalyzerHarnessEntry(symbol IMethodSymbol?) bool -> this.InAnalyzerApiMode &&
            AnalyzerProjectDetector.IsAnalyzerTestHarnessEntry(symbol)

        /// True when [`method`](paramref) is private plumbing that exists
        /// only to serve the harness entry point rewritten above — so once the
        /// body is a one-line delegation, the member is dead code that would
        /// still drag unmapped Roslyn types (`MetadataReference`) into the
        /// migrated project. Members used from anywhere else are kept.
        /// @param method The candidate support method.
        /// @returns True when the member must not be emitted.
        private func IsAnalyzerHarnessSupportMember(method MethodDeclarationSyntax) bool {
            if !this.InAnalyzerApiMode || this.context.GetDeclaredSymbol(method) is not IMethodSymbol symbol ||
                !symbol.IsStatic ||
                symbol.DeclaredAccessibility != Accessibility.Private ||
                method.Parent is not TypeDeclarationSyntax owner {
                return false
            }
            let entries = owner
                .Members
                .OfType[MethodDeclarationSyntax]()
                .Where(
                (candidate MethodDeclarationSyntax) -> this.context.GetDeclaredSymbol(
                    candidate
                ) is IMethodSymbol candidateSymbol &&
                    this.IsAnalyzerHarnessEntry(candidateSymbol)
            )
                .ToList()
            if entries.Count == 0 {
                return false
            }
            let uses = owner
                .DescendantNodes()
                .OfType[InvocationExpressionSyntax]()
                .Where(
                (invocation InvocationExpressionSyntax) -> SymbolEqualityComparer.Default.Equals(
                    this.context.GetSymbolInfo(invocation).Symbol?.OriginalDefinition,
                    symbol
                )
            )
                .ToList()
            return uses.Count > 0 && uses.All(
                (use InvocationExpressionSyntax) -> entries.Any(
                    (entry MethodDeclarationSyntax) -> entry.Span.Contains(use.Span)
                )
            )
        }

        /// Builds the delegating body for the harness entry point:
        /// `GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, source, ids)`,
        /// followed by `return Task.CompletedTask` when the harness kept
        /// its Task-returning shape (so the migrated `[Fact]` methods,
        /// which `return` the harness call, need no rewrite of their own).
        /// @param symbol The harness method.
        /// @param parameters Its already-mapped G# parameters.
        /// @param site The syntax node to attribute the shape warning to.
        /// @param body The synthesized body.
        /// @returns True when a body was synthesized.
        private func TryBuildAnalyzerHarnessBody(
            symbol IMethodSymbol?,
            parameters IReadOnlyList[Parameter],
            site SyntaxNode,
            out body BlockStatement?
        ) bool {
            body = nil
            if !this.IsAnalyzerHarnessEntry(symbol) || parameters.Count < 2 {
                return false
            }
            this.typeMapper.TrackSubstitutedNamespace(AnalyzerVerifierNamespace)
            let call = InvocationExpression(
                MemberAccessExpression(IdentifierExpression("GSharpAnalyzerVerifier"), "VerifyAnalyzer"),
                parameters.Select((parameter Parameter) -> cast[GExpression](IdentifierExpression(parameter.Name)))
                    .ToList()
            )
            let statements = List[GStatement]{ExpressionStatement(call)}
            if ReturnsTask(symbol) {
                statements.Add(ReturnStatement(MemberAccessExpression(IdentifierExpression("Task"), "CompletedTask")))
            }
            body = BlockStatement(statements)
            let message = "analyzer test harness '${symbol!!.Name}' rewritten to delegate to " +
                "$AnalyzerVerifierNamespace.GSharpAnalyzerVerifier.VerifyAnalyzer: the Roslyn compilation " +
                "pipeline it drove (CSharpCompilation over TRUSTED_PLATFORM_ASSEMBLIES metadata references) " +
                "has no G# counterpart — the G# verifier compiles G# source with no reference set. The " +
                "harness signature and every call site are preserved; verify the expected diagnostic " +
                "locations still hold over the TRANSLATED snippets (ADR-0169 M5, issue #3686)."
            this.context.Report(
                TranslationDiagnostic("analyzer-api", message, site.GetLocation(), TranslationSeverity.Warning){
                    DiagnosticId = "CS2GS-ANALYZER-SHAPE"
                }
            )
            return true
        }

        private func ReportAnalyzerShapeIfAdapted(
            site SyntaxNode,
            containingName string?,
            memberName string?,
            entry RoslynAnalyzerApiMap.Entry
        ) {
            if entry.AdaptationNote == nil {
                return
            }
            this.context.Report(
                TranslationDiagnostic(
                    "analyzer-api",
                    "'$containingName.$memberName' translated as '${entry.GsName ?? memberName}': ${entry.AdaptationNote}",
                    site.GetLocation(),
                    TranslationSeverity.Warning
                ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
            )
        }

        shared {
            /// The Roslyn syntax type whose G# counterpart is a PREDICATE
            /// (`NullConditionalChain.AsNullConditionalHop(x) != nil`), not a node
            /// type — so, unlike (cref:PlainAccessAnalyzerTypes), it has no pure
            /// G# pattern form and can only be expressed where a boolean is accepted.
            internal const ConditionalAccessTypeName string = "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax"

            /// The Roslyn syntax types whose G# counterpart node is SHARED with the
            /// null-conditional spelling of the same access, so a bare type-name
            /// substitution silently over-matches (issue #4173 §6 and its
            /// ElementAccess sibling). Each entry names the G# node the ORDINARY
            /// (non-null-conditional) access maps to; the faithful rewrite is that
            /// node plus an `IsNullConditional: false` discriminator, which is
            /// a PURE G# pattern and therefore composes in every pattern position.
            internal let PlainAccessAnalyzerTypes Dictionary[string, string] = Dictionary[string, string](
                StringComparer.Ordinal
            ){
                ["Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax"] = "AccessorExpressionSyntax",
                ["Microsoft.CodeAnalysis.CSharp.Syntax.ElementAccessExpressionSyntax"] = "IndexExpressionSyntax"
            }

            /// The G# namespace holding the ADR-0169 verifier package that a
            /// migrated Roslyn analyzer test harness delegates to.
            private const AnalyzerVerifierNamespace string = "GSharp.CodeAnalysis.Analyzers.Testing"

            private func RoslynTypeMetadataName(type INamedTypeSymbol?) string? -> if type?.ContainingNamespace is {
                IsGlobalNamespace: false
            } ns {
                "${ns.ToDisplayString()}.${type!!.Name}"
            } else {
                type?.Name
            }

            /// Builds `(expr as TypeName)!!` — the same non-smart-castable
            /// narrowing shape `BuildPatternNarrowingReplacement` already
            /// uses elsewhere in this translator — for a designator whose
            /// SOUNDNESS is proven by a `NullConditionalChain` predicate
            /// rather than by a native G# type test, so it needs an explicit
            /// downcast to be usable as the narrower type afterward.
            /// @param expression The expression to narrow.
            /// @param typeName The G# type to narrow to.
            /// @returns The narrowed, asserted-non-null expression.
            private func NarrowToType(
                expression GExpression?,
                typeName string?
            ) GExpression -> NonNullAssertionExpression(
                ParenthesizedExpression(
                    BinaryExpression(expression, "as", TypeExpression(NamedTypeReference(typeName)))
                )
            )

            /// Extracts the type-name expression from a bare type-test subpattern
            /// (`{ Member: SomeType }`, no designation). The C# parser emits
            /// this as a (cref:TypePatternSyntax) only when it can tell
            /// syntactically; a bare simple name is ambiguous with a constant
            /// pattern at parse time, so it comes through as a
            /// (cref:ConstantPatternSyntax) whose expression the binder
            /// resolves to a type symbol instead. Returns null for anything else.
            private func BaseSubpatternTypeSyntax(pattern PatternSyntax) ExpressionSyntax? -> switch pattern {
                case typePattern is TypePatternSyntax: cast[ExpressionSyntax](typePattern.Type)
                case constantPattern is ConstantPatternSyntax: constantPattern.Expression
                default: default(ExpressionSyntax?)
            }

            /// Extracts the type-name expression from a top-level `is`-pattern
            /// type test (`expr is SomeType` / `expr is SomeType x`). Same
            /// ambiguity as (cref:BaseSubpatternTypeSyntax(PatternSyntax)): a
            /// designated test (`is SomeType x`) always parses as
            /// (cref:DeclarationPatternSyntax), but a BARE test with no
            /// designator (`is SomeType`) is ambiguous with a constant pattern
            /// at parse time and comes through as (cref:ConstantPatternSyntax)
            /// instead — every I1/I1b/I4/I5 type-test hook needs both forms, not
            /// just the designated one every existing test happened to use.
            private func IsPatternTypeSyntax(pattern PatternSyntax) ExpressionSyntax? -> switch pattern {
                case declaration is DeclarationPatternSyntax: cast[ExpressionSyntax](declaration.Type)
                case typePattern is TypePatternSyntax: cast[ExpressionSyntax](typePattern.Type)
                case constantPattern is ConstantPatternSyntax: constantPattern.Expression
                default: default(ExpressionSyntax?)
            }

            /// Whether an argument spells one operation kind directly, as
            /// `OperationKind.X`.
            /// @param expression The argument expression.
            /// @param context The translation context.
            /// @returns True for a direct `OperationKind` member access.
            private func IsDirectOperationKindAccess(
                expression ExpressionSyntax,
                context TranslationContext
            ) bool -> expression is MemberAccessExpressionSyntax &&
                context
                .GetSymbolInfo(expression)
                .Symbol is IFieldSymbol field &&
                RoslynTypeMetadataName(field.ContainingType) == "Microsoft.CodeAnalysis.OperationKind"

            /// The parameter an argument binds to, by NAME when the argument is
            /// named and by position otherwise, with a trailing `params` array
            /// absorbing the tail.
            /// @param argument The argument syntax.
            /// @param context The translation context.
            /// @returns The bound parameter, or null when it cannot be determined.
            private func DetermineParameter(argument ArgumentSyntax, context TranslationContext) IParameterSymbol? {
                if argument.Parent is not BaseArgumentListSyntax list || list.Parent == nil || context.GetSymbolInfo(
                    list.Parent
                )
                    .Symbol is not IMethodSymbol method {
                    return nil
                }
                if argument.NameColon is {Name: {Identifier: {ValueText: {Length: > 0} named}}} {
                    return method.Parameters.FirstOrDefault((p IParameterSymbol) -> p.Name == named)
                }
                let index = list.Arguments.IndexOf(argument)
                if index < 0 {
                    return nil
                }
                if index < method.Parameters.Length {
                    return method.Parameters[index]
                }
                let last IParameterSymbol? = method.Parameters.LastOrDefault()
                return if last != nil && last.IsParams == true {
                    last
                } else {
                    default(IParameterSymbol?)
                }
            }

            /// Whether an argument binds to the `operationKinds` parameter of
            /// `RegisterOperationAction` — the question "is this argument a
            /// kind?" answered from the SYMBOL, so named arguments in any order are
            /// classified correctly (PR #3968 review).
            /// @param argument The argument syntax.
            /// @param context The translation context.
            /// @returns True when the argument supplies operation kinds.
            private func BindsToOperationKindsParameter(argument ArgumentSyntax, context TranslationContext) bool {
                let type ITypeSymbol? = DetermineParameter(argument, context)?.Type
                if type == nil {
                    return false
                }
                if RoslynTypeMetadataName(type as INamedTypeSymbol) == "Microsoft.CodeAnalysis.OperationKind" {
                    return true
                }
                let element ITypeSymbol? = switch type {
                    case array is IArrayTypeSymbol: array.ElementType
                    case INamedTypeSymbol{TypeArguments: {Length: 1}} named: named.TypeArguments[0]
                    default: default(ITypeSymbol?)
                }
                return RoslynTypeMetadataName(element as INamedTypeSymbol) == "Microsoft.CodeAnalysis.OperationKind"
            }

            private func ReturnsTask(symbol IMethodSymbol?) bool -> symbol!!.ReturnType is INamedTypeSymbol{
                Name: "Task"
            } returnType &&
                returnType
                .ContainingNamespace
                ?.ToDisplayString() == "System.Threading.Tasks"
        }
    }

    shared {
        /// Issue #4173 round 3, §4.5: the Roslyn type metadata names this
        /// translator treats as sharing a G# node with their null-conditional
        /// sibling ((cref:DeclarationVisitor.PlainAccessAnalyzerTypes) plus
        /// (cref:DeclarationVisitor.ConditionalAccessTypeName)) — exposed so
        /// a Cs2Gs.Tests drift test can assert this set agrees with
        /// (cref:RoslynAnalyzerApiMap)'s own `SharedGsNode`-flagged
        /// rows, so a future shared-node row added to one registry but not the
        /// other fails loudly instead of silently shipping the over-match bug a
        /// fourth time.
        /// @returns The flagged rows' Roslyn metadata names.
        internal func EnumerateAnalyzerSharedGsNodeTypeNames() IEnumerable[string] -> DeclarationVisitor
            .PlainAccessAnalyzerTypes
            .Keys
            .Append(DeclarationVisitor.ConditionalAccessTypeName)
    }
}
