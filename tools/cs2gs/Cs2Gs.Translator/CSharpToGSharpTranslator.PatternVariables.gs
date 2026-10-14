// <copyright file="CSharpToGSharpTranslator.PatternVariables.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import System
import System.Collections.Generic
import System.Linq

partial class CSharpToGSharpTranslator {
    /// ADR-0166 / issue #3409: native G# pattern variables. When every
    /// designation in a C# `is` pattern is expressible as a G# designation
    /// (`x is T t`, `x is { P: T t } u`, `x is [.. rest]`) and G#
    /// scopes each pattern variable to every region C# reads it in, the
    /// translator emits the pattern verbatim — no `if let`, no negated-guard
    /// hoist, no `__spillN` temporary, no `(x as T)!!` substitution.
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        /// The ADR-0166 native path for a binding or `var` `is` pattern. Returns
        /// `null` when the enclosing condition does not qualify,
        /// in which case the caller continues with the legacy lowering.
        private func TryTranslateNativePatternVariables(isPattern IsPatternExpressionSyntax) GExpression? {
            if !PatternUsesNativeVariableSyntax(isPattern.Pattern) || !this.ConditionUsesNativePatternVariables(
                GetConditionRoot(isPattern)
            ) {
                return nil
            }
            let receiver GExpression? = this.TranslateExpression(isPattern.Expression)
            let binders = List[ILocalSymbol]()
            var pattern = isPattern.Pattern
            let lowerNegation = HasUnsupportedBindingUnderTopLevelNot(pattern)
            if lowerNegation {
                pattern = StripTopLevelNegation(pattern, out _)
            }
            let native = this.BuildNativePattern(pattern, binders)
            let effectiveReceiverType ITypeSymbol? = this.GetManagedReferenceArrayProjectedExpressionType(
                isPattern.Expression
            ) ??
                this
                .context
                .GetTypeInfo(isPattern.Expression)
                .Type
            this.RegisterProjectedNativePatternBindings(
                pattern,
                effectiveReceiverType,
                this.GetMappedArrayElementType(isPattern.Expression)
            )
            for binder in binders {
                this.state.PatternBindings[binder] = IdentifierExpression(this.EmittedName(binder, binder.Name))
                this.state.NativePatternVariables.Add(binder)
            }
            let test GExpression = PatternTestExpression(receiver, native)
            return if lowerNegation {
                cast[GExpression](UnaryExpression("!", ParenthesizedExpression(test)))
            } else {
                test
            }
        }

        private func RegisterProjectedNativePatternBindings(
            pattern PatternSyntax?,
            receiverType ITypeSymbol?,
            mappedListElementType ITypeSymbol? = nil
        ) {
            switch pattern {
                case VarPatternSyntax{Designation: SingleVariableDesignationSyntax variable} {
                    this.RegisterProjectedPatternBinding(this.context.GetDeclaredSymbol(variable), receiverType)
                }
                case list is ListPatternSyntax {
                    let elementType ITypeSymbol? = mappedListElementType ??
                        (
                        if receiverType is IArrayTypeSymbol array {
                            array.ElementType
                        } else {
                            this.GetListPatternElementType(list, receiverType)
                        }
                    )
                    for element in list.Patterns {
                        if element is SlicePatternSyntax slice {
                            if slice.Pattern != nil && PatternIntroducesBinding(slice.Pattern) {
                                this.RegisterProjectedNativePatternBindings(
                                    slice.Pattern,
                                    this.GetProjectedSlicePatternType(slice, receiverType, mappedListElementType)
                                )
                            }
                        } else {
                            this.RegisterProjectedNativePatternBindings(element, elementType)
                        }
                    }
                }
                case recursive is RecursivePatternSyntax {
                    if recursive.Designation is SingleVariableDesignationSyntax designation {
                        var designationType ITypeSymbol? = receiverType
                        if recursive.Type != nil &&
                            receiverType is INamedTypeSymbol projectedReceiver &&
                            this
                            .context
                            .GetTypeInfo(recursive.Type)
                            .Type is INamedTypeSymbol narrowedType {
                            designationType = ReceiverTypeHierarchy(projectedReceiver).FirstOrDefault(
                                (candidate INamedTypeSymbol) -> SymbolEqualityComparer.Default.Equals(
                                    candidate.OriginalDefinition,
                                    narrowedType.OriginalDefinition
                                )
                            ) ??
                                narrowedType
                        }
                        this.RegisterProjectedPatternBinding(
                            this.context.GetDeclaredSymbol(designation),
                            designationType
                        )
                    }
                    if recursive.PropertyPatternClause != nil {
                        for subpattern in recursive.PropertyPatternClause!!.Subpatterns {
                            let memberType ITypeSymbol? = if subpattern.NameColon != nil {
                                this.GetProjectedPatternMemberType(receiverType, subpattern.NameColon!!.Name)
                            } else {
                                this.GetProjectedPatternMemberPathType(
                                    receiverType,
                                    subpattern.ExpressionColon?.Expression
                                )
                            }
                            this.RegisterProjectedNativePatternBindings(subpattern.Pattern, memberType)
                        }
                    }
                    if recursive.PositionalPatternClause != nil &&
                        receiverType is INamedTypeSymbol{IsTupleType: true} tuple &&
                        recursive.PositionalPatternClause!!
                        .Subpatterns
                        .Count == tuple
                        .TupleElements
                        .Length {
                        for var i = 0; i < recursive.PositionalPatternClause!!.Subpatterns.Count; i++ {
                            this.RegisterProjectedNativePatternBindings(
                                recursive.PositionalPatternClause!!.Subpatterns[i].Pattern,
                                GetEffectiveTupleElementType(tuple, i)
                            )
                        }
                    }
                }
                case parenthesized is ParenthesizedPatternSyntax {
                    this.RegisterProjectedNativePatternBindings(parenthesized.Pattern, receiverType)
                }
                case binary is BinaryPatternSyntax {
                    this.RegisterProjectedNativePatternBindings(binary.Left, receiverType)
                    this.RegisterProjectedNativePatternBindings(binary.Right, receiverType)
                }
            }
        }

