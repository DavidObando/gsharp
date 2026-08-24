// <copyright file="PatternBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Numerics;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding.OverloadResolution;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

internal enum PatternBindingContext
{
    /// <summary>Bindings are permitted and declared in the current pattern scope.</summary>
    Allowed,

    /// <summary>Bindings are rejected because an <c>or</c> or <c>not</c> cannot definitely assign them.</summary>
    OrOrNot,

    /// <summary>
    /// ADR-0166: the pattern is the operand of a boolean <c>is</c> expression.
    /// Designation bindings (<c>T name</c>, <c>{ ... } name</c>, slice captures)
    /// are permitted but are not declared into a scope here; the consumer of
    /// the bound condition scopes them to the regions where the pattern is
    /// known to have matched (see <see cref="PatternVariables"/>). The switch
    /// binding spelling <c>name is T</c> stays rejected in this position.
    /// </summary>
    IsExpression,
}

/// <summary>
/// PR-B-5: the binder-side facade that owns the per-pattern-kind
/// binding methods. Routes <see cref="PatternSyntax"/> to the
/// appropriate per-kind binder and produces the corresponding
/// <see cref="BoundPattern"/>. Wraps <see cref="BindConstantPattern"/>,
/// <see cref="BindTypePattern"/>, <see cref="BindPropertyPattern"/>,
/// <see cref="BindRelationalPattern"/>, and <see cref="BindListPattern"/>
/// that previously lived directly on <see cref="Binder"/>.
/// </summary>
/// <remarks>
/// <para>
/// This type is the binder-side wrapper: it consumes
/// <see cref="BinderContext"/> for the diagnostics bag and the
/// (mutable) Scope used by <see cref="BindTypePattern"/> to declare
/// the bound variable, and <see cref="ConversionClassifier"/> for the
/// relational-pattern argument conversion. It never back-references
/// <see cref="Binder"/>; the callbacks it needs (re-binding a
/// sub-expression for constant patterns, binding a type clause for
/// type patterns, and the nil-literal test for nullable constant
/// patterns) are injected through narrow <see cref="Func{T, TResult}"/>
/// seams in the constructor — the same pattern established by
/// <see cref="ConversionClassifier"/> in PR-B-3 and
/// <see cref="OverloadResolver"/> in PR-B-4.
/// </para>
/// <para>
/// Switch-statement / switch-expression glue (binding the
/// discriminant, walking the arm list, exhaustiveness reporting via
/// <see cref="ExhaustivenessAnalyzer"/>, narrowing-frame management,
/// per-arm result conversion) deliberately stays on <see cref="Binder"/>
/// for this PR and will land in PR-B-7 (<c>StatementBinder</c>) and
/// PR-B-9 (<c>ExpressionBinder</c>). This class focuses strictly on
/// per-pattern binding so its surface area stays small.
/// </para>
/// <para>
/// The discard-pattern case is inlined in the pattern-dispatch method's
/// dispatch — it has no logic beyond constructing a
/// <c>BoundDiscardPattern</c> with the discriminant type, so it
/// leaves with the dispatch method rather than warranting a per-kind
/// helper. <see cref="ExhaustivenessAnalyzer"/> is already a separate
/// file and is not touched.
/// </para>
/// </remarks>
internal sealed class PatternBinder
{
    private readonly BinderContext binderCtx;
    private readonly ConversionClassifier conversions;
    private readonly Func<ExpressionSyntax, BoundExpression> bindExpression;
    private readonly Func<TypeClauseSyntax, TypeSymbol?> bindTypeClause;
    private readonly Func<BoundExpression, bool> isNilLiteral;

    /// <summary>
    /// Initializes a new instance of the <see cref="PatternBinder"/>
    /// class.
    /// </summary>
    /// <param name="binderCtx">The shared binder context that exposes
    /// the diagnostics bag and the (mutable) root/current Scope.</param>
    /// <param name="conversions">The binder-side conversion classifier
    /// used to convert the right-hand-side expression of a relational
    /// pattern to the discriminant type.</param>
    /// <param name="bindExpression">Callback to bind the right-hand-
    /// side expression of a constant pattern through the still-on-
    /// Binder expression-binding entry point.</param>
    /// <param name="bindTypeClause">Callback to bind the type clause
    /// of a type pattern to a <see cref="TypeSymbol"/>.</param>
    /// <param name="isNilLiteral">Callback that tests whether a bound
    /// expression is a <c>nil</c> literal (possibly through one or
    /// more <see cref="BoundConversionExpression"/> wrappers). Used by
    /// <see cref="BindConstantPattern"/> when the discriminant is a
    /// nullable type to pick the right comparison operand type.</param>
    public PatternBinder(
        BinderContext binderCtx,
        ConversionClassifier conversions,
        Func<ExpressionSyntax, BoundExpression> bindExpression,
        Func<TypeClauseSyntax, TypeSymbol?> bindTypeClause,
        Func<BoundExpression, bool> isNilLiteral)
    {
        this.binderCtx = binderCtx ?? throw new ArgumentNullException(nameof(binderCtx));
        this.conversions = conversions ?? throw new ArgumentNullException(nameof(conversions));
        this.bindExpression = bindExpression ?? throw new ArgumentNullException(nameof(bindExpression));
        this.bindTypeClause = bindTypeClause ?? throw new ArgumentNullException(nameof(bindTypeClause));
        this.isNilLiteral = isNilLiteral ?? throw new ArgumentNullException(nameof(isNilLiteral));
    }

    private DiagnosticBag Diagnostics => binderCtx.Diagnostics;

    private BoundScope Scope => binderCtx.RootScope;

