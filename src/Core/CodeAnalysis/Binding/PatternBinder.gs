// <copyright file="PatternBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Numerics
import System.Reflection
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis
import System.Globalization
import System.Threading

internal enum PatternBindingContext {
    Allowed,
    OrOrNot,
    IsExpression,
    NegatedIsExpression
}

/// PR-B-5: the binder-side facade that owns the per-pattern-kind
/// binding methods. Routes (cref:PatternSyntax) to the
/// appropriate per-kind binder and produces the corresponding
/// (cref:BoundPattern). Wraps (cref:BindConstantPattern),
/// (cref:BindTypePattern), (cref:BindPropertyPattern),
/// (cref:BindRelationalPattern), and (cref:BindListPattern)
/// that previously lived directly on (cref:Binder).
/// @remarks This type is the binder-side wrapper: it consumes
/// (cref:BinderContext) for the diagnostics bag and the
/// (mutable) Scope used by (cref:BindTypePattern) to declare
/// the bound variable, and (cref:ConversionClassifier) for the
/// relational-pattern argument conversion. It never back-references
/// (cref:Binder); the callbacks it needs (re-binding a
/// sub-expression for constant patterns, binding a type clause for
/// type patterns, and the nil-literal test for nullable constant
/// patterns) are injected through narrow (cref:Func{T, TResult})
/// seams in the constructor — the same pattern established by
/// (cref:ConversionClassifier) in PR-B-3 and
/// (cref:OverloadResolver) in PR-B-4.
///
/// Switch-statement / switch-expression glue (binding the
/// discriminant, walking the arm list, exhaustiveness reporting via
/// (cref:ExhaustivenessAnalyzer), narrowing-frame management,
/// per-arm result conversion) deliberately stays on (cref:Binder)
/// for this PR and will land in PR-B-7 (`StatementBinder`) and
/// PR-B-9 (`ExpressionBinder`). This class focuses strictly on
/// per-pattern binding so its surface area stays small.
///
/// The discard-pattern case is inlined in the pattern-dispatch method's
/// dispatch — it has no logic beyond constructing a
/// `BoundDiscardPattern` with the discriminant type, so it
/// leaves with the dispatch method rather than warranting a per-kind
/// helper. (cref:ExhaustivenessAnalyzer) is already a separate
/// file and is not touched.
internal class PatternBinder {
    private let binderCtx BinderContext
    private let conversions ConversionClassifier
    private let bindExpression(ExpressionSyntax) -> BoundExpression
    private let bindTypeClause(TypeClauseSyntax) -> TypeSymbol?
    private let isNilLiteral(BoundExpression) -> bool
    private var currentPatternInput TypeSymbol?

    /// Initializes a new instance of the (cref:PatternBinder)
    /// class.
    /// @param binderCtx The shared binder context that exposes
    /// the diagnostics bag and the (mutable) root/current Scope.
    /// @param conversions The binder-side conversion classifier
    /// used to convert the right-hand-side expression of a relational
    /// pattern to the discriminant type.
    /// @param bindExpression Callback to bind the right-hand-
    /// side expression of a constant pattern through the still-on-
    /// Binder expression-binding entry point.
    /// @param bindTypeClause Callback to bind the type clause
    /// of a type pattern to a (cref:TypeSymbol).
    /// @param isNilLiteral Callback that tests whether a bound
    /// expression is a `nil` literal (possibly through one or
    /// more (cref:BoundConversionExpression) wrappers). Used by
    /// (cref:BindConstantPattern) when the discriminant is a
    /// nullable type to pick the right comparison operand type.
    init(
        binderCtx BinderContext,
        conversions ConversionClassifier,
        bindExpression(ExpressionSyntax) -> BoundExpression,
        bindTypeClause(TypeClauseSyntax) -> TypeSymbol?,
        isNilLiteral(BoundExpression) -> bool
    ) {
        this.binderCtx = binderCtx ?? throw ArgumentNullException("binderCtx")
        this.conversions = conversions ?? throw ArgumentNullException("conversions")
        this.bindExpression = bindExpression ?? throw ArgumentNullException("bindExpression")
        this.bindTypeClause = bindTypeClause ?? throw ArgumentNullException("bindTypeClause")
        this.isNilLiteral = isNilLiteral ?? throw ArgumentNullException("isNilLiteral")
    }

    private prop Diagnostics DiagnosticBag -> binderCtx.Diagnostics
    private prop Scope BoundScope -> binderCtx.RootScope

    /// Binds a pattern syntax node to the appropriate
    /// (cref:BoundPattern) for the supplied discriminant type.
    /// Dispatches to the per-kind binder ((cref:BindConstantPattern),
    /// (cref:BindTypePattern), (cref:BindPropertyPattern),
    /// (cref:BindRelationalPattern), (cref:BindListPattern))
    /// based on (cref:SyntaxNode.Kind). The discard-pattern case
    /// is inlined here because it has no per-kind logic beyond
    /// constructing the bound node.
    /// @param syntax The pattern syntax node to bind.
    /// @param discriminantType The type of the switch
    /// discriminant against which this pattern is matched.
    /// @returns The bound pattern.
    func BindPattern(syntax PatternSyntax, discriminantType TypeSymbol) BoundPattern {
        return BindPattern(syntax, discriminantType, PatternBindingContext.Allowed, preferTypeNames: false)
    }

    /// Binds a pattern with an explicit binding policy and bare-name preference.
    /// @param syntax The pattern syntax.
    /// @param discriminantType The tested value type.
    /// @param allowBindings Whether source-visible pattern bindings are allowed.
    /// @param preferTypeNames Whether an ambiguous bare name resolves as a type before a value.
    /// @returns The bound pattern.
    func BindPattern(
        syntax PatternSyntax,
        discriminantType TypeSymbol,
        allowBindings bool,
        preferTypeNames bool
    ) BoundPattern {
        return BindPattern(
            syntax,
            discriminantType,
            if allowBindings {
                PatternBindingContext.Allowed
            } else {
                PatternBindingContext.IsExpression
            },
            preferTypeNames
        )
    }

