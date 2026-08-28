// <copyright file="ExpressionBinder.TupleEquality.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <content>
/// Issue #3501 / ADR-0171: tuple equality (<c>==</c> / <c>!=</c>) as a
/// bind-time element-wise desugar. <c>t1 == t2</c> becomes a
/// <see cref="BoundBlockExpression"/> that evaluates each operand exactly once
/// into a synthetic read-only temp, then folds the per-element comparisons
/// with short-circuiting <c>&amp;&amp;</c> (<c>||</c> of <c>!=</c> for
/// inequality), left-to-right — matching C# §12.12.10 evaluation order. Each
/// element pair is bound through the ordinary equality chain (built-in table,
/// user/CLR <c>op_*</c>, reference-equality last resort, nested-tuple
/// recursion), so user-declared element operators, string equality, and lifted
/// nullable elements behave exactly as they do outside a tuple. Dispatching to
/// <c>ValueTuple.Equals</c> instead was rejected because it would bypass
/// user-declared element operators. Arity is compared structurally — never by
/// <see cref="TupleTypeSymbol"/> reference identity.
/// </content>
internal sealed partial class ExpressionBinder
{
    /// <summary>
    /// Binds <c>==</c> / <c>!=</c> whose operands are both tuple-typed.
    /// </summary>
    /// <param name="syntax">The binary expression syntax.</param>
    /// <param name="left">The bound left tuple operand.</param>
    /// <param name="right">The bound right tuple operand.</param>
    /// <returns>The desugared block expression, or a <see cref="BoundErrorExpression"/> after reporting.</returns>
    private BoundExpression BindTupleEquality(BinaryExpressionSyntax syntax, BoundExpression left, BoundExpression right)
    {
        var leftTuple = (TupleTypeSymbol)left.Type;
        var rightTuple = (TupleTypeSymbol)right.Type;
        var opLocation = syntax.OperatorToken.Location;

        if (leftTuple.Arity != rightTuple.Arity)
        {
            Diagnostics.ReportTupleEqualityArityMismatch(opLocation, leftTuple, leftTuple.Arity, rightTuple, rightTuple.Arity);
            return new BoundErrorExpression(null);
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>(2);
        var leftReceiver = SpillTupleOperand(syntax, left, leftTuple, statements);
        var rightReceiver = SpillTupleOperand(syntax, right, rightTuple, statements);

        var comparison = BindTupleElementwiseComparison(
            syntax.OperatorToken.Kind,
            leftReceiver,
            leftTuple,
            rightReceiver,
            rightTuple,
            opLocation,
            syntax.OperatorToken.Text);
        if (comparison == null)
        {
            return new BoundErrorExpression(null);
        }

        return new BoundBlockExpression(syntax, statements.MoveToImmutable(), comparison);
    }

    /// <summary>
    /// Declares a synthetic read-only temp initialized from a tuple operand so
    /// the operand is evaluated exactly once, and returns a variable reference
    /// to feed the element accesses.
    /// </summary>
    private BoundExpression SpillTupleOperand(
        SyntaxNode syntax,
        BoundExpression operand,
        TupleTypeSymbol tupleType,
        ImmutableArray<BoundStatement>.Builder statements)
    {
        var tempName = "$tupeq" + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var temp = new LocalVariableSymbol(tempName, isReadOnly: true, tupleType);
        scope.TryDeclareVariable(temp);
        statements.Add(new BoundVariableDeclaration(syntax, temp, operand));
        return new BoundVariableExpression(null, temp);
    }

    /// <summary>
    /// Folds the per-element comparisons of two equal-arity tuple receivers.
    /// Reports every incomparable element pair (not just the first) and
    /// returns <see langword="null"/> if any element failed to bind.
    /// </summary>
    private BoundExpression? BindTupleElementwiseComparison(
        SyntaxKind opKind,
        BoundExpression leftReceiver,
        TupleTypeSymbol leftTuple,
        BoundExpression rightReceiver,
        TupleTypeSymbol rightTuple,
        TextLocation opLocation,
        string opText)
    {
        var foldKind = opKind == SyntaxKind.EqualsEqualsToken
            ? SyntaxKind.AmpersandAmpersandToken
            : SyntaxKind.PipePipeToken;

        BoundExpression? result = null;
        var failed = false;
        for (var i = 0; i < leftTuple.Arity; i++)
        {
            var leftElement = new BoundTupleElementAccessExpression(null, leftReceiver, leftTuple, i);
            var rightElement = new BoundTupleElementAccessExpression(null, rightReceiver, rightTuple, i);
            var elementComparison = TryBindElementEquality(opKind, leftElement, rightElement, opLocation, opText);
            if (elementComparison == null)
            {
                failed = true;
                continue;
            }

            if (result == null)
            {
                result = elementComparison;
                continue;
            }

            var foldOperator = Invariant.Required(
                BoundBinaryOperator.Bind(foldKind, TypeSymbol.Bool, TypeSymbol.Bool),
                "bool && / || is always defined");
            result = new BoundBinaryExpression(null, result, foldOperator, elementComparison, binderCtx.IsCheckedContext);
        }

        return failed ? null : result;
    }

    /// <summary>
    /// Binds a single element pair through the ordinary equality chain:
    /// nested-tuple recursion, then the built-in table (with numeric
    /// adaptation), user-defined and CLR <c>op_*</c> operators, and the
    /// reference-equality last resort. Reports GS0129 with the element types
    /// and returns <see langword="null"/> when nothing binds.
    /// </summary>
    private BoundExpression? TryBindElementEquality(
        SyntaxKind opKind,
        BoundExpression left,
        BoundExpression right,
        TextLocation opLocation,
        string opText)
    {
        if (left.Type is TupleTypeSymbol nestedLeft && right.Type is TupleTypeSymbol nestedRight)
        {
            if (nestedLeft.Arity != nestedRight.Arity)
            {
                Diagnostics.ReportTupleEqualityArityMismatch(opLocation, nestedLeft, nestedLeft.Arity, nestedRight, nestedRight.Arity);
                return null;
            }

            // Nested elements are `ItemN` accesses on the outer temps, so
            // they are already single-evaluation — no further spilling.
            return BindTupleElementwiseComparison(opKind, left, nestedLeft, right, nestedRight, opLocation, opText);
        }

        var boundOperator = BindBinaryOperatorWithNumericAdaptation(opKind, ref left, ref right, opLocation, opLocation);
        if (boundOperator != null)
        {
            return new BoundBinaryExpression(null, left, boundOperator, right, binderCtx.IsCheckedContext);
        }

        var fallback = TryBindBinaryWithUserAndClrFallback(opKind, ref left, ref right, opLocation, opLocation, out var ambiguous);
        if (fallback != null)
        {
            return fallback;
        }

        if (ambiguous)
        {
            Diagnostics.ReportAmbiguousOverload(opLocation, opText, candidateCount: 2);
            return null;
        }

        if (BoundBinaryOperator.IsReferenceEqualityOperand(left.Type)
            && BoundBinaryOperator.IsReferenceEqualityOperand(right.Type))
        {
            var referenceOperator = BoundBinaryOperator.MakeReferenceEquality(opKind, left.Type, right.Type);
            return new BoundBinaryExpression(null, left, referenceOperator, right, binderCtx.IsCheckedContext);
        }

        Diagnostics.ReportUndefinedBinaryOperator(opLocation, opText, left.Type, right.Type);
        return null;
    }
}