    /// <summary>
    /// Binds a pattern syntax node to the appropriate
    /// <see cref="BoundPattern"/> for the supplied discriminant type.
    /// Dispatches to the per-kind binder (<see cref="BindConstantPattern"/>,
    /// <see cref="BindTypePattern"/>, <see cref="BindPropertyPattern"/>,
    /// <see cref="BindRelationalPattern"/>, <see cref="BindListPattern"/>)
    /// based on <see cref="SyntaxNode.Kind"/>. The discard-pattern case
    /// is inlined here because it has no per-kind logic beyond
    /// constructing the bound node.
    /// </summary>
    /// <param name="syntax">The pattern syntax node to bind.</param>
    /// <param name="discriminantType">The type of the switch
    /// discriminant against which this pattern is matched.</param>
    /// <returns>The bound pattern.</returns>
    public BoundPattern BindPattern(PatternSyntax syntax, TypeSymbol discriminantType)
    {
        return BindPattern(
            syntax,
            discriminantType,
            PatternBindingContext.Allowed,
            preferTypeNames: false);
    }

    /// <summary>
    /// Binds a pattern with an explicit binding policy and bare-name preference.
    /// </summary>
    /// <param name="syntax">The pattern syntax.</param>
    /// <param name="discriminantType">The tested value type.</param>
    /// <param name="allowBindings">Whether source-visible pattern bindings are allowed.</param>
    /// <param name="preferTypeNames">Whether an ambiguous bare name resolves as a type before a value.</param>
    /// <returns>The bound pattern.</returns>
    public BoundPattern BindPattern(
        PatternSyntax syntax,
        TypeSymbol discriminantType,
        bool allowBindings,
        bool preferTypeNames)
    {
        return BindPattern(
            syntax,
            discriminantType,
            allowBindings ? PatternBindingContext.Allowed : PatternBindingContext.IsExpression,
            preferTypeNames);
    }

    private BoundPattern BindPattern(
        PatternSyntax syntax,
        TypeSymbol discriminantType,
        PatternBindingContext bindingContext,
        bool preferTypeNames)
    {
        // ADR-0169: guarantee the dispatch-level anchor so semantic-model and
        // analyzer queries can resolve this pattern by its syntax.
        var result = BindPatternCore(syntax, discriminantType, bindingContext, preferTypeNames);
        result.AnchorSyntax(syntax);
        return result;
    }

    private BoundPattern BindPatternCore(
        PatternSyntax syntax,
        TypeSymbol discriminantType,
        PatternBindingContext bindingContext,
        bool preferTypeNames)
    {
        switch (syntax.Kind)
        {
            case SyntaxKind.ConstantPattern:
                return BindConstantPattern((ConstantPatternSyntax)syntax, discriminantType);
            case SyntaxKind.TypeOrConstantPattern:
                return BindTypeOrConstantPattern(
                    (TypeOrConstantPatternSyntax)syntax,
                    discriminantType,
                    bindingContext,
                    preferTypeNames);
            case SyntaxKind.DiscardPattern:
                return new BoundDiscardPattern(syntax, discriminantType);
            case SyntaxKind.VarPattern:
                return BindVarPattern(
                    (VarPatternSyntax)syntax,
                    discriminantType,
                    bindingContext);
            case SyntaxKind.TypePattern:
                return BindTypePattern(
                    (TypePatternSyntax)syntax,
                    discriminantType,
                    bindingContext,
                    preferTypeNames);
            case SyntaxKind.PropertyPattern:
                var propertySyntax = (PropertyPatternSyntax)syntax;
                if (propertySyntax.Designation != null)
                {
                    return BindDesignatedPropertyPattern(
                        propertySyntax,
                        discriminantType,
                        bindingContext,
                        preferTypeNames);
                }

                return BindPropertyPattern(
                    propertySyntax,
                    discriminantType,
                    bindingContext,
                    preferTypeNames);
            case SyntaxKind.RelationalPattern:
                return BindRelationalPattern((RelationalPatternSyntax)syntax, discriminantType);
            case SyntaxKind.ListPattern:
                return BindListPattern(
                    (ListPatternSyntax)syntax,
                    discriminantType,
                    bindingContext,
                    preferTypeNames);
            case SyntaxKind.BinaryPattern:
                return BindBinaryPattern(
                    (BinaryPatternSyntax)syntax,
                    discriminantType,
                    bindingContext,
                    preferTypeNames);
            case SyntaxKind.NotPattern:
                return BindNotPattern(
                    (NotPatternSyntax)syntax,
                    discriminantType,
                    bindingContext,
                    preferTypeNames);
            case SyntaxKind.ParenthesizedPattern:
                return BindPattern(
                    ((ParenthesizedPatternSyntax)syntax).Pattern,
                    discriminantType,
                    bindingContext,
                    preferTypeNames);
            default:
                throw new Exception($"Unexpected pattern syntax {syntax.Kind}");
        }
    }

    private BoundPattern BindVarPattern(
        VarPatternSyntax syntax,
        TypeSymbol discriminantType,
        PatternBindingContext bindingContext)
    {
        if (syntax.Designation.Text == "_")
        {
            return new BoundDiscardPattern(syntax, discriminantType);
        }

        var variable = CreatePatternVariable(
            syntax.Designation.Text,
            discriminantType,
            syntax.Designation,
            isExpressionBinding: bindingContext == PatternBindingContext.IsExpression);
        variable.HasDefinitelyNonNullValue = false;

        if (bindingContext == PatternBindingContext.Allowed)
        {
            if (!Scope.TryDeclareVariable(variable))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(
                    syntax.Designation.Location,
                    syntax.Designation.Text);
            }
        }
        else if (bindingContext == PatternBindingContext.OrOrNot)
        {
            Diagnostics.ReportPatternVariableNotAllowedUnderOrNot(
                syntax.Designation.Location,
                syntax.Designation.Text);
        }