    private func BindPattern(
        syntax PatternSyntax,
        discriminantType TypeSymbol,
        bindingContext PatternBindingContext,
        preferTypeNames bool
    ) BoundPattern {
        if currentPatternInput is {} parent && NativeProtocolOperations.GetProtocol(discriminantType) is {} protocol &&
            NativeProtocolOperations.GetProtocol(parent) != protocol {
            Diagnostics.ReportNativeProtocol(
                syntax.Location,
                "nested native pattern inputs require an explicit intermediate protocol view"
            )
            return BoundDiscardPattern(syntax, discriminantType)
        }
        let previous = currentPatternInput
        currentPatternInput = discriminantType
        try {
            // Preserve the dispatch-level anchor for semantic-model queries.
            let result = BindPatternCore(syntax, discriminantType, bindingContext, preferTypeNames)
            result.AnchorSyntax(syntax)
            return result
        } finally {
            currentPatternInput = previous
        }
    }

    private func BindPatternCore(
        syntax PatternSyntax,
        discriminantType TypeSymbol,
        bindingContext PatternBindingContext,
        preferTypeNames bool
    ) BoundPattern {
        switch syntax.Kind {
            case SyntaxKind.ConstantPattern {
                return BindConstantPattern(cast[ConstantPatternSyntax](syntax), discriminantType)
            }
            case SyntaxKind.TypeOrConstantPattern {
                return BindTypeOrConstantPattern(
                    cast[TypeOrConstantPatternSyntax](syntax),
                    discriminantType,
                    bindingContext,
                    preferTypeNames
                )
            }
            case SyntaxKind.DiscardPattern {
                return BoundDiscardPattern(syntax, discriminantType)
            }
            case SyntaxKind.VarPattern {
                return BindVarPattern(cast[VarPatternSyntax](syntax), discriminantType, bindingContext)
            }
            case SyntaxKind.TypePattern {
                return BindTypePattern(
                    cast[TypePatternSyntax](syntax),
                    discriminantType,
                    bindingContext,
                    preferTypeNames
                )
            }
            case SyntaxKind.PropertyPattern {
                let propertySyntax = cast[PropertyPatternSyntax](syntax)
                if propertySyntax.Designation != nil {
                    return BindDesignatedPropertyPattern(
                        propertySyntax,
                        discriminantType,
                        bindingContext,
                        preferTypeNames
                    )
                }
                return BindPropertyPattern(propertySyntax, discriminantType, bindingContext, preferTypeNames)
            }
            case SyntaxKind.RelationalPattern {
                return BindRelationalPattern(cast[RelationalPatternSyntax](syntax), discriminantType)
            }
            case SyntaxKind.ListPattern {
                return BindListPattern(
                    cast[ListPatternSyntax](syntax),
                    discriminantType,
                    bindingContext,
                    preferTypeNames
                )
            }
            case SyntaxKind.BinaryPattern {
                return BindBinaryPattern(
                    cast[BinaryPatternSyntax](syntax),
                    discriminantType,
                    bindingContext,
                    preferTypeNames
                )
            }
            case SyntaxKind.NotPattern {
                return BindNotPattern(cast[NotPatternSyntax](syntax), discriminantType, bindingContext, preferTypeNames)
            }
            case SyntaxKind.ParenthesizedPattern {
                return BindPattern(
                    (cast[ParenthesizedPatternSyntax](syntax)).Pattern,
                    discriminantType,
                    bindingContext,
                    preferTypeNames
                )
            }
            default {
                throw Exception("Unexpected pattern syntax ${syntax.Kind}")
            }
        }
    }

    private func BindVarPattern(
        syntax VarPatternSyntax,
        discriminantType TypeSymbol,
        bindingContext PatternBindingContext
    ) BoundPattern {
        if syntax.Designation.Text == "_" {
            return BoundDiscardPattern(syntax, discriminantType)
        }
        let isExpressionBinding = bindingContext == PatternBindingContext.IsExpression ||
            bindingContext == PatternBindingContext.NegatedIsExpression
        let variable = CreatePatternVariable(
            syntax.Designation.Text,
            discriminantType,
            syntax.Designation,
            isExpressionBinding
        )
        variable.HasDefinitelyNonNullValue = false
        if bindingContext == PatternBindingContext.Allowed {
            if !Scope.TryDeclareVariable(variable) {
                Diagnostics.ReportSymbolAlreadyDeclared(syntax.Designation.Location, syntax.Designation.Text)
            }
        } else if bindingContext == PatternBindingContext.OrOrNot {
            Diagnostics.ReportPatternVariableNotAllowedUnderOrNot(syntax.Designation.Location, syntax.Designation.Text)
        }
        return BoundDiscardPattern(syntax, discriminantType, variable)
    }

    // Issue #992: a conjunction (`and`) keeps bindings (both sub-patterns must
    // match, so a variable bound on either side is definitely assigned). A
    // disjunction (`or`) forbids bindings on both sides.
    private func BindBinaryPattern(
        syntax BinaryPatternSyntax,
        discriminantType TypeSymbol,
        bindingContext PatternBindingContext,
        preferTypeNames bool
    ) BoundPattern {
        let isConjunction = syntax.OperatorToken.Text == "and"
        let childBindingContext = if !isConjunction {
            PatternBindingContext.OrOrNot
        } else {
            bindingContext
        }
        let left = BindPattern(syntax.Left, discriminantType, childBindingContext, preferTypeNames)
        var rightInputType = discriminantType
        var rightInputVariable LocalVariableSymbol? = nil
        if isConjunction && TryGetGuaranteedNarrowingValue(left, out var narrowedVariable) {
            rightInputVariable = narrowedVariable
            rightInputType = narrowedVariable!!.Type
        }
        let right = BindPattern(syntax.Right, rightInputType, childBindingContext, preferTypeNames)
        return BoundBinaryPattern(syntax, discriminantType, isConjunction, left, right, rightInputVariable)
    }

