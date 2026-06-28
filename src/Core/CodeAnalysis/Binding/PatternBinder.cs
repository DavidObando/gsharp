// <copyright file="PatternBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Numerics;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

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
    private readonly Func<TypeClauseSyntax, TypeSymbol> bindTypeClause;
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
        Func<TypeClauseSyntax, TypeSymbol> bindTypeClause,
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
        return BindPattern(syntax, discriminantType, allowBindings: true);
    }

    private BoundPattern BindPattern(PatternSyntax syntax, TypeSymbol discriminantType, bool allowBindings)
    {
        switch (syntax.Kind)
        {
            case SyntaxKind.ConstantPattern:
                return BindConstantPattern((ConstantPatternSyntax)syntax, discriminantType);
            case SyntaxKind.DiscardPattern:
                return new BoundDiscardPattern(syntax, discriminantType);
            case SyntaxKind.TypePattern:
                return BindTypePattern((TypePatternSyntax)syntax, discriminantType, allowBindings);
            case SyntaxKind.PropertyPattern:
                return BindPropertyPattern((PropertyPatternSyntax)syntax, discriminantType);
            case SyntaxKind.RelationalPattern:
                return BindRelationalPattern((RelationalPatternSyntax)syntax, discriminantType);
            case SyntaxKind.ListPattern:
                return BindListPattern((ListPatternSyntax)syntax, discriminantType);
            case SyntaxKind.BinaryPattern:
                return BindBinaryPattern((BinaryPatternSyntax)syntax, discriminantType, allowBindings);
            case SyntaxKind.NotPattern:
                return BindNotPattern((NotPatternSyntax)syntax, discriminantType);
            case SyntaxKind.ParenthesizedPattern:
                return BindPattern(((ParenthesizedPatternSyntax)syntax).Pattern, discriminantType, allowBindings);
            default:
                throw new Exception($"Unexpected pattern syntax {syntax.Kind}");
        }
    }

    // Issue #992: a conjunction (`and`) keeps bindings (both sub-patterns must
    // match, so a variable bound on either side is definitely assigned). A
    // disjunction (`or`) forbids bindings on both sides.
    private BoundPattern BindBinaryPattern(BinaryPatternSyntax syntax, TypeSymbol discriminantType, bool allowBindings)
    {
        var isConjunction = syntax.OperatorToken.Text == "and";
        var childAllowBindings = allowBindings && isConjunction;
        var left = BindPattern(syntax.Left, discriminantType, childAllowBindings);
        var right = BindPattern(syntax.Right, discriminantType, childAllowBindings);
        return new BoundBinaryPattern(syntax, discriminantType, isConjunction, left, right);
    }

    // Issue #992: `not` forbids bindings in its operand — a variable bound by a
    // pattern that did NOT match cannot be definitely assigned.
    private BoundPattern BindNotPattern(NotPatternSyntax syntax, TypeSymbol discriminantType)
    {
        var operand = BindPattern(syntax.Pattern, discriminantType, allowBindings: false);
        return new BoundNotPattern(syntax, discriminantType, operand);
    }

    private BoundPattern BindConstantPattern(ConstantPatternSyntax syntax, TypeSymbol discriminantType)
    {
        var expression = bindExpression(syntax.Expression);

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

        var conversion = Conversion.Classify(expression.Type, discriminantType);
        if (!conversion.Exists || conversion.IsExplicit)
        {
            if (expression.Type != TypeSymbol.Error && discriminantType != TypeSymbol.Error)
            {
                Diagnostics.ReportSwitchCaseTypeMismatch(syntax.Expression.Location, expression.Type, discriminantType);
            }

            return new BoundConstantPattern(syntax, discriminantType, new BoundErrorExpression(syntax));
        }

        var value = conversion.IsIdentity ? expression : new BoundConversionExpression(syntax, discriminantType, expression);
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

    // Issue #1157: extract a compile-time constant INTEGER literal value from a
    // case-label expression. Accepts a bare integer literal or a unary `+` / `-`
    // applied to one (e.g. `case -1`), so a negative literal label can adapt to a
    // signed governing type. Named constants and other non-literal expressions are
    // deliberately excluded — only literal labels participate in adaptation.
    private static bool TryGetConstantIntegerLiteralValue(BoundExpression expression, out object value)
    {
        switch (expression)
        {
            case BoundLiteralExpression lit when ExpressionBinder.IsIntegerLiteralValue(lit.Value):
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

        value = null;
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

        negated = null;
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

    private BoundPattern BindTypePattern(TypePatternSyntax syntax, TypeSymbol discriminantType, bool allowBindings)
    {
        var targetType = bindTypeClause(syntax.Type) ?? TypeSymbol.Error;
        var isDiscard = syntax.Identifier.Text == "_";
        var variable = new LocalVariableSymbol(syntax.Identifier.Text, isReadOnly: true, targetType, declaringSyntax: syntax.Identifier);

        if (allowBindings)
        {
            if (!Scope.TryDeclareVariable(variable))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, syntax.Identifier.Text);
            }
        }
        else if (!isDiscard)
        {
            // Issue #992: a type pattern that introduces a binding variable is
            // not allowed under `or` / `not` — the variable would not be
            // definitely assigned. The discard identifier `_` is permitted.
            Diagnostics.ReportPatternVariableNotAllowedUnderOrNot(syntax.Identifier.Location, syntax.Identifier.Text);
        }

        return new BoundTypePattern(syntax, discriminantType, targetType, variable);
    }

    private BoundPattern BindPropertyPattern(PropertyPatternSyntax syntax, TypeSymbol discriminantType)
    {
        var fields = ImmutableArray.CreateBuilder<BoundPropertyPatternField>();
        if (discriminantType is not StructSymbol structType)
        {
            Diagnostics.ReportPropertyPatternRequiresStructOrClass(syntax.OpenBraceToken.Location, discriminantType);
            return new BoundPropertyPattern(syntax, discriminantType, fields.ToImmutable());
        }

        foreach (var fieldSyntax in syntax.Fields)
        {
            if (!TypeMemberModel.TryGetFieldIncludingInherited(structType, fieldSyntax.Identifier.Text, MemberQuery.Instance(MemberKinds.Field), out var field, out _))
            {
                Diagnostics.ReportUndefinedFieldOnType(fieldSyntax.Identifier.Location, fieldSyntax.Identifier.Text, discriminantType);
                fields.Add(new BoundPropertyPatternField(syntax, new FieldSymbol(fieldSyntax.Identifier.Text, TypeSymbol.Error, Accessibility.Public), BindPattern(fieldSyntax.Pattern, TypeSymbol.Error)));
                continue;
            }

            fields.Add(new BoundPropertyPatternField(syntax, field, BindPattern(fieldSyntax.Pattern, field.Type)));
        }

        return new BoundPropertyPattern(syntax, discriminantType, fields.ToImmutable());
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

        return new BoundRelationalPattern(syntax, discriminantType, op, value);
    }

    private BoundPattern BindListPattern(ListPatternSyntax syntax, TypeSymbol discriminantType)
    {
        TypeSymbol elementType = TypeSymbol.Error;
        if (discriminantType is ArrayTypeSymbol arrayType)
        {
            elementType = arrayType.ElementType;
        }
        else if (discriminantType is SliceTypeSymbol sliceType)
        {
            elementType = sliceType.ElementType;
        }
        else
        {
            Diagnostics.ReportListPatternRequiresArrayOrSlice(syntax.OpenSquareBracketToken.Location, discriminantType);
        }

        var elements = ImmutableArray.CreateBuilder<BoundPattern>();
        foreach (var elementSyntax in syntax.Elements)
        {
            elements.Add(BindPattern(elementSyntax, elementType));
        }

        return new BoundListPattern(syntax, discriminantType, elements.ToImmutable(), elementType);
    }
}