        private func RegisterProjectedSwitchPatternBindings(pattern PatternSyntax, receiver ExpressionSyntax) {
            let receiverType ITypeSymbol? = this.GetManagedReferenceArrayProjectedExpressionType(receiver) ??
                this
                .context
                .GetTypeInfo(receiver)
                .Type
            this.RegisterProjectedNativePatternBindings(pattern, receiverType, this.GetMappedArrayElementType(receiver))
        }

        private func RegisterProjectedPatternBinding(symbol ISymbol?, effectiveType ITypeSymbol?) {
            if symbol is ILocalSymbol local &&
                effectiveType != nil &&
                CSharpToGSharpTranslator
                .TypeContainsRecognizedManagedReferenceConsumer(effectiveType, this.context.Compilation) {
                this.state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[local] = effectiveType
            }
        }

        private func GetProjectedSlicePatternType(
            slice SlicePatternSyntax,
            receiverType ITypeSymbol?,
            mappedArrayElementType ITypeSymbol?
        ) ITypeSymbol? {
            if receiverType is IArrayTypeSymbol array {
                return if mappedArrayElementType == nil {
                    receiverType
                } else {
                    cast[ITypeSymbol](
                        this
                            .context
                            .Compilation
                            .CreateArrayTypeSymbol(mappedArrayElementType, array.Rank, array.NullableAnnotation)
                    )
                }
            }
            var sliceSymbol ISymbol? = (
                this.context.SemanticModel.GetOperation(slice) as ISlicePatternOperation
            )?.SliceSymbol
            if receiverType is INamedTypeSymbol projectedReceiver && sliceSymbol != nil {
                sliceSymbol = this.GetProjectedMember(projectedReceiver, sliceSymbol) ?? sliceSymbol
            }
            return switch sliceSymbol {
                case property is IPropertySymbol: property.Type
                case method is IMethodSymbol: method.ReturnType
                default: default(ITypeSymbol?)
            }
        }

        private func GetProjectedPatternMemberPathType(receiverType ITypeSymbol?, path ExpressionSyntax?) ITypeSymbol? {
            return switch path {
                case name is SimpleNameSyntax: this.GetProjectedPatternMemberType(receiverType, name)
                case access is MemberAccessExpressionSyntax: this.GetProjectedPatternMemberType(
                    this.GetProjectedPatternMemberPathType(receiverType, access.Expression),
                    access
                )
                default: default(ITypeSymbol?)
            }
        }

        private func GetProjectedPatternMemberType(receiverType ITypeSymbol?, memberSyntax SyntaxNode?) ITypeSymbol? {
            let member ISymbol? = if memberSyntax == nil {
                default(ISymbol?)
            } else {
                this.GetPatternMemberSymbol(memberSyntax)
            }
            return this.GetProjectedPatternMemberType(receiverType, member)
        }

        private func GetProjectedPatternMemberType(receiverType ITypeSymbol?, member ISymbol?) ITypeSymbol? {
            var member = member
            if receiverType is INamedTypeSymbol projectedReceiver && member != nil {
                member = this.GetProjectedMember(projectedReceiver, member) ?? member
            }
            return switch member {
                case field is IFieldSymbol: field.Type
                case property is IPropertySymbol: property.Type
                case method is IMethodSymbol: method.ReturnType
                default: default(ITypeSymbol?)
            }
        }