    // Issue #992 / ADR-0166: switch patterns and nested `not` patterns forbid
    // bindings. A direct designation in `value is not T name` is assigned on
    // the false edge of the is-expression and is therefore permitted.
    private func BindNotPattern(
        syntax NotPatternSyntax,
        discriminantType TypeSymbol,
        bindingContext PatternBindingContext,
        preferTypeNames bool
    ) BoundPattern {
        // Non-nullable CLR values cannot match nil, so `not nil` is a total
        // boolean pattern. Keep switch diagnostics unchanged.
        if bindingContext == PatternBindingContext.IsExpression && Binder.IsNonNullableValueTypeForConstraint(
            discriminantType
        ) &&
            IsNilPattern(syntax.Pattern) {
            return BoundDiscardPattern(syntax, discriminantType)
        }
        let childBindingContext = if bindingContext == PatternBindingContext.IsExpression &&
            HasDirectDesignation(syntax.Pattern) {
            PatternBindingContext.NegatedIsExpression
        } else {
            PatternBindingContext.OrOrNot
        }
        let operand = BindPattern(syntax.Pattern, discriminantType, childBindingContext, preferTypeNames)
        return BoundNotPattern(syntax, discriminantType, operand)
    }

    private func BindConstantPattern(
        syntax ConstantPatternSyntax,
        discriminantType TypeSymbol
    ) BoundPattern -> BindConstantPatternWithResolution(syntax, discriminantType, out _)