        return new BoundDiscardPattern(syntax, discriminantType, variable);
    }

    // Issue #992: a conjunction (`and`) keeps bindings (both sub-patterns must
    // match, so a variable bound on either side is definitely assigned). A
    // disjunction (`or`) forbids bindings on both sides.
    private BoundPattern BindBinaryPattern(
        BinaryPatternSyntax syntax,
        TypeSymbol discriminantType,
        PatternBindingContext bindingContext,
        bool preferTypeNames)
    {
        var isConjunction = syntax.OperatorToken.Text == "and";
        var childBindingContext = !isConjunction
            ? PatternBindingContext.OrOrNot
            : bindingContext;
        var left = BindPattern(
            syntax.Left,
            discriminantType,
            childBindingContext,
            preferTypeNames);

        var rightInputType = discriminantType;
        LocalVariableSymbol? rightInputVariable = null;
        if (isConjunction
            && TryGetGuaranteedNarrowingValue(left, out var narrowedVariable))
        {
            rightInputVariable = narrowedVariable;
            rightInputType = narrowedVariable.Type;
        }

        var right = BindPattern(
            syntax.Right,
            rightInputType,
            childBindingContext,
            preferTypeNames);
        return new BoundBinaryPattern(
            syntax,
            discriminantType,
            isConjunction,
            left,
            right,
            rightInputVariable);
    }

    private static bool TryGetGuaranteedNarrowingValue(
        BoundPattern pattern,
        [NotNullWhen(true)] out LocalVariableSymbol? variable)
    {
        switch (pattern)
        {
            case BoundTypePattern typePattern:
                variable = typePattern.Variable;
                return true;
            case BoundBinaryPattern { IsConjunction: true } binary:
                if (TryGetGuaranteedNarrowingValue(binary.Right, out variable))
                {
                    return true;
                }

                return TryGetGuaranteedNarrowingValue(binary.Left, out variable);
            default:
                variable = null;
                return false;
        }
    }

    // Issue #992: `not` forbids bindings in its operand — a variable bound by a
    // pattern that did NOT match cannot be definitely assigned.
    private BoundPattern BindNotPattern(
        NotPatternSyntax syntax,
        TypeSymbol discriminantType,
        PatternBindingContext bindingContext,
        bool preferTypeNames)
    {
        // Non-nullable CLR values cannot match nil, so `not nil` is a total
        // boolean pattern. Keep switch diagnostics unchanged.
        if (bindingContext == PatternBindingContext.IsExpression
            && Binder.IsNonNullableValueTypeForConstraint(discriminantType)
            && IsNilPattern(syntax.Pattern))
        {
            return new BoundDiscardPattern(syntax, discriminantType);
        }

        var childBindingContext = PatternBindingContext.OrOrNot;
        var operand = BindPattern(
            syntax.Pattern,
            discriminantType,
            childBindingContext,
            preferTypeNames);
        return new BoundNotPattern(syntax, discriminantType, operand);
    }

    private static bool IsNilPattern(PatternSyntax syntax)
    {
        while (syntax is ParenthesizedPatternSyntax parenthesized)
        {
            syntax = parenthesized.Pattern;
        }

        return syntax is ConstantPatternSyntax
        {
            Expression: LiteralExpressionSyntax { Value: null },
        };
    }

    private BoundPattern BindConstantPattern(ConstantPatternSyntax syntax, TypeSymbol discriminantType)
        => BindConstantPatternWithResolution(syntax, discriminantType, out _);

    private BoundPattern BindConstantPatternWithResolution(
        ConstantPatternSyntax syntax,
        TypeSymbol discriminantType,
        out bool expressionResolved)
    {
        var expression = bindExpression(syntax.Expression);
        expressionResolved = expression is not BoundErrorExpression
            && expression.Type != TypeSymbol.Error;

        // Issue #1157: adapt a constant integer LITERAL case label that fits the
        // discriminant's integer type to that type, mirroring the constant
        // adaptation #1144 restored for binary operators. Without this, a literal
        // like `0` (typed int32) on a `uint8` switch is a narrowing conversion and
        // would be rejected with GS0171 even though it clearly fits. A nullable
        // discriminant targets its underlying type; out-of-range labels are left
        // untouched so the existing GS0171 path still fires.
        var adaptTarget = discriminantType is NullableTypeSymbol nullableTarget
            ? nullableTarget.UnderlyingType
            : discriminantType;
        if (ExpressionBinder.IsIntegerType(adaptTarget)
            && expression.Type != adaptTarget
            && TryGetConstantIntegerLiteralValue(expression, out var literalValue)
            && ExpressionBinder.TryAdaptIntegerLiteral(literalValue, adaptTarget, out var adaptedValue))
        {
            expression = new BoundLiteralExpression(syntax.Expression, adaptedValue);
        }

        // A successful type pattern can narrow `object` to a non-nullable
        // reference type before the right side of `and` is bound. Keep
        // `T and not nil` legal in that narrowed context: nil can still be
        // tested at runtime even though the static annotation is non-nullable.
        if (isNilLiteral(expression) && IsNonNullableReferencePatternInput(discriminantType))
        {
            return new BoundConstantPattern(syntax, discriminantType, expression);
        }

        var conversion = Conversion.Classify(expression.Type, discriminantType);
        if (!conversion.Exists || conversion.IsExplicit)
        {
            if (expression.Type != TypeSymbol.Error && discriminantType != TypeSymbol.Error)
            {
                Diagnostics.ReportSwitchCaseTypeMismatch(syntax.Expression.Location, expression.Type, discriminantType);
            }

            return new BoundConstantPattern(syntax, discriminantType, new BoundErrorExpression(syntax));
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
        var value = conversion.IsIdentity ? expression : conversions.BindConversion(syntax.Expression.Location, expression, discriminantType);
        var op = BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, discriminantType, discriminantType);
        if (op == null && discriminantType is NullableTypeSymbol nullable)
        {
            var comparisonType = isNilLiteral(expression) ? TypeSymbol.Null : nullable.UnderlyingType;
            op = BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, discriminantType, comparisonType)
                ?? BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, nullable.UnderlyingType, nullable.UnderlyingType);
        }

        if (op == null && expression.Type != TypeSymbol.Error)
        {
            Diagnostics.ReportSwitchCaseTypeMismatch(syntax.Expression.Location, expression.Type, discriminantType);
        }

        return new BoundConstantPattern(syntax, discriminantType, value);
    }

    private static bool IsNonNullableReferencePatternInput(TypeSymbol type)
    {
        if (type is NullableTypeSymbol)
        {
            return false;
        }

        if (type is StructSymbol structType)
        {
            return structType.IsClass;
        }

        if (type is InterfaceSymbol)
        {
            return true;
        }

        return type.ClrType is { IsValueType: false };
    }

    // Issue #1157: extract a compile-time constant INTEGER literal value from a
    // case-label expression. Accepts a bare integer literal or a unary `+` / `-`
    // applied to one (e.g. `case -1`), so a negative literal label can adapt to a
    // signed governing type. Named constants and other non-literal expressions are
    // deliberately excluded — only literal labels participate in adaptation.
    private static bool TryGetConstantIntegerLiteralValue(BoundExpression expression, out object value)
    {
        switch (expression)
        {
            case BoundLiteralExpression lit when lit.Value != null
                && ExpressionBinder.IsIntegerLiteralValue(lit.Value):
                value = lit.Value;
                return true;

            case BoundUnaryExpression unary
                when unary.Op.Kind == BoundUnaryOperatorKind.Identity
                    && TryGetConstantIntegerLiteralValue(unary.Operand, out var positive):
                value = positive;
                return true;

            case BoundUnaryExpression unary
                when unary.Op.Kind == BoundUnaryOperatorKind.Negation
                    && TryGetConstantIntegerLiteralValue(unary.Operand, out var operand):
                return TryNegateIntegerLiteral(operand, out value);
        }

        value = 0;
        return false;
    }

    // Issue #1157: negate a boxed integer literal, re-boxing into the narrowest of
    // int64 / uint64 that holds the result. The boxed type only feeds
    // ExpressionBinder.TryAdaptIntegerLiteral (which range-checks via BigInteger),
    // so any integer carrier with the correct value suffices.
    private static bool TryNegateIntegerLiteral(object value, out object negated)
    {
        var result = -ToBigInteger(value);
        if (result >= long.MinValue && result <= long.MaxValue)
        {
            negated = (long)result;
            return true;
        }

        if (result >= ulong.MinValue && result <= ulong.MaxValue)
        {
            negated = (ulong)result;
            return true;
        }

        negated = 0;
        return false;
    }

    private static BigInteger ToBigInteger(object value)
    {
        return value switch
        {
            sbyte s => s,
            byte b => b,
            short s => s,
            ushort u => u,
            int i => i,
            uint u => u,
            long l => l,
            ulong u => u,
            nint n => (long)n,
            nuint n => (ulong)n,
            _ => default,
        };
    }

    private BoundPattern BindTypeOrConstantPattern(
        TypeOrConstantPatternSyntax syntax,
        TypeSymbol discriminantType,
        PatternBindingContext bindingContext,
        bool preferTypeNames)
    {
        if (syntax.PropertyPattern != null)
        {
            return BindBareTypePattern(
                syntax,
                syntax.CandidateType,
                syntax.PropertyPattern,
                discriminantType,
                bindingContext,
                preferTypeNames);
        }

        var diagnosticMark = Diagnostics.Count;
        if (preferTypeNames)
        {
            var typePattern = BindBareTypePattern(
                syntax,
                syntax.CandidateType,
                propertyPattern: null,
                discriminantType,
                bindingContext,
                preferTypeNames);
            if (typePattern.TargetType != TypeSymbol.Error)
            {
                return typePattern;
            }

            Diagnostics.TruncateTo(diagnosticMark);
            var constantPattern = BindConstantPatternWithResolution(
                new ConstantPatternSyntax(syntax.SyntaxTree, syntax.Expression),
                discriminantType,
                out var valueResolved);
            if (valueResolved)
            {
                return constantPattern;
            }

            Diagnostics.TruncateTo(diagnosticMark);

            // Both interpretations failed. Prefer the value-resolution error
            // over a misleading "missing type/import" diagnostic.
            return BindConstantPattern(
                new ConstantPatternSyntax(syntax.SyntaxTree, syntax.Expression),
                discriminantType);
        }

        var valuePattern = BindConstantPatternWithResolution(
            new ConstantPatternSyntax(syntax.SyntaxTree, syntax.Expression),
            discriminantType,
            out var resolved);
        if (resolved)
        {
            return valuePattern;
        }

        Diagnostics.TruncateTo(diagnosticMark);
        var fallbackTypePattern = BindBareTypePattern(
            syntax,
            syntax.CandidateType,
            propertyPattern: null,
            discriminantType,
            bindingContext,
            preferTypeNames);
        if (fallbackTypePattern.TargetType != TypeSymbol.Error)
        {
            return fallbackTypePattern;
        }

        Diagnostics.TruncateTo(diagnosticMark);
        return BindConstantPattern(
            new ConstantPatternSyntax(syntax.SyntaxTree, syntax.Expression),
            discriminantType);
    }

    private BoundTypePattern BindTypePattern(
        TypePatternSyntax syntax,
        TypeSymbol discriminantType,
        PatternBindingContext bindingContext,
        bool preferTypeNames)
    {
        var targetType = bindTypeClause(syntax.Type) ?? TypeSymbol.Error;
        return BindTypePatternCore(
            syntax,
            syntax.Identifier,
            syntax.Designation,
            targetType,
            syntax.PropertyPattern,
            discriminantType,
            bindingContext,
            preferTypeNames);
    }

    private BoundTypePattern BindBareTypePattern(
        SyntaxNode syntax,
        TypeClauseSyntax type,
        PropertyPatternSyntax? propertyPattern,
        TypeSymbol discriminantType,
        PatternBindingContext bindingContext,
        bool preferTypeNames)
    {
        var targetType = bindTypeClause(type) ?? TypeSymbol.Error;
        return BindTypePatternCore(
            syntax,
            identifier: null,
            designation: null,
            targetType,
            propertyPattern,
            discriminantType,
            bindingContext,
            preferTypeNames);
    }

    /// <summary>
    /// Binds a type test with an optional pattern variable. <paramref name="identifier"/>
    /// is the switch binding spelling (<c>name is T</c>); <paramref name="designation"/>
    /// is the ADR-0166 designation spelling (<c>T name</c>, <c>{ ... } name</c>).
    /// </summary>
    private BoundTypePattern BindTypePatternCore(
        SyntaxNode syntax,
        SyntaxToken? identifier,
        SyntaxToken? designation,
        TypeSymbol targetType,
        PropertyPatternSyntax? propertyPattern,
        TypeSymbol discriminantType,
        PatternBindingContext bindingContext,
        bool preferTypeNames)
    {
        if (bindingContext == PatternBindingContext.IsExpression
            && targetType is NullableTypeSymbol nullableTarget)
        {
            targetType = nullableTarget.UnderlyingType;
        }

        var nameToken = identifier ?? designation;
        var bindingIdentifier = nameToken != null && nameToken.Text != "_"
            ? nameToken
            : null;
        var hasBinding = bindingIdentifier != null;
        var variableName = bindingIdentifier?.Text ?? "<type-pattern-value>";
        var variable = CreatePatternVariable(
            variableName,
            targetType,
            nameToken,
            isExpressionBinding: hasBinding && bindingContext == PatternBindingContext.IsExpression);

        if (bindingIdentifier != null)
        {
            if (bindingContext == PatternBindingContext.Allowed)
            {
                if (!Scope.TryDeclareVariable(variable))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(
                        bindingIdentifier.Location,
                        bindingIdentifier.Text);
                }
            }
            else if (bindingContext == PatternBindingContext.OrOrNot)
            {
                // Issue #992: a type pattern that introduces a binding variable is
                // not allowed under `or` / `not` — the variable would not be
                // definitely assigned. The discard identifier `_` is permitted.
                Diagnostics.ReportPatternVariableNotAllowedUnderOrNot(
                    bindingIdentifier.Location,
                    bindingIdentifier.Text);
            }
            else if (identifier != null)
            {
                // ADR-0166: only the designation spelling introduces a pattern
                // variable in a boolean `is`; `value is text is string` keeps
                // reading as an incoherent double test.
                Diagnostics.ReportPatternBindingNotAllowedInIsExpression(
                    bindingIdentifier.Location,
                    bindingIdentifier.Text);
            }

            // ADR-0166: a designation in a boolean `is` is declared by the
            // consumer of the condition (see PatternVariables), not here.
        }

        var boundProperty = propertyPattern == null
            ? null
            : BindPropertyPattern(
                propertyPattern,
                targetType,
                bindingContext,
                preferTypeNames);
        return new BoundTypePattern(
            syntax,
            discriminantType,
            targetType,
            variable,
            hasBinding,
            boundProperty);
    }

    /// <summary>
    /// ADR-0166: creates the local that receives a pattern's matched value. A
    /// designation bound in a boolean <c>is</c> is a
    /// <see cref="PatternVariableSymbol"/> so later passes can recognise a
    /// single-assignment binding whose every visible use is dominated by the
    /// match (closure capture snapshots it instead of boxing it).
    /// </summary>
    private static LocalVariableSymbol CreatePatternVariable(
        string name,
        TypeSymbol type,
        SyntaxToken? declaringSyntax,
        bool isExpressionBinding)
        => isExpressionBinding
            ? new PatternVariableSymbol(name, type, declaringSyntax)
            : new LocalVariableSymbol(name, isReadOnly: true, type, declaringSyntax);

    /// <summary>
    /// ADR-0166: <c>{ ... } name</c> binds the matched, non-nil input at the
    /// input's non-nullable type. It is bound as a type pattern over the
    /// stripped input type — the C# semantics — so emission and narrowing reuse
    /// the type-pattern pipeline unchanged.
    /// </summary>
    private BoundPattern BindDesignatedPropertyPattern(
        PropertyPatternSyntax syntax,
        TypeSymbol discriminantType,
        PatternBindingContext bindingContext,
        bool preferTypeNames)
    {
        var targetType = discriminantType is NullableTypeSymbol nullable
            ? nullable.UnderlyingType
            : discriminantType;
        return BindTypePatternCore(
            syntax,
            identifier: null,
            syntax.Designation,
            targetType,
            syntax,
            discriminantType,
            bindingContext,
            preferTypeNames);
    }

    private BoundPropertyPattern BindPropertyPattern(
        PropertyPatternSyntax syntax,
        TypeSymbol discriminantType,
        PatternBindingContext bindingContext,
        bool preferTypeNames)
    {
        var fields = ImmutableArray.CreateBuilder<BoundPropertyPatternField>();

        // Recursive property patterns never match null. Member lookup therefore
        // runs against the non-null underlying type for both nullable references
        // and Nullable<T>; emitter/evaluator perform the corresponding guard.
        var lookupType = discriminantType is NullableTypeSymbol nullableDiscriminant
            ? nullableDiscriminant.UnderlyingType
            : discriminantType;

        // Issue #1887: cs2gs lowers a C# positional pattern over a raw tuple
        // subject (`(0, 0) => ...`) to a G# property pattern keyed on the
        // tuple's always-present Item1..ItemN fields (`{ Item1: 0, Item2: 0 }`).
        // A ValueTuple is neither a StructSymbol nor a class, so it needs its
        // own lookup path alongside the struct/class one below.
        if (lookupType is TupleTypeSymbol tupleType)
        {
            foreach (var tupleFieldSyntax in syntax.Fields)
            {
                if (!TryGetTupleField(tupleType, tupleFieldSyntax.Identifier.Text, out var tupleField)
                    || tupleField is null)
                {
                    Diagnostics.ReportUndefinedFieldOnType(tupleFieldSyntax.Identifier.Location, tupleFieldSyntax.Identifier.Text, discriminantType);
                    fields.Add(new BoundPropertyPatternField(
                        syntax,
                        new FieldSymbol(tupleFieldSyntax.Identifier.Text, TypeSymbol.Error, Accessibility.Public),
                        BindPattern(
                            tupleFieldSyntax.Pattern,
                            TypeSymbol.Error,
                            bindingContext,
                            preferTypeNames)));
                    continue;
                }

                fields.Add(new BoundPropertyPatternField(
                    syntax,
                    tupleField,
                    BindPattern(
                        tupleFieldSyntax.Pattern,
                        tupleField.Type,
                        bindingContext,
                        preferTypeNames)));
            }

            return new BoundPropertyPattern(syntax, discriminantType, fields.ToImmutable());
        }

        // ADR-0166: the empty property pattern `{ }` is a pure non-nil test
        // (C# semantics) and applies to every input type; only a member list
        // needs a struct, class, interface, or tuple to look members up on.
        if (syntax.Fields.Count > 0 && !SupportsPropertyPattern(lookupType))
        {
            Diagnostics.ReportPropertyPatternRequiresStructOrClass(syntax.OpenBraceToken.Location, discriminantType);
            return new BoundPropertyPattern(syntax, discriminantType, fields.ToImmutable());
        }

        foreach (var fieldSyntax in syntax.Fields)
        {
            if (!TryBindPropertyPatternMember(
                    lookupType,
                    fieldSyntax,
                    bindingContext,
                    preferTypeNames,
                    out var field)
                || field is null)
            {
                Diagnostics.ReportUndefinedFieldOnType(fieldSyntax.Identifier.Location, fieldSyntax.Identifier.Text, discriminantType);
                fields.Add(new BoundPropertyPatternField(
                    syntax,
                    new FieldSymbol(fieldSyntax.Identifier.Text, TypeSymbol.Error, Accessibility.Public),
                    BindPattern(
                        fieldSyntax.Pattern,
                        TypeSymbol.Error,
                        bindingContext,
                        preferTypeNames)));
                continue;
            }

            fields.Add(field);
        }

        return new BoundPropertyPattern(syntax, discriminantType, fields.ToImmutable());
    }

    private bool TryBindPropertyPatternMember(
        TypeSymbol lookupType,
        PropertyPatternFieldSyntax syntax,
        PatternBindingContext bindingContext,
        bool preferTypeNames,
        out BoundPropertyPatternField? boundField)
    {
        boundField = null;
        var name = syntax.Identifier.Text;
        if (lookupType is StructSymbol structType)
        {
            StructSymbol? current = structType;
            while (current != null)
            {
                foreach (var field in current.Fields)
                {
                    if (field.Name == name)
                    {
                        boundField = new BoundPropertyPatternField(
                            syntax,
                            field,
                            current,
                            BindPattern(
                                syntax.Pattern,
                                field.Type,
                                bindingContext,
                                preferTypeNames));
                        return true;
                    }
                }

                foreach (var property in current.Properties)
                {
                    if (property.Name != name)
                    {
                        continue;
                    }

                    if (property.IsIndexer || property.IsStatic || !property.HasGetter)
                    {
                        return false;
                    }

                    boundField = new BoundPropertyPatternField(
                        syntax,
                        property,
                        current,
                        BindPattern(
                            syntax.Pattern,
                            property.Type,
                            bindingContext,
                            preferTypeNames));
                    return true;
                }

                current = current.BaseClass;
            }

            var importedBase = TypeMemberModel.GetNearestImportedBase(structType);
            if (importedBase?.ClrType != null
                && TryBindClrPropertyPatternMember(
                    importedBase,
                    importedBase.ClrType,
                    syntax,
                    bindingContext,
                    preferTypeNames,
                    out boundField))
            {
                return true;
            }
        }
        else if (lookupType is InterfaceSymbol interfaceType)
        {
            foreach (var current in interfaceType.SelfAndAllBaseInterfaces())
            {
                current.EnsureMembersResolved();
                foreach (var property in current.Properties)
                {
                    if (property.Name != name)
                    {
                        continue;
                    }

                    if (property.IsIndexer || property.IsStatic || !property.HasGetter)
                    {
                        boundField = null;
                        return false;
                    }

                    boundField = new BoundPropertyPatternField(
                        syntax,
                        property,
                        current,
                        BindPattern(
                            syntax.Pattern,
                            property.Type,
                            bindingContext,
                            preferTypeNames));
                    return true;
                }
            }

            foreach (var importedBase in MemberLookup.GetTransitiveClrBaseInterfaces(interfaceType))
            {
                var importedBaseType = ImportedTypeSymbol.Get(importedBase);
                if (TryBindClrPropertyPatternMember(
                    importedBaseType,
                    importedBase,
                    syntax,
                    bindingContext,
                    preferTypeNames,
                    out boundField))
                {
                    return true;
                }
            }
        }
        else if (lookupType.ClrType is Type clrType
            && TryBindClrPropertyPatternMember(
                lookupType,
                clrType,
                syntax,
                bindingContext,
                preferTypeNames,
                out boundField))
        {
            return true;
        }

        var directClrType = lookupType.ClrType;
        if (directClrType is not null
            && TryBindClrPropertyPatternMember(
                lookupType,
                directClrType,
                syntax,
                bindingContext,
                preferTypeNames,
                out boundField))
        {
            return true;
        }

        boundField = null;
        return false;
    }

    private bool TryBindClrPropertyPatternMember(
        TypeSymbol receiverType,
        Type clrType,
        PropertyPatternFieldSyntax syntax,
        PatternBindingContext bindingContext,
        bool preferTypeNames,
        out BoundPropertyPatternField? boundField)
    {
        var name = syntax.Identifier.Text;
        var property = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(
            clrType,
            name,
            BindingFlags.Public | BindingFlags.Instance);
        if (property != null)
        {
            if (property.GetIndexParameters().Length != 0
                || property.GetGetMethod(nonPublic: false) == null)
            {
                boundField = null;
                return false;
            }

            var propertyType = MemberLookup.GetClrPropertyTypeSymbol(receiverType, property);
            boundField = new BoundPropertyPatternField(
                syntax,
                property,
                propertyType,
                BindPattern(
                    syntax.Pattern,
                    propertyType,
                    bindingContext,
                    preferTypeNames));
            return true;
        }

        var field = ClrTypeUtilities.SafeGetFieldIncludingInterfaces(
            clrType,
            name,
            BindingFlags.Public | BindingFlags.Instance);
        if (field != null)
        {
            var fieldType = ClrNullability.GetFieldTypeSymbol(field);
            boundField = new BoundPropertyPatternField(
                syntax,
                field,
                fieldType,
                BindPattern(
                    syntax.Pattern,
                    fieldType,
                    bindingContext,
                    preferTypeNames));
            return true;
        }

        boundField = null;
        return false;
    }

    private static bool SupportsPropertyPattern(TypeSymbol type)
    {
        if (type is StructSymbol or InterfaceSymbol or TupleTypeSymbol)
        {
            return true;
        }

        return type.ClrType is Type clrType && !clrType.IsPrimitive && !clrType.IsEnum;
    }

    // Issue #1887: resolve a tuple's synthetic Item1..ItemN field by name so a
    // property/positional pattern (`{ Item1: 0, Item2: 0 }`) binds against a
    // ValueTuple subject the same way it does against a struct's real fields.
    private static bool TryGetTupleField(TupleTypeSymbol tupleType, string name, out FieldSymbol? field)
    {
        field = null;
        if (name.Length <= 4 || !name.StartsWith("Item", StringComparison.Ordinal))
        {
            return false;
        }

        if (!int.TryParse(name.AsSpan(4), out var index) || index < 1 || index > tupleType.Arity)
        {
            return false;
        }

        field = new FieldSymbol(name, tupleType.ElementTypes[index - 1], Accessibility.Public);
        return true;
    }

    private BoundPattern BindRelationalPattern(RelationalPatternSyntax syntax, TypeSymbol discriminantType)
    {
        var value = conversions.BindConversion(syntax.Expression, discriminantType, allowExplicit: false);
        var op = BoundBinaryOperator.Bind(syntax.OperatorToken.Kind, discriminantType, discriminantType);
        if (op == null)
        {
            Diagnostics.ReportRelationalPatternOperatorUndefined(syntax.OperatorToken.Location, syntax.OperatorToken.Kind, discriminantType);
            op = BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32);
        }

        return new BoundRelationalPattern(
            syntax,
            discriminantType,
            op ?? throw new InvalidOperationException("A relational pattern operator must be available."),
            value);
    }

    private BoundPattern BindListPattern(
        ListPatternSyntax syntax,
        TypeSymbol discriminantType,
        PatternBindingContext bindingContext,
        bool preferTypeNames)
    {
        // Issue #1951: accept any array-shaped discriminant, not just the
        // in-compilation ArrayTypeSymbol/SliceTypeSymbol — a metadata/CLR
        // array (e.g. the type of `Array.Empty<int>()`, or any imported
        // BCL `T[]`) is genuinely array-shaped too. Reuse the same
        // recognition ExpressionBinder uses for array/span slicing.
        var elementType = ExpressionBinder.GetArraySliceElementType(discriminantType) ?? TypeSymbol.Error;

        // Issue #3501: an indexable non-array discriminant — anything with an
        // int32 `Length`/`Count` getter and a `this[int]` indexer, e.g.
        // `ImmutableArray[T]` — also supports the fixed-length list pattern.
        // The rest subpattern must be a pure `..` discard (there is no cheap
        // middle-slice materialization for an arbitrary indexable).
        PropertyInfo? lengthProperty = null;
        PropertyInfo? indexerProperty = null;
        LocalVariableSymbol? inputVariable = null;

        // The discriminant may reach here wrapped in a nullability
        // annotation (NRT-annotated member reads); the indexable probe cares
        // only about the underlying imported construction.
        var indexableSource = discriminantType is NullabilityAnnotatedTypeSymbol annotatedIndexable
            ? annotatedIndexable.BaseType
            : discriminantType;
        if (elementType == TypeSymbol.Error
            && indexableSource is ImportedTypeSymbol importedIndexable
            && importedIndexable.ClrType is Type indexableClr)
        {
            PropertyInfo? length =
                FindIntGetter(indexableClr, "Length") ?? FindIntGetter(indexableClr, "Count");
            PropertyInfo? indexer = indexableClr
                .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(p => p.GetIndexParameters() is { Length: 1 } indexParams
                    && indexParams[0].ParameterType.IsSameAs(typeof(int))
                    && p.GetGetMethod(nonPublic: false) != null);
            if (length != null && indexer != null)
            {
                elementType = ExpressionBinder.MapErasedIndexerElementType(importedIndexable, indexer);
                lengthProperty = length;
                indexerProperty = indexer;
                var inputName = "$list_input" + System.Threading.Interlocked
                    .Increment(ref binderCtx.SyntheticLocalCounter)
                    .ToString(System.Globalization.CultureInfo.InvariantCulture);
                inputVariable = new LocalVariableSymbol(inputName, isReadOnly: true, type: discriminantType);
                Scope.TryDeclareVariable(inputVariable);

                foreach (var elementSyntax in syntax.Elements)
                {
                    if (elementSyntax is SlicePatternSyntax sliceSyntax
                        && (sliceSyntax.Pattern != null || sliceSyntax.CaptureIdentifier != null))
                    {
                        Diagnostics.ReportListPatternRequiresArrayOrSlice(
                            sliceSyntax.DotDotToken.Location, discriminantType);
                    }
                }
            }
        }

        if (elementType == TypeSymbol.Error)
        {
            Diagnostics.ReportListPatternRequiresArrayOrSlice(syntax.OpenSquareBracketToken.Location, discriminantType);
        }

        var elements = ImmutableArray.CreateBuilder<BoundPattern>();
        var sliceCount = 0;
        foreach (var elementSyntax in syntax.Elements)
        {
            if (elementSyntax is SlicePatternSyntax slice)
            {
                // Issue #1505: at most one slice subpattern per list pattern.
                sliceCount++;
                if (sliceCount > 1)
                {
                    Diagnostics.ReportMultipleSlicePatternsInListPattern(slice.DotDotToken.Location);
                }

                elements.Add(BindSlicePattern(
                    slice,
                    discriminantType,
                    elementType,
                    bindingContext,
                    preferTypeNames));
            }
            else
            {
                elements.Add(BindPattern(
                    elementSyntax,
                    elementType,
                    bindingContext,
                    preferTypeNames));
            }
        }

        return new BoundListPattern(
            syntax,
            discriminantType,
            elements.ToImmutable(),
            elementType,
            lengthProperty,
            indexerProperty,
            inputVariable);
    }

    private static PropertyInfo? FindIntGetter(Type type, string name)
    {
        // Metadata-context safe: never filter GetProperty by a runtime
        // typeof — a MetadataLoadContext Int32 is a different Type instance.
        PropertyInfo? property = type
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(p => p.Name == name
                && p.GetIndexParameters().Length == 0
                && p.PropertyType.IsSameAs(typeof(int)));
        return property?.GetGetMethod(nonPublic: false) != null ? property : null;
    }

    // Issue #1505: bind a slice ("rest") subpattern. A named capture (`..rest`)
    // declares a `[]T` variable bound to the middle slice. A sub-pattern
    // (`..[> 0]`) is materialized into a synthesized `[]T` local and matched
    // against the slice value. A pure discard (`..`) materializes nothing.
    private BoundPattern BindSlicePattern(
        SlicePatternSyntax syntax,
        TypeSymbol discriminantType,
        TypeSymbol elementType,
        PatternBindingContext bindingContext,
        bool preferTypeNames)
    {
        var sliceType = elementType == TypeSymbol.Error
            ? (TypeSymbol)TypeSymbol.Error
            : SliceTypeSymbol.Get(elementType);

        BoundPattern? subPattern = null;
        if (syntax.Pattern != null)
        {
            subPattern = BindPattern(
                syntax.Pattern,
                sliceType,
                bindingContext,
                preferTypeNames);
        }

        LocalVariableSymbol? variable = null;
        if (syntax.CaptureIdentifier != null)
        {
            variable = CreatePatternVariable(
                syntax.CaptureIdentifier.Text,
                sliceType,
                syntax.CaptureIdentifier,
                isExpressionBinding: bindingContext == PatternBindingContext.IsExpression);
            if (bindingContext == PatternBindingContext.Allowed)
            {
                if (!Scope.TryDeclareVariable(variable))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(syntax.CaptureIdentifier.Location, syntax.CaptureIdentifier.Text);
                }
            }
            else if (bindingContext == PatternBindingContext.OrOrNot)
            {
                Diagnostics.ReportPatternVariableNotAllowedUnderOrNot(
                    syntax.CaptureIdentifier.Location,
                    syntax.CaptureIdentifier.Text);
            }

            // ADR-0166: a slice capture in a boolean `is` is scoped by the
            // consumer of the condition, like a type-pattern designation.
        }
        else if (subPattern != null)
        {
            // A sub-pattern needs the materialized slice value but introduces no
            // user-visible binding; synthesize an internal local as its source.
            variable = new LocalVariableSymbol("<slice>", isReadOnly: true, sliceType, declaringSyntax: syntax.DotDotToken);
        }

        return new BoundSlicePattern(syntax, discriminantType, elementType, variable, subPattern);
    }
}