        /// True when [`condition`](paramref) contains at least one binding
        /// `is` pattern and every binding `is` pattern in it qualifies
        /// for the ADR-0166 native path. Conditions are all-or-nothing: the
        /// legacy `if let` / guard-hoist lowerings rewrite the whole
        /// condition and would not scope a native pattern variable into the
        /// bodies they synthesize.
        private func ConditionUsesNativePatternVariables(condition ExpressionSyntax?) bool {
            if condition == nil {
                return false
            }
            if this.state.NativePatternConditionCache.TryGetValue(condition, out var cached) {
                return cached
            }
            var any = false
            var all = true
            for isPattern in condition.DescendantNodesAndSelf(
                (node SyntaxNode) -> !(
                    (node is AnonymousFunctionExpressionSyntax || node is LocalFunctionStatementSyntax)
                )
            )
                .OfType[IsPatternExpressionSyntax]() {
                if !PatternUsesNativeVariableSyntax(isPattern.Pattern) {
                    continue
                }
                any = true
                if !this.IsPatternQualifiesForNativeVariables(isPattern) {
                    all = false
                    break
                }
            }
            let result = any && all
            this.state.NativePatternConditionCache[condition] = result
            return result
        }

        private func IsPatternQualifiesForNativeVariables(isPattern IsPatternExpressionSyntax) bool {
            if !IsNativelyExpressiblePattern(isPattern.Pattern, topLevel: true) {
                return false
            }
            let regions = ComputeNativePatternVariableRegions(isPattern)
            let scope_ = this
                .state
                .CurrentBodyScope ??
                isPattern
                .Ancestors()
                .OfType[MemberDeclarationSyntax]()
                .FirstOrDefault() ??
                isPattern
                .SyntaxTree
                .GetRoot()
            for designation in isPattern.Pattern.DescendantNodesAndSelf().OfType[SingleVariableDesignationSyntax]() {
                if this.context.GetDeclaredSymbol(designation) is not ILocalSymbol local ||
                    local.Type == nil ||
                    local
                    .Type
                    .TypeKind == TypeKind.Error ||
                    local
                    .Type
                    .IsRefLikeType {
                    return false
                }
                // G# pattern variables are `let`-immutable.
                if this.IsSymbolReassigned(local, scope_) {
                    return false
                }
                for identifier in scope_.DescendantNodes().OfType[IdentifierNameSyntax]() {
                    if identifier.Identifier.ValueText != local.Name || !SymbolEqualityComparer.Default.Equals(
                        this.context.GetSymbolInfo(identifier).Symbol,
                        local
                    ) {
                        continue
                    }
                    if !regions.Any((region SyntaxNode) -> region.Span.Contains(identifier.Span)) {
                        return false
                    }
                }
            }
            return true
        }

        private func RequiresNativeDisjunctiveNarrowing(isPattern IsPatternExpressionSyntax) bool {
            var pattern = isPattern.Pattern
            while pattern is ParenthesizedPatternSyntax parenthesized {
                pattern = parenthesized.Pattern
            }
            let declaredType ITypeSymbol? = this.ResolveDeclaredReceiverType(
                this.context.GetTypeInfo(isPattern.Expression).Type,
                isPattern.Expression
            )
            let nullableScrutinee = declaredType?.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated ||
                (
                declaredType is INamedTypeSymbol nullableValue &&
                    nullableValue
                    .OriginalDefinition
                    .SpecialType == SpecialType.System_Nullable_T
            )
            return nullableScrutinee && this.IsSmartCastableScrutinee(isPattern.Expression) &&
                !PatternIntroducesBinding(isPattern.Pattern) &&
                !this.PatternMentionsConditionalAccessType(isPattern.Pattern, out _) &&
                this.IsNativelyExpressiblePattern(isPattern.Pattern, topLevel: true) &&
                pattern is BinaryPatternSyntax binary &&
                binary.IsKind(SyntaxKind.OrPattern) &&
                TryGetPatternNonNullPolarity(pattern, out var whenTrue) &&
                whenTrue
        }