    private func BindConstantPatternWithResolution(
        syntax ConstantPatternSyntax,
        discriminantType TypeSymbol,
        out expressionResolved bool
    ) BoundPattern {
        var expression = bindExpression(syntax.Expression)
        expressionResolved = !(expression is BoundErrorExpression) && expression.Type != TypeSymbol.Error
        if ByteStringTypes.IsDefinition(expression.Type.ClrType) {
            Diagnostics.ReportSwitchCaseValueNotConstant(syntax.Expression.Location)
            return BoundConstantPattern(syntax, discriminantType, BoundErrorExpression(syntax))
        }
        // Issue #1157: adapt a constant integer LITERAL case label that fits the
        // discriminant's integer type to that type, mirroring the constant
        // adaptation #1144 restored for binary operators. Without this, a literal
        // like `0` (typed int32) on a `uint8` switch is a narrowing conversion and
        // would be rejected with GS0171 even though it clearly fits. A nullable
        // discriminant targets its underlying type; out-of-range labels are left
        // untouched so the existing GS0171 path still fires.
        let adaptTarget = if discriminantType is NullableTypeSymbol nullableTarget {
            nullableTarget.UnderlyingType
        } else {
            discriminantType
        }
        if ExpressionBinder.IsIntegerType(adaptTarget) &&
            expression.Type != adaptTarget &&
            TryGetConstantIntegerLiteralValue(expression, out var literalValue) &&
            ExpressionBinder
            .TryAdaptIntegerLiteral(literalValue, adaptTarget, out var adaptedValue) {
            expression = BoundLiteralExpression(syntax.Expression, adaptedValue)
        }
        // A successful type pattern can narrow `object` to a non-nullable
        // reference type before the right side of `and` is bound. Keep
        // `T and not nil` legal in that narrowed context: nil can still be
        // tested at runtime even though the static annotation is non-nullable.
        if isNilLiteral(expression) && IsNonNullableReferencePatternInput(discriminantType) {
            return BoundConstantPattern(syntax, discriminantType, expression)
        }
        let conversion = Conversion.Classify(expression.Type, discriminantType)
        if !conversion.Exists || conversion.IsExplicit {
            if expression.Type != TypeSymbol.Error && discriminantType != TypeSymbol.Error {
                Diagnostics.ReportSwitchCaseTypeMismatch(syntax.Expression.Location, expression.Type, discriminantType)
            }
            return BoundConstantPattern(syntax, discriminantType, BoundErrorExpression(syntax))
        }
        // Issue #2072: route the nil-arm conversion through the same
        // classifier entry point used everywhere else (`ConversionClassifier.
        // BindConversion`) instead of constructing a bare
        // BoundConversionExpression. That entry point owns the issue #504
        // lowering of `nil -> Nullable<value-type>` to a BoundDefaultExpression
        // (required because value-type Nullable<T> can't take `ldnull`); building
        // the conversion node directly here bypassed that lowering and crashed
        // emit with GS9998 on `case nil:` against a value-type Nullable<T>
        // discriminant.
        let value = if conversion.IsIdentity {
            expression
        } else {
            conversions.BindConversion(syntax.Expression.Location, expression, discriminantType)
        }
        var op BoundBinaryOperator? = BoundBinaryOperator.Bind(
            SyntaxKind.EqualsEqualsToken,
            discriminantType,
            discriminantType
        )
        if op == nil && discriminantType is NullableTypeSymbol nullable {
            let comparisonType = if isNilLiteral(expression) {
                TypeSymbol.Null
            } else {
                nullable.UnderlyingType
            }
            op = BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, discriminantType, comparisonType) ??
                BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, nullable.UnderlyingType, nullable.UnderlyingType)
        }
        if op == nil && expression.Type != TypeSymbol.Error {
            Diagnostics.ReportSwitchCaseTypeMismatch(syntax.Expression.Location, expression.Type, discriminantType)
        }
        return BoundConstantPattern(syntax, discriminantType, value)
    }

    private func BindTypeOrConstantPattern(
        syntax TypeOrConstantPatternSyntax,
        discriminantType TypeSymbol,
        bindingContext PatternBindingContext,
        preferTypeNames bool
    ) BoundPattern {
        if syntax.PropertyPattern != nil {
            return BindBareTypePattern(
                syntax,
                syntax.CandidateType,
                syntax.PropertyPattern,
                discriminantType,
                bindingContext,
                preferTypeNames
            )
        }
        let diagnosticMark = Diagnostics.Count
        if preferTypeNames {
            let typePattern = BindBareTypePattern(
                syntax,
                syntax.CandidateType,
                propertyPattern: nil,
                discriminantType,
                bindingContext,
                preferTypeNames
            )
            if typePattern.TargetType != TypeSymbol.Error {
                return typePattern
            }
            Diagnostics.TruncateTo(diagnosticMark)
            let constantPattern = BindConstantPatternWithResolution(
                ConstantPatternSyntax(syntax.SyntaxTree, syntax.Expression),
                discriminantType,
                out var valueResolved
            )
            if valueResolved {
                return constantPattern
            }
            Diagnostics.TruncateTo(diagnosticMark)
            // Both interpretations failed. Prefer the value-resolution error
            // over a misleading "missing type/import" diagnostic.
            return BindConstantPattern(ConstantPatternSyntax(syntax.SyntaxTree, syntax.Expression), discriminantType)
        }
        let valuePattern = BindConstantPatternWithResolution(
            ConstantPatternSyntax(syntax.SyntaxTree, syntax.Expression),
            discriminantType,
            out var resolved
        )
        if resolved {
            return valuePattern
        }
        Diagnostics.TruncateTo(diagnosticMark)
        let fallbackTypePattern = BindBareTypePattern(
            syntax,
            syntax.CandidateType,
            propertyPattern: nil,
            discriminantType,
            bindingContext,
            preferTypeNames
        )
        if fallbackTypePattern.TargetType != TypeSymbol.Error {
            return fallbackTypePattern
        }
        Diagnostics.TruncateTo(diagnosticMark)
        return BindConstantPattern(ConstantPatternSyntax(syntax.SyntaxTree, syntax.Expression), discriminantType)
    }

    private func BindTypePattern(
        syntax TypePatternSyntax,
        discriminantType TypeSymbol,
        bindingContext PatternBindingContext,
        preferTypeNames bool
    ) BoundTypePattern {
        let targetType = bindTypeClause(syntax.Type) ?? TypeSymbol.Error
        return BindTypePatternCore(
            syntax,
            syntax.Identifier,
            syntax.Designation,
            targetType,
            syntax.PropertyPattern,
            discriminantType,
            bindingContext,
            preferTypeNames
        )
    }

    private func BindBareTypePattern(
        syntax SyntaxNode,
        type TypeClauseSyntax,
        propertyPattern PropertyPatternSyntax?,
        discriminantType TypeSymbol,
        bindingContext PatternBindingContext,
        preferTypeNames bool
    ) BoundTypePattern {
        let targetType = bindTypeClause(type) ?? TypeSymbol.Error
        return BindTypePatternCore(
            syntax,
            identifier: nil,
            designation: nil,
            targetType,
            propertyPattern,
            discriminantType,
            bindingContext,
            preferTypeNames
        )
    }

    /// Binds a type test with an optional pattern variable. [`identifier`](paramref)
    /// is the switch binding spelling (`name is T`); [`designation`](paramref)
    /// is the ADR-0166 designation spelling (`T name`, `{ ... } name`).
    private func BindTypePatternCore(
        syntax SyntaxNode,
        identifier SyntaxToken?,
        designation SyntaxToken?,
        targetType TypeSymbol,
        propertyPattern PropertyPatternSyntax?,
        discriminantType TypeSymbol,
        bindingContext PatternBindingContext,
        preferTypeNames bool
    ) BoundTypePattern {
        var targetType = targetType
        if (
            bindingContext == PatternBindingContext.IsExpression ||
                bindingContext == PatternBindingContext.NegatedIsExpression
        ) &&
            targetType is NullableTypeSymbol nullableTarget {
            targetType = nullableTarget.UnderlyingType
        }
        let nameToken SyntaxToken? = identifier ?? designation
        let bindingIdentifier SyntaxToken? = if nameToken != nil && nameToken.ValueText != "_" {
            nameToken
        } else {
            default(SyntaxToken?)
        }
        let hasBinding = bindingIdentifier != nil
        let variableName = bindingIdentifier?.Text ?? "<type-pattern-value>"
        let isExpressionBinding = hasBinding &&
            (
            bindingContext == PatternBindingContext.IsExpression ||
                bindingContext == PatternBindingContext.NegatedIsExpression
        )
        let variable = CreatePatternVariable(variableName, targetType, nameToken, isExpressionBinding)
        if bindingIdentifier != nil {
            if bindingContext == PatternBindingContext.Allowed {
                if !Scope.TryDeclareVariable(variable) {
                    Diagnostics.ReportSymbolAlreadyDeclared(bindingIdentifier.Location, bindingIdentifier.ValueText)
                }
            } else if bindingContext == PatternBindingContext.OrOrNot {
                // Issue #992: a type pattern that introduces a binding variable is
                // not allowed under `or` / `not` — the variable would not be
                // definitely assigned. The discard identifier `_` is permitted.
                Diagnostics.ReportPatternVariableNotAllowedUnderOrNot(
                    bindingIdentifier.Location,
                    bindingIdentifier.ValueText
                )
            } else if bindingContext == PatternBindingContext.IsExpression && identifier != nil {
                // ADR-0166: only the designation spelling introduces a pattern
                // variable in a boolean `is`; `value is text is string` keeps
                // reading as an incoherent double test.
                Diagnostics.ReportPatternBindingNotAllowedInIsExpression(
                    bindingIdentifier.Location,
                    bindingIdentifier.ValueText
                )
            }
            // ADR-0166: a designation in a boolean `is` is declared by the
            // consumer of the condition (see PatternVariables), not here.

        }
        let nestedBindingContext = if bindingContext == PatternBindingContext.NegatedIsExpression {
            PatternBindingContext.OrOrNot
        } else {
            bindingContext
        }
        let boundProperty = if propertyPattern == nil {
            default(BoundPropertyPattern?)
        } else {
            BindPropertyPattern(propertyPattern, targetType, nestedBindingContext, preferTypeNames)
        }
        return BoundTypePattern(syntax, discriminantType, targetType, variable, hasBinding, boundProperty)
    }

    /// ADR-0166: `{ ... } name` binds the matched, non-nil input at the
    /// input's non-nullable type. It is bound as a type pattern over the
    /// stripped input type — the C# semantics — so emission and narrowing reuse
    /// the type-pattern pipeline unchanged.
    private func BindDesignatedPropertyPattern(
        syntax PropertyPatternSyntax,
        discriminantType TypeSymbol,
        bindingContext PatternBindingContext,
        preferTypeNames bool
    ) BoundPattern {
        let targetType = if discriminantType is NullableTypeSymbol nullable {
            nullable.UnderlyingType
        } else {
            discriminantType
        }
        return BindTypePatternCore(
            syntax,
            identifier: nil,
            syntax.Designation,
            targetType,
            syntax,
            discriminantType,
            bindingContext,
            preferTypeNames
        )
    }

    private func BindPropertyPattern(
        syntax PropertyPatternSyntax,
        discriminantType TypeSymbol,
        bindingContext PatternBindingContext,
        preferTypeNames bool
    ) BoundPropertyPattern {
        let fields = ImmutableArray.CreateBuilder[BoundPropertyPatternField]()
        // Recursive property patterns never match null. Member lookup therefore
        // runs against the non-null underlying type for both nullable references
        // and Nullable<T>; emitter/evaluator perform the corresponding guard.
        let lookupType = if discriminantType is NullableTypeSymbol nullableDiscriminant {
            nullableDiscriminant.UnderlyingType
        } else {
            discriminantType
        }
        // Issue #1887: cs2gs lowers a C# positional pattern over a raw tuple
        // subject (`(0, 0) => ...`) to a G# property pattern keyed on the
        // tuple's always-present Item1..ItemN fields (`{ Item1: 0, Item2: 0 }`).
        // A ValueTuple is neither a StructSymbol nor a class, so it needs its
        // own lookup path alongside the struct/class one below.
        if lookupType is TupleTypeSymbol tupleType {
            for tupleFieldSyntax in syntax.Fields {
                if !TryGetTupleField(tupleType, tupleFieldSyntax.Identifier.ValueText, out var tupleField) ||
                    tupleField == nil {
                    Diagnostics.ReportUndefinedFieldOnType(
                        tupleFieldSyntax.Identifier.Location,
                        tupleFieldSyntax.Identifier.ValueText,
                        discriminantType
                    )
                    fields.Add(
                        BoundPropertyPatternField(
                            syntax,
                            FieldSymbol(tupleFieldSyntax.Identifier.ValueText, TypeSymbol.Error, Accessibility.Public),
                            BindPattern(tupleFieldSyntax.Pattern, TypeSymbol.Error, bindingContext, preferTypeNames)
                        )
                    )
                    continue
                }
                fields.Add(
                    BoundPropertyPatternField(
                        syntax,
                        tupleField,
                        BindPattern(tupleFieldSyntax.Pattern, tupleField.Type, bindingContext, preferTypeNames)
                    )
                )
            }
            return BoundPropertyPattern(syntax, discriminantType, fields.ToImmutable())
        }
        // ADR-0166: the empty property pattern `{ }` is a pure non-nil test
        // (C# semantics) and applies to every input type; only a member list
        // needs a struct, class, interface, or tuple to look members up on.
        if syntax.Fields.Count > 0 && !SupportsPropertyPattern(lookupType) {
            Diagnostics.ReportPropertyPatternRequiresStructOrClass(syntax.OpenBraceToken.Location, discriminantType)
            return BoundPropertyPattern(syntax, discriminantType, fields.ToImmutable())
        }
        for fieldSyntax in syntax.Fields {
            if !TryBindPropertyPatternMember(lookupType, fieldSyntax, bindingContext, preferTypeNames, out var field) ||
                field == nil {
                Diagnostics.ReportUndefinedFieldOnType(
                    fieldSyntax.Identifier.Location,
                    fieldSyntax.Identifier.ValueText,
                    discriminantType
                )
                fields.Add(
                    BoundPropertyPatternField(
                        syntax,
                        FieldSymbol(fieldSyntax.Identifier.ValueText, TypeSymbol.Error, Accessibility.Public),
                        BindPattern(fieldSyntax.Pattern, TypeSymbol.Error, bindingContext, preferTypeNames)
                    )
                )
                continue
            }
            fields.Add(field)
        }
        return BoundPropertyPattern(syntax, discriminantType, fields.ToImmutable())
    }

    private func TryBindPropertyPatternMember(
        lookupType TypeSymbol,
        syntax PropertyPatternFieldSyntax,
        bindingContext PatternBindingContext,
        preferTypeNames bool,
        out boundField BoundPropertyPatternField?
    ) bool {
        boundField = nil
        let name = syntax.Identifier.ValueText
        if lookupType is StructSymbol structType {
            for current in structType.GetHierarchy() {
                for field in current.Fields {
                    if field.Name == name {
                        boundField = BoundPropertyPatternField(
                            syntax,
                            field,
                            current,
                            BindPattern(syntax.Pattern, field.Type, bindingContext, preferTypeNames)
                        )
                        return true
                    }
                }
                for property in current.Properties {
                    if property.Name != name {
                        continue
                    }
                    if property.IsIndexer || property.IsStatic || !property.HasGetter {
                        return false
                    }
                    boundField = BoundPropertyPatternField(
                        syntax,
                        property,
                        current,
                        BindPattern(syntax.Pattern, property.Type, bindingContext, preferTypeNames)
                    )
                    return true
                }
            }
            let importedBase = TypeMemberModel.GetNearestImportedBase(structType)
            if importedBase?.ClrType != nil &&
                TryBindClrPropertyPatternMember(
                importedBase!!,
                importedBase!!.ClrType!!,
                syntax,
                bindingContext,
                preferTypeNames,
                out boundField
            ) {
                return true
            }
        } else if lookupType is InterfaceSymbol interfaceType {
            for current in interfaceType.SelfAndAllBaseInterfaces() {
                current.EnsureMembersResolved()
                for property in current.Properties {
                    if property.Name != name {
                        continue
                    }
                    if property.IsIndexer || property.IsStatic || !property.HasGetter {
                        boundField = nil
                        return false
                    }
                    boundField = BoundPropertyPatternField(
                        syntax,
                        property,
                        current,
                        BindPattern(syntax.Pattern, property.Type, bindingContext, preferTypeNames)
                    )
                    return true
                }
            }
            for importedBase in MemberLookup.GetTransitiveClrBaseInterfaces(interfaceType) {
                let importedBaseType = ImportedTypeSymbol.GetWithoutNullability(
                    importedBase,
                    NullabilityFreeReason.TypeStructure
                )
                if TryBindClrPropertyPatternMember(
                    importedBaseType,
                    importedBase,
                    syntax,
                    bindingContext,
                    preferTypeNames,
                    out boundField
                ) {
                    return true
                }
            }
        } else if lookupType.ClrType is Type clrType &&
            TryBindClrPropertyPatternMember(
            lookupType,
            clrType,
            syntax,
            bindingContext,
            preferTypeNames,
            out boundField
        ) {
            return true
        }
        let directClrType Type? = lookupType.ClrType
        if directClrType != nil &&
            TryBindClrPropertyPatternMember(
            lookupType,
            directClrType,
            syntax,
            bindingContext,
            preferTypeNames,
            out boundField
        ) {
            return true
        }
        boundField = nil
        return false
    }

    private func TryBindClrPropertyPatternMember(
        receiverType TypeSymbol,
        clrType Type,
        syntax PropertyPatternFieldSyntax,
        bindingContext PatternBindingContext,
        preferTypeNames bool,
        out boundField BoundPropertyPatternField?
    ) bool {
        let name = syntax.Identifier.ValueText
        let property PropertyInfo? = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(
            clrType,
            name,
            BindingFlags.Public | BindingFlags.Instance
        )
        if property != nil {
            if property.GetIndexParameters().Length != 0 || property.GetGetMethod(nonPublic: false) == nil {
                boundField = nil
                return false
            }
            let propertyType = MemberLookup.GetClrPropertyTypeSymbol(receiverType, property)
            boundField = BoundPropertyPatternField(
                syntax,
                property,
                propertyType,
                BindPattern(syntax.Pattern, propertyType, bindingContext, preferTypeNames)
            )
            return true
        }
        let field FieldInfo? = ClrTypeUtilities.SafeGetFieldIncludingInterfaces(
            clrType,
            name,
            BindingFlags.Public | BindingFlags.Instance
        )
        if field != nil {
            let fieldType = ClrNullability.GetFieldTypeSymbol(field)
            boundField = BoundPropertyPatternField(
                syntax,
                field,
                fieldType,
                BindPattern(syntax.Pattern, fieldType, bindingContext, preferTypeNames)
            )
            return true
        }
        boundField = nil
        return false
    }

    private func BindRelationalPattern(syntax RelationalPatternSyntax, discriminantType TypeSymbol) BoundPattern {
        let value = conversions.BindConversion(syntax.Expression, discriminantType, allowExplicit: false)
        var op BoundBinaryOperator? = BoundBinaryOperator.Bind(
            syntax.OperatorToken.Kind,
            discriminantType,
            discriminantType
        )
        if op == nil {
            Diagnostics.ReportRelationalPatternOperatorUndefined(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Kind,
                discriminantType
            )
            op = BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)
        }
        return BoundRelationalPattern(
            syntax,
            discriminantType,
            op ?? throw InvalidOperationException("A relational pattern operator must be available."),
            value
        )
    }

    private func BindListPattern(
        syntax ListPatternSyntax,
        discriminantType TypeSymbol,
        bindingContext PatternBindingContext,
        preferTypeNames bool
    ) BoundPattern {
        // Issue #1951: accept any array-shaped discriminant, not just the
        // in-compilation ArrayTypeSymbol/SliceTypeSymbol — a metadata/CLR
        // array (e.g. the type of `Array.Empty<int>()`, or any imported
        // BCL `T[]`) is genuinely array-shaped too. Reuse the same
        // recognition ExpressionBinder uses for array/span slicing.
        var elementType = ExpressionBinder.GetArraySliceElementType(discriminantType) ?? TypeSymbol.Error
        // Issue #3501: an indexable non-array discriminant — anything with an
        // int32 `Length`/`Count` getter and a `this[int]` indexer, e.g.
        // `ImmutableArray[T]` — also supports the fixed-length list pattern.
        // The rest subpattern must be a pure `..` discard (there is no cheap
        // middle-slice materialization for an arbitrary indexable).
        var lengthProperty PropertyInfo? = nil
        var indexerProperty PropertyInfo? = nil
        var inputVariable LocalVariableSymbol? = nil
        // The discriminant may reach here wrapped in a nullability
        // annotation (NRT-annotated member reads); the indexable probe cares
        // only about the underlying imported construction.
        let indexableSource = if discriminantType is NullabilityAnnotatedTypeSymbol annotatedIndexable {
            annotatedIndexable.BaseType
        } else {
            discriminantType
        }
        if elementType == TypeSymbol.Error &&
            indexableSource is ImportedTypeSymbol importedIndexable &&
            importedIndexable.ClrType is Type indexableClr {
            let length PropertyInfo? = FindIntGetter(indexableClr, "Length") ?? FindIntGetter(indexableClr, "Count")
            let indexer PropertyInfo? = indexableClr.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(
                (p PropertyInfo) -> p.GetIndexParameters() is {Length: 1} indexParams &&
                    indexParams[0]
                    .ParameterType
                    .IsSameAs(typeof(int32)) && p.GetGetMethod(nonPublic: false) != nil
            )
            if length != nil && indexer != nil {
                elementType = if NativeSliceTypes.TryGetElement(discriminantType, out var nativeElement, out _) {
                    nativeElement!!
                } else {
                    ExpressionBinder.MapErasedIndexerElementType(importedIndexable, indexer)
                }
                if elementType is ByRefTypeSymbol byRefElement {
                    elementType = byRefElement.PointeeType
                }
                lengthProperty = length
                indexerProperty = indexer
                let inputName = "$$list_input" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
                    CultureInfo.InvariantCulture
                )
                inputVariable = LocalVariableSymbol(inputName, isReadOnly: true, type: discriminantType)
                Scope.TryDeclareVariable(inputVariable)
                for elementSyntax in syntax.Elements {
                    if elementSyntax is SlicePatternSyntax sliceSyntax &&
                        (sliceSyntax.Pattern != nil || sliceSyntax.CaptureIdentifier != nil) &&
                        !NativeSliceTypes
                        .TryGetElement(discriminantType, out _, out _) {
                        Diagnostics.ReportListPatternRequiresArrayOrSlice(
                            sliceSyntax.DotDotToken.Location,
                            discriminantType
                        )
                    }
                }
            }
        }
        if elementType == TypeSymbol.Error {
            Diagnostics.ReportListPatternRequiresArrayOrSlice(syntax.OpenSquareBracketToken.Location, discriminantType)
        }
        let elements = ImmutableArray.CreateBuilder[BoundPattern]()
        var sliceCount = 0
        for elementSyntax in syntax.Elements {
            if elementSyntax is SlicePatternSyntax slice {
                // Issue #1505: at most one slice subpattern per list pattern.
                sliceCount++
                if sliceCount > 1 {
                    Diagnostics.ReportMultipleSlicePatternsInListPattern(slice.DotDotToken.Location)
                }
                elements.Add(BindSlicePattern(slice, discriminantType, elementType, bindingContext, preferTypeNames))
            } else {
                elements.Add(BindPattern(elementSyntax, elementType, bindingContext, preferTypeNames))
            }
        }
        return BoundListPattern(
            syntax,
            discriminantType,
            elements.ToImmutable(),
            elementType,
            lengthProperty,
            indexerProperty,
            inputVariable
        )
    }

    // Issue #1505: bind a slice ("rest") subpattern. A named capture (`..rest`)
    // declares a `[]T` variable bound to the middle slice. A sub-pattern
    // (`..[> 0]`) is materialized into a synthesized `[]T` local and matched
    // against the slice value. A pure discard (`..`) materializes nothing.
    private func BindSlicePattern(
        syntax SlicePatternSyntax,
        discriminantType TypeSymbol,
        elementType TypeSymbol,
        bindingContext PatternBindingContext,
        preferTypeNames bool
    ) BoundPattern {
        let sliceType = if elementType == TypeSymbol.Error {
            cast[TypeSymbol](TypeSymbol.Error)
        } else {
            (
                if NativeSliceTypes.TryGetElement(discriminantType, out _, out _) {
                    discriminantType
                } else {
                    cast[TypeSymbol](SliceTypeSymbol.Get(elementType))
                }
            )
        }
        var subPattern BoundPattern? = nil
        if syntax.Pattern != nil {
            subPattern = BindPattern(syntax.Pattern, sliceType, bindingContext, preferTypeNames)
        }
        var variable LocalVariableSymbol? = nil
        if syntax.CaptureIdentifier != nil {
            variable = CreatePatternVariable(
                syntax.CaptureIdentifier.ValueText,
                sliceType,
                syntax.CaptureIdentifier,
                isExpressionBinding: bindingContext == PatternBindingContext.IsExpression
            )
            if bindingContext == PatternBindingContext.Allowed {
                if !Scope.TryDeclareVariable(variable) {
                    Diagnostics.ReportSymbolAlreadyDeclared(
                        syntax.CaptureIdentifier!!.Location,
                        syntax.CaptureIdentifier!!.ValueText
                    )
                }
            } else if bindingContext == PatternBindingContext.OrOrNot {
                Diagnostics.ReportPatternVariableNotAllowedUnderOrNot(
                    syntax.CaptureIdentifier!!.Location,
                    syntax.CaptureIdentifier!!.ValueText
                )
            }
            // ADR-0166: a slice capture in a boolean `is` is scoped by the
            // consumer of the condition, like a type-pattern designation.

        } else if subPattern != nil {
            // A sub-pattern needs the materialized slice value but introduces no
            // user-visible binding; synthesize an internal local as its source.
            variable = LocalVariableSymbol("<slice>", isReadOnly: true, sliceType, declaringSyntax: syntax.DotDotToken)
        }
        return BoundSlicePattern(syntax, discriminantType, elementType, variable, subPattern)
    }

    shared {
        private func TryGetGuaranteedNarrowingValue(
            pattern BoundPattern,
            @NotNullWhen(true) out variable LocalVariableSymbol?
        ) bool {
            switch pattern {
                case typePattern is BoundTypePattern {
                    variable = typePattern.Variable
                    return true
                }
                case BoundBinaryPattern{IsConjunction: true} binary {
                    if TryGetGuaranteedNarrowingValue(binary.Right, out variable) {
                        return true
                    }
                    return TryGetGuaranteedNarrowingValue(binary.Left, out variable)
                }
                default {
                    variable = nil
                    return false
                }
            }
        }

        private func HasDirectDesignation(pattern PatternSyntax) bool -> pattern is TypePatternSyntax &&
            pattern.Designation != nil ||
            pattern is PropertyPatternSyntax &&
            pattern.Designation != nil

        private func IsNilPattern(syntax PatternSyntax) bool {
            var syntax = syntax
            while syntax is ParenthesizedPatternSyntax parenthesized {
                syntax = parenthesized.Pattern
            }
            return (syntax is ConstantPatternSyntax and {Expression: LiteralExpressionSyntax and {Value: nil}})
        }

        private func IsNonNullableReferencePatternInput(type TypeSymbol) bool {
            if type is NullableTypeSymbol {
                return false
            }
            if type is StructSymbol structType {
                return structType.IsClass
            }
            if type is InterfaceSymbol {
                return true
            }
            return type.ClrType is {IsValueType: false}
        }

        // Issue #1157: extract a compile-time constant INTEGER literal value from a
        // case-label expression. Accepts a bare integer literal or a unary `+` / `-`
        // applied to one (e.g. `case -1`), so a negative literal label can adapt to a
        // signed governing type. Named constants and other non-literal expressions are
        // deliberately excluded — only literal labels participate in adaptation.
        private func TryGetConstantIntegerLiteralValue(expression BoundExpression, out value object) bool {
            switch expression {
                case lit is BoundLiteralExpression when lit.Value != nil && ExpressionBinder.IsIntegerLiteralValue(
                    lit.Value
                ) {
                    value = lit.Value!!
                    return true
                }
                case unary is BoundUnaryExpression when unary
                    .Op
                    .Kind == BoundUnaryOperatorKind.Identity &&
                    TryGetConstantIntegerLiteralValue(unary.Operand, out var positive) {
                    value = positive
                    return true
                }
                case unary is BoundUnaryExpression when unary
                    .Op
                    .Kind == BoundUnaryOperatorKind.Negation &&
                    TryGetConstantIntegerLiteralValue(unary.Operand, out var operand) {
                    return TryNegateIntegerLiteral(operand, out value)
                }
            }
            value = 0
            return false
        }

        // Issue #1157: negate a boxed integer literal, re-boxing into the narrowest of
        // int64 / uint64 that holds the result. The boxed type only feeds
        // ExpressionBinder.TryAdaptIntegerLiteral (which range-checks via BigInteger),
        // so any integer carrier with the correct value suffices.
        private func TryNegateIntegerLiteral(value object, out negated object) bool {
            let result = -ToBigInteger(value)
            if result >= int64.MinValue && result <= int64.MaxValue {
                negated = int64(result)
                return true
            }
            if result >= uint64.MinValue && result <= uint64.MaxValue {
                negated = uint64(result)
                return true
            }
            negated = 0
            return false
        }

        private func ToBigInteger(value object) BigInteger {
            return switch value {
                case s is int8: BigInteger(s)
                case b is uint8: BigInteger(b)
                case s is int16: BigInteger(s)
                case u is uint16: BigInteger(u)
                case i is int32: BigInteger(i)
                case u is uint32: BigInteger(u)
                case l is int64: BigInteger(l)
                case u is uint64: BigInteger(u)
                case n is nint: BigInteger(int64(n))
                case n is nuint: BigInteger(uint64(n))
                default: default(BigInteger)
            }
        }

        /// ADR-0166: creates the local that receives a pattern's matched value. A
        /// designation bound in a boolean `is` is a
        /// (cref:PatternVariableSymbol) so later passes can recognise a
        /// single-assignment binding whose every visible use is dominated by the
        /// match (closure capture snapshots it instead of boxing it).
        private func CreatePatternVariable(
            name string,
            type TypeSymbol,
            declaringSyntax SyntaxToken?,
            isExpressionBinding bool
        ) LocalVariableSymbol -> if isExpressionBinding {
            cast[LocalVariableSymbol](PatternVariableSymbol(name, type, declaringSyntax))
        } else {
            LocalVariableSymbol(name, isReadOnly: true, type, declaringSyntax)
        }

        private func SupportsPropertyPattern(type TypeSymbol) bool {
            if type is StructSymbol || type is InterfaceSymbol || type is TupleTypeSymbol {
                return true
            }
            return type.ClrType is Type clrType && !clrType.IsPrimitive && !clrType.IsEnum
        }

        // Issue #1887: resolve a tuple's synthetic Item1..ItemN field by name so a
        // property/positional pattern (`{ Item1: 0, Item2: 0 }`) binds against a
        // ValueTuple subject the same way it does against a struct's real fields.
        private func TryGetTupleField(tupleType TupleTypeSymbol, name string, out field FieldSymbol?) bool {
            field = nil
            if name.Length <= 4 || !name.StartsWith("Item", StringComparison.Ordinal) {
                return false
            }
            if !int32.TryParse(name.AsSpan(4), out var index) || index < 1 || index > tupleType.Arity {
                return false
            }
            field = FieldSymbol(name, tupleType.ElementTypes[index - 1], Accessibility.Public)
            return true
        }

        private func FindIntGetter(type Type, name string) PropertyInfo? {
            // Metadata-context safe: never filter GetProperty by a runtime
            // typeof — a MetadataLoadContext Int32 is a different Type instance.
            let property PropertyInfo? = type.GetProperties(BindingFlags.Public | BindingFlags.Instance).FirstOrDefault(
                (p PropertyInfo) -> p.Name == name && p.GetIndexParameters().Length == 0 && p.PropertyType.IsSameAs(
                    typeof(int32)
                )
            )
            return if property?.GetGetMethod(nonPublic: false) != nil {
                property
            } else {
                default(PropertyInfo?)
            }
        }
    }
}