        private func GSharpPatternPreservesNonNullNarrowing(isPattern IsPatternExpressionSyntax, whenTrue bool) bool {
            let declaredType ITypeSymbol? = this.ResolveDeclaredReceiverType(
                this.context.GetTypeInfo(isPattern.Expression).Type,
                isPattern.Expression
            )
            let underlyingType ITypeSymbol? = if declaredType is INamedTypeSymbol nullableValue &&
                nullableValue
                .OriginalDefinition
                .SpecialType == SpecialType.System_Nullable_T {
                nullableValue.TypeArguments[0]
            } else {
                declaredType?.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.NotAnnotated)
            }
            return this.GetGSharpPatternNarrowedType(isPattern.Pattern, underlyingType, whenTrue) != nil
        }

        private func GetGSharpPatternNarrowedType(
            pattern PatternSyntax,
            underlyingType ITypeSymbol?,
            whenTrue bool
        ) ITypeSymbol? {
            var pattern = pattern
            while pattern is ParenthesizedPatternSyntax parenthesized {
                pattern = parenthesized.Pattern
            }
            if pattern is UnaryPatternSyntax unary && unary.IsKind(SyntaxKind.NotPattern) {
                return this.GetGSharpPatternNarrowedType(unary.Pattern, underlyingType, !whenTrue)
            }
            if pattern is BinaryPatternSyntax binary {
                let conjunction = binary.IsKind(SyntaxKind.AndPattern)
                let left ITypeSymbol? = this.GetGSharpPatternNarrowedType(binary.Left, underlyingType, whenTrue)
                let right ITypeSymbol? = this.GetGSharpPatternNarrowedType(binary.Right, underlyingType, whenTrue)
                let merge = conjunction == whenTrue
                if merge {
                    return left ?? right
                }
                return if left != nil && right != nil && SymbolEqualityComparer.Default.Equals(left, right) {
                    left
                } else {
                    default(ITypeSymbol?)
                }
            }
            if pattern is ConstantPatternSyntax constant {
                if this.context.GetSymbolInfo(constant.Expression).Symbol is ITypeSymbol constantType {
                    return if whenTrue {
                        constantType
                    } else {
                        default(ITypeSymbol?)
                    }
                }
                let isNull = IsNullLiteral(constant.Expression)
                return if whenTrue != isNull {
                    underlyingType
                } else {
                    default(ITypeSymbol?)
                }
            }
            if !whenTrue {
                return nil
            }
            return switch pattern {
                case typePattern is TypePatternSyntax: this.context.GetTypeInfo(typePattern.Type).Type
                case declaration is DeclarationPatternSyntax: this.context.GetTypeInfo(declaration.Type).Type
                case RecursivePatternSyntax{Type: not nil} recursive: this.context.GetTypeInfo(recursive.Type).Type
                default: default(ITypeSymbol?)
            }
        }

        /// Structural mirror of (cref:BuildNativePattern): true when the
        /// pattern maps onto G# pattern grammar with designations and no
        /// translator-side substitution (scalar `var` designations do;
        /// positional clauses, whole-list designations, and tuple designations do not).
        private func IsNativelyExpressiblePattern(pattern PatternSyntax?, topLevel bool) bool {
            // Issue #4173 round 3: CAE's faithful G# form is a PREDICATE, not a
            // node type, so no native G# pattern can express it. Refusing here
            // funnels the whole is-pattern to the boolean lowering, where
            // TranslatePatternTest's leaf hook can emit the predicate and
            // not/and/or compose for free.
            if this.PatternMentionsConditionalAccessType(pattern, out _) {
                return false
            }
            switch pattern {
                case ConstantPatternSyntax, RelationalPatternSyntax, DiscardPatternSyntax, TypePatternSyntax {
                    return true
                }
                case declaration is DeclarationPatternSyntax {
                    return (declaration.Designation is SingleVariableDesignationSyntax or DiscardDesignationSyntax)
                }
                case varPattern is VarPatternSyntax {
                    return (varPattern.Designation is SingleVariableDesignationSyntax or DiscardDesignationSyntax)
                }
                case recursive is RecursivePatternSyntax {
                    if recursive.PositionalPatternClause != nil ||
                        recursive.Designation is ParenthesizedVariableDesignationSyntax {
                        return false
                    }
                    if recursive.PropertyPatternClause != nil {
                        let directRoots = HashSet[string](StringComparer.Ordinal)
                        let extendedRoots = HashSet[string](StringComparer.Ordinal)
                        let extendedTrees = Dictionary[string, ExtendedPropertyFieldTree](StringComparer.Ordinal)
                        for sub in recursive.PropertyPatternClause!!.Subpatterns {
                            if !this.IsNativelyExpressiblePattern(sub.Pattern, topLevel: false) {
                                return false
                            }
                            if sub.NameColon != nil {
                                directRoots.Add(
                                    this.EmittedName(
                                        this.GetPatternMemberSymbol(sub.NameColon!!.Name),
                                        this.GetSubpatternMemberName(sub)
                                    )!!
                                )
                                continue
                            }
                            if sub.ExpressionColon == nil {
                                return false
                            }
                            let names = SplitMemberPath(sub.ExpressionColon!!.Expression)
                            let rootName = names[0]
                            extendedRoots.Add(rootName)
                            if !extendedTrees.TryGetValue(rootName, out var tree) {
                                tree = ExtendedPropertyFieldTree()
                                extendedTrees[rootName] = tree
                            }
                            tree.Insert(names, 1, sub.Pattern)
                            if tree.HasCollision {
                                return false
                            }
                        }
                        if directRoots.Overlaps(extendedRoots) {
                            return false
                        }
                    }
                    return true
                }
                case unary is UnaryPatternSyntax when unary.OperatorToken.IsKind(SyntaxKind.NotKeyword) {
                    // ADR-0166: G# directly supports a designation under the
                    // top-level `not` of an is-expression.
                    return if topLevel {
                        IsNativelyExpressiblePattern(unary.Pattern, topLevel: true)
                    } else {
                        !PatternIntroducesBinding(unary.Pattern) &&
                            IsNativelyExpressiblePattern(unary.Pattern, topLevel: false)
                    }
                }
                case parenthesized is ParenthesizedPatternSyntax {
                    return IsNativelyExpressiblePattern(parenthesized.Pattern, topLevel)
                }
                case binary is BinaryPatternSyntax when binary.OperatorToken.IsKind(SyntaxKind.AndKeyword) ||
                    binary
                    .OperatorToken
                    .IsKind(SyntaxKind.OrKeyword) {
                    if binary.OperatorToken.IsKind(SyntaxKind.OrKeyword) && PatternIntroducesBinding(binary) {
                        return false
                    }
                    return IsNativelyExpressiblePattern(binary.Left, topLevel: false) &&
                        IsNativelyExpressiblePattern(binary.Right, topLevel: false)
                }
                case list is ListPatternSyntax {
                    if list.Designation != nil {
                        return false
                    }
                    for element in list.Patterns {
                        if element is SlicePatternSyntax slice {
                            if (
                                slice.Pattern is nil or
                                    VarPatternSyntax and
                                    {Designation: SingleVariableDesignationSyntax or DiscardDesignationSyntax} or
                                    DeclarationPatternSyntax and
                                    {Designation: SingleVariableDesignationSyntax or DiscardDesignationSyntax}
                            ) {
                                continue
                            }
                            return false
                        }
                        if !IsNativelyExpressiblePattern(element, topLevel: false) {
                            return false
                        }
                    }
                    return true
                }
                default {
                    return false
                }
            }
        }

        /// Builds the G# pattern for a natively expressible C# pattern (see
        /// (cref:IsNativelyExpressiblePattern)), collecting the C# locals
        /// its designations declare so the caller can register them as
        /// identity substitutions.
        private func BuildNativePattern(pattern PatternSyntax?, binders List[ILocalSymbol]) GPattern {
            switch pattern {
                case constant is ConstantPatternSyntax when this.IsTypeReferencePattern(constant.Expression) {
                    return this.BuildPatternTypeTest("_", constant.Expression, constant, designationAfterType: true)
                }
                case constant is ConstantPatternSyntax {
                    return ConstantPattern(this.TranslateExpression(constant.Expression))
                }
                case relational is RelationalPatternSyntax {
                    return RelationalPattern(
                        relational.OperatorToken.Text,
                        this.TranslateExpression(relational.Expression)
                    )
                }
                case DiscardPatternSyntax {
                    return DiscardPattern()
                }
                case typePattern is TypePatternSyntax {
                    return this.BuildPatternTypeTest("_", typePattern.Type, typePattern, designationAfterType: true)
                }
                case declaration is DeclarationPatternSyntax {
                    return this.BuildPatternTypeTest(
                        this.NativeDesignator(declaration.Designation, binders),
                        declaration.Type,
                        declaration,
                        designationAfterType: true
                    )
                }
                case varPattern is VarPatternSyntax {
                    return VarPattern(this.NativeDesignator(varPattern.Designation, binders))
                }
                case recursive is RecursivePatternSyntax {
                    {
                        let fields = this.BuildNativePropertyFields(recursive, binders)
                        let designator string? = this.NativeDesignator(recursive.Designation, binders)
                        if recursive.Type != nil {
                            // `T { }` carries the type test's own non-nil check, and
                            // an empty suffix would read as the statement body in a
                            // G# `if` header, so it is dropped.
                            return this.BuildPatternTypeTest(
                                designator,
                                recursive.Type,
                                recursive,
                                suffix: if fields.Count == 0 {
                                    default(PropertyPattern?)
                                } else {
                                    PropertyPattern(fields)
                                },
                                designationAfterType: true
                            )
                        }
                        return PropertyPattern(
                            fields,
                            if designator == "_" {
                                default(string?)
                            } else {
                                designator
                            }
                        )
                    }
                }
                case unary is UnaryPatternSyntax when unary.OperatorToken.IsKind(SyntaxKind.NotKeyword) {
                    return NotPattern(this.BuildNativePattern(unary.Pattern, binders))
                }
                case parenthesized is ParenthesizedPatternSyntax {
                    return ParenthesizedPattern(this.BuildNativePattern(parenthesized.Pattern, binders))
                }
                case binary is BinaryPatternSyntax {
                    return BinaryPattern(
                        binary.OperatorToken.IsKind(SyntaxKind.AndKeyword),
                        this.BuildNativePattern(binary.Left, binders),
                        this.BuildNativePattern(binary.Right, binders)
                    )
                }
                case list is ListPatternSyntax {
                    {
                        let elements = List[GPattern](list.Patterns.Count)
                        for element in list.Patterns {
                            if element is SlicePatternSyntax slice {
                                let sliceDesignation VariableDesignationSyntax? = switch slice.Pattern {
                                    case varPattern is VarPatternSyntax: varPattern.Designation
                                    case declarationPattern is DeclarationPatternSyntax: declarationPattern.Designation
                                    default: default(VariableDesignationSyntax?)
                                }
                                let sliceDesignator string? = this.NativeDesignator(sliceDesignation, binders)
                                elements.Add(
                                    SlicePattern(
                                        if sliceDesignator == "_" {
                                            default(string?)
                                        } else {
                                            sliceDesignator
                                        }
                                    )
                                )
                                continue
                            }
                            elements.Add(this.BuildNativePattern(element, binders))
                        }
                        return ListPattern(elements)
                    }
                }
                default {
                    this.context.ReportUnsupported(
                        pattern,
                        "pattern '${pattern!!.Kind()}' has no canonical G# form yet (ADR-0115 §B)."
                    )
                    return DiscardPattern()
                }
            }
        }

        private func BuildNativePropertyFields(recursive RecursivePatternSyntax, binders List[ILocalSymbol]) List[
            PropertyPatternField
        ] {
            let fields = List[PropertyPatternField]()
            if recursive.PropertyPatternClause == nil {
                return fields
            }
            let extendedTrees = Dictionary[string, ExtendedPropertyFieldTree](StringComparer.Ordinal)
            let extendedIndexes = Dictionary[string, int32](StringComparer.Ordinal)
            for sub in recursive.PropertyPatternClause!!.Subpatterns {
                if sub.NameColon != nil {
                    var fieldName string? = this.EmittedName(
                        this.GetPatternMemberSymbol(sub.NameColon!!.Name),
                        this.GetSubpatternMemberName(sub)
                    )
                    fieldName = this.TranslateAnalyzerPatternFieldName(recursive, sub, fieldName)
                    fields.Add(PropertyPatternField(fieldName, this.BuildNativePattern(sub.Pattern, binders)))
                    continue
                }
                let names = SplitMemberPath(sub.ExpressionColon!!.Expression)
                let rootName = names[0]
                if !extendedTrees.TryGetValue(rootName, out var tree) {
                    tree = ExtendedPropertyFieldTree()
                    extendedTrees[rootName] = tree
                    extendedIndexes[rootName] = fields.Count
                    fields.Add(default(PropertyPatternField))
                }
                tree.Insert(names, 1, sub.Pattern)
            }
            for pair in extendedTrees {
                fields[extendedIndexes[pair.Key]] = PropertyPatternField(
                    pair.Key,
                    PropertyPattern(pair.Value.ConvertNativeChildren(this, binders))
                )
            }
            return fields
        }

        // Records the local a designation declares and returns its sanitized G#
        // name; a discard or missing designation is `_`.
        private func NativeDesignator(designation VariableDesignationSyntax?, binders List[ILocalSymbol]) string? {
            if designation is SingleVariableDesignationSyntax single && this.context.GetDeclaredSymbol(
                single
            ) is ILocalSymbol local {
                binders.Add(local)
                return if this.state.NativePatternVariableAliases.TryGetValue(local, out var alias) {
                    alias
                } else {
                    this.EmittedName(single, single.Identifier)
                }
            }
            return "_"
        }

        shared {
            private func HasUnsupportedBindingUnderTopLevelNot(pattern PatternSyntax) bool {
                var pattern = pattern
                while pattern is ParenthesizedPatternSyntax parenthesized {
                    pattern = parenthesized.Pattern
                }
                if pattern is not UnaryPatternSyntax unary || !unary.OperatorToken.IsKind(SyntaxKind.NotKeyword) ||
                    !PatternIntroducesBinding(unary.Pattern) {
                    return false
                }
                return switch unary.Pattern {
                    case declaration is DeclarationPatternSyntax: !(
                        declaration.Designation is SingleVariableDesignationSyntax
                    )
                    case recursive is RecursivePatternSyntax: !(
                        recursive.Designation is SingleVariableDesignationSyntax
                    ) ||
                        recursive
                        .PropertyPatternClause
                        ?.Subpatterns
                        .Any((subpattern SubpatternSyntax) -> PatternIntroducesBinding(subpattern.Pattern)) == true
                    default: true
                }
            }

            private func PatternUsesNativeVariableSyntax(pattern PatternSyntax) bool -> PatternIntroducesBinding(
                pattern
            ) ||
                pattern
                .DescendantNodesAndSelf()
                .OfType[VarPatternSyntax]()
                .Any(
                (varPattern VarPatternSyntax) -> (
                    varPattern.Designation is SingleVariableDesignationSyntax or DiscardDesignationSyntax
                )
            )

            /// The outermost boolean context an `is` pattern participates in:
            /// the chain of parentheses, `!`, `&&`, and `||`
            /// above it. The dispatchers ask about this same node, so the native
            /// decision is consistent between the statement/expression lowering and
            /// the pattern itself.
            private func GetConditionRoot(node ExpressionSyntax) ExpressionSyntax {
                var root = node
                while true {
                    switch root.Parent {
                        case parenthesized is ParenthesizedExpressionSyntax {
                            root = parenthesized
                            continue
                        }
                        case prefix is PrefixUnaryExpressionSyntax when prefix.IsKind(SyntaxKind.LogicalNotExpression) {
                            root = prefix
                            continue
                        }
                        case binary is BinaryExpressionSyntax when binary.IsKind(SyntaxKind.LogicalAndExpression) ||
                            binary.IsKind(SyntaxKind.LogicalOrExpression) {
                            root = binary
                            continue
                        }
                        default {
                            return root
                        }
                    }
                }
            }

            /// The syntax regions in which G# scopes the pattern variables of
            /// [`isPattern`](paramref) — the mirror of the compiler's
            /// `PatternVariables` classifier and `BindIfStatement` leak rule:
            /// the right operand of an enclosing `&&` (of `||` under
            /// negation), the branch a condition selects, the loop body, the guarded
            /// switch arm, and the statements after an `if` whose other branch
            /// always exits.
            private func ComputeNativePatternVariableRegions(isPattern IsPatternExpressionSyntax) List[SyntaxNode] {
                // `x is not T t` assigns `t` when the whole test is FALSE.
                StripTopLevelNegation(isPattern.Pattern, out var negated)
                return ComputePatternFlowRegions(isPattern, whenTrue: !negated)
            }

            private func ComputePatternFlowRegions(
                isPattern IsPatternExpressionSyntax,
                whenTrue bool,
                includeWhenClauseRegion bool = true
            ) List[SyntaxNode] -> ComputeBooleanFlowRegions(isPattern, whenTrue, includeWhenClauseRegion)

            private func ComputeBooleanFlowRegions(
                condition ExpressionSyntax,
                whenTrue bool,
                includeWhenClauseRegion bool = true
            ) List[SyntaxNode] {
                var whenTrue = whenTrue
                let regions = List[SyntaxNode]()
                var node SyntaxNode? = condition
                while true {
                    let parent SyntaxNode? = node!!.Parent
                    switch parent {
                        case ParenthesizedExpressionSyntax {
                            node = parent
                            continue
                        }
                        case prefix is PrefixUnaryExpressionSyntax when prefix.IsKind(SyntaxKind.LogicalNotExpression) {
                            whenTrue = !whenTrue
                            node = parent
                            continue
                        }
                        case binary is BinaryExpressionSyntax when binary.IsKind(SyntaxKind.LogicalAndExpression) {
                            if !whenTrue {
                                return regions
                            }
                            if binary.Left == node {
                                regions.Add(binary.Right)
                            }
                            node = parent
                            continue
                        }
                        case binary is BinaryExpressionSyntax when binary.IsKind(SyntaxKind.LogicalOrExpression) {
                            if whenTrue {
                                return regions
                            }
                            if binary.Left == node {
                                regions.Add(binary.Right)
                            }
                            node = parent
                            continue
                        }
                        case conditional is ConditionalExpressionSyntax when conditional.Condition == node {
                            regions.Add(
                                if whenTrue {
                                    conditional.WhenTrue
                                } else {
                                    conditional.WhenFalse
                                }
                            )
                            return regions
                        }
                        case ifStatement is IfStatementSyntax when ifStatement.Condition == node {
                            {
                                if whenTrue {
                                    regions.Add(ifStatement.Statement)
                                } else if ifStatement.Else != nil {
                                    regions.Add(ifStatement.Else!!.Statement)
                                }
                                let leaks = if whenTrue {
                                    ifStatement.Else != nil && StatementAlwaysExits(ifStatement.Else!!.Statement)
                                } else {
                                    StatementAlwaysExits(ifStatement.Statement)
                                }
                                if leaks {
                                    AddFollowingStatements(ifStatement, regions)
                                }
                                return regions
                            }
                        }
                        case whileStatement is WhileStatementSyntax when whileStatement.Condition == node {
                            if whenTrue {
                                regions.Add(whileStatement.Statement)
                            }
                            return regions
                        }
                        case forStatement is ForStatementSyntax when forStatement.Condition == node {
                            if whenTrue {
                                regions.Add(forStatement.Statement)
                            }
                            return regions
                        }
                        case whenClause is WhenClauseSyntax {
                            if whenTrue && includeWhenClauseRegion {
                                if whenClause.Parent is CasePatternSwitchLabelSyntax{
                                    Parent: SwitchSectionSyntax section
                                } {
                                    regions.AddRange(section.Statements)
                                } else if whenClause.Parent is SwitchExpressionArmSyntax arm {
                                    regions.Add(arm.Expression)
                                }
                            }
                            return regions
                        }
                        case catchFilter is CatchFilterClauseSyntax when catchFilter.FilterExpression == node {
                            if whenTrue && catchFilter.Parent is CatchClauseSyntax catchClause {
                                regions.Add(catchClause.Block)
                            }
                            return regions
                        }
                        default {
                            return regions
                        }
                    }
                }
            }

            private func TryGetPatternNonNullPolarity(pattern PatternSyntax, out whenTrue bool) bool {
                switch pattern {
                    case parenthesized is ParenthesizedPatternSyntax {
                        return TryGetPatternNonNullPolarity(parenthesized.Pattern, out whenTrue)
                    }
                    case unary is UnaryPatternSyntax when unary.OperatorToken.IsKind(SyntaxKind.NotKeyword) {
                        if TryGetPatternNonNullPolarity(unary.Pattern, out whenTrue) {
                            whenTrue = !whenTrue
                            return true
                        }
                    }
                    case constant is ConstantPatternSyntax when IsNullLiteral(constant.Expression) {
                        whenTrue = false
                        return true
                    }
                    case binary is BinaryPatternSyntax when binary.OperatorToken.IsKind(SyntaxKind.AndKeyword) {
                        {
                            let leftKnown = TryGetPatternNonNullPolarity(binary.Left, out var leftWhenTrue)
                            let rightKnown = TryGetPatternNonNullPolarity(binary.Right, out var rightWhenTrue)
                            if (leftKnown && leftWhenTrue) || (rightKnown && rightWhenTrue) {
                                whenTrue = true
                                return true
                            }
                            if leftKnown && rightKnown && !leftWhenTrue && !rightWhenTrue {
                                whenTrue = false
                                return true
                            }
                        }
                    }
                    case binary is BinaryPatternSyntax when binary.OperatorToken.IsKind(SyntaxKind.OrKeyword) {
                        {
                            let leftKnown = TryGetPatternNonNullPolarity(binary.Left, out var leftWhenTrue)
                            let rightKnown = TryGetPatternNonNullPolarity(binary.Right, out var rightWhenTrue)
                            if (leftKnown && !leftWhenTrue) || (rightKnown && !rightWhenTrue) {
                                whenTrue = false
                                return true
                            }
                            if leftKnown && rightKnown && leftWhenTrue && rightWhenTrue {
                                whenTrue = true
                                return true
                            }
                        }
                    }
                    case VarPatternSyntax, DiscardPatternSyntax { }
                    case ConstantPatternSyntax,
                    RelationalPatternSyntax,
                    TypePatternSyntax,
                    DeclarationPatternSyntax,
                    RecursivePatternSyntax,
                    ListPatternSyntax {
                        whenTrue = true
                        return true
                    }
                }
                whenTrue = false
                return false
            }

            // Peels parentheses and top-level `not` layers off a pattern, reporting
            // whether an odd number of negations remained: designations under such a
            // `not` are assigned when the enclosing test evaluates to false.
            private func StripTopLevelNegation(pattern PatternSyntax, out negated bool) PatternSyntax {
                var pattern = pattern
                negated = false
                while true {
                    if pattern is ParenthesizedPatternSyntax parenthesized {
                        pattern = parenthesized.Pattern
                        continue
                    }
                    if pattern is UnaryPatternSyntax unary && unary.OperatorToken.IsKind(SyntaxKind.NotKeyword) {
                        negated = !negated
                        pattern = unary.Pattern
                        continue
                    }
                    return pattern
                }
            }

            // The statements after `ifStatement` in its enclosing statement list.
            // Only a direct child of a block (or switch section) leaks in G#; an
            // `else if` never does, because the outer condition's other path
            // reaches the following statements without the match.
            private func AddFollowingStatements(ifStatement IfStatementSyntax, regions List[SyntaxNode]) {
                var statements SyntaxList[StatementSyntax]
                switch ifStatement.Parent {
                    case block is BlockSyntax {
                        statements = block.Statements
                    }
                    case section is SwitchSectionSyntax {
                        statements = section.Statements
                    }
                    default {
                        return
                    }
                }
                var after = false
                for statement in statements {
                    if after {
                        regions.Add(statement)
                    } else if statement == ifStatement {
                        after = true
                    }
                }
            }
        }
    }
}
