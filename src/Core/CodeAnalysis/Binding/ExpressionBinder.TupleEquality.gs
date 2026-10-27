// <copyright file="ExpressionBinder.TupleEquality.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Globalization
import System.Threading

/// ```xmldoc
/// <content>
/// Issue #3501 / ADR-0171: tuple equality (<c>==</c> / <c>!=</c>) as a
/// bind-time element-wise desugar. <c>t1 == t2</c> becomes a
/// <see cref="BoundBlockExpression" /> that evaluates each operand exactly once
/// into a synthetic read-only temp, then folds the per-element comparisons
/// with short-circuiting <c>&amp;&amp;</c> (<c>||</c> of <c>!=</c> for
/// inequality), left-to-right — matching C# §12.12.10 evaluation order. Each
/// element pair is bound through the ordinary equality chain (built-in table,
/// user/CLR <c>op_*</c>, reference-equality last resort, nested-tuple
/// recursion), so user-declared element operators, string equality, and lifted
/// nullable elements behave exactly as they do outside a tuple. Dispatching to
/// <c>ValueTuple.Equals</c> instead was rejected because it would bypass
/// user-declared element operators. Arity is compared structurally — never by
/// <see cref="TupleTypeSymbol" /> reference identity.
/// </content>
/// ```
internal partial class ExpressionBinder {
    /// Binds `==` / `!=` whose operands are both tuple-typed.
    /// @param syntax The binary expression syntax.
    /// @param left The bound left tuple operand.
    /// @param right The bound right tuple operand.
    /// @returns The desugared block expression, or a (cref:BoundErrorExpression) after reporting.
    private func BindTupleEquality(
        syntax BinaryExpressionSyntax,
        left BoundExpression,
        right BoundExpression
    ) BoundExpression {
        let leftTuple = cast[TupleTypeSymbol](left.Type)
        let rightTuple = cast[TupleTypeSymbol](right.Type)
        let opLocation = syntax.OperatorToken.Location
        if leftTuple.Arity != rightTuple.Arity {
            Diagnostics.ReportTupleEqualityArityMismatch(
                opLocation,
                leftTuple,
                leftTuple.Arity,
                rightTuple,
                rightTuple.Arity
            )
            return BoundErrorExpression(nil)
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement](2)
        let leftReceiver = SpillTupleOperand(syntax, left, leftTuple, statements)
        let rightReceiver = SpillTupleOperand(syntax, right, rightTuple, statements)
        let comparison BoundExpression? = BindTupleElementwiseComparison(
            syntax.OperatorToken.Kind,
            leftReceiver,
            leftTuple,
            rightReceiver,
            rightTuple,
            opLocation,
            syntax.OperatorToken.Text,
            left,
            right
        )
        if comparison == nil {
            return BoundErrorExpression(nil)
        }
        return BoundBlockExpression(syntax, statements.MoveToImmutable(), comparison)
    }

    /// Declares a synthetic read-only temp initialized from a tuple operand so
    /// the operand is evaluated exactly once, and returns a variable reference
    /// to feed the element accesses.
    private func SpillTupleOperand(
        syntax SyntaxNode,
        operand BoundExpression,
        tupleType TupleTypeSymbol,
        statements ImmutableArray[BoundStatement].Builder
    ) BoundExpression {
        let tempName = "$$tupeq" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        let temp = LocalVariableSymbol(tempName, isReadOnly: true, tupleType)
        $scope.TryDeclareVariable(temp)
        statements.Add(BoundVariableDeclaration(syntax, temp, operand))
        return BoundVariableExpression(nil, temp)
    }

    /// Folds the per-element comparisons of two equal-arity tuple receivers.
    /// Reports every incomparable element pair (not just the first) and
    /// returns `null` if any element failed to bind.
    private func BindTupleElementwiseComparison(
        opKind SyntaxKind,
        leftReceiver BoundExpression,
        leftTuple TupleTypeSymbol,
        rightReceiver BoundExpression,
        rightTuple TupleTypeSymbol,
        opLocation TextLocation,
        opText string,
        leftSource BoundExpression?,
        rightSource BoundExpression?
    ) BoundExpression? {
        let foldKind = if opKind == SyntaxKind.EqualsEqualsToken {
            SyntaxKind.AmpersandAmpersandToken
        } else {
            SyntaxKind.PipePipeToken
        }
        var result BoundExpression? = nil
        var failed = false
        for var i = 0; i < leftTuple.Arity; i++ {
            let leftElement = BoundTupleElementAccessExpression(nil, leftReceiver, leftTuple, i)
            let rightElement = BoundTupleElementAccessExpression(nil, rightReceiver, rightTuple, i)
            let elementComparison BoundExpression? = TryBindElementEquality(
                opKind,
                leftElement,
                rightElement,
                opLocation,
                opText,
                if leftSource is BoundTupleLiteralExpression leftLiteral {
                    leftLiteral.Elements[i]
                } else {
                    nil
                },
                if rightSource is BoundTupleLiteralExpression rightLiteral {
                    rightLiteral.Elements[i]
                } else {
                    nil
                }
            )
            if elementComparison == nil {
                failed = true
                continue
            }
            if result == nil {
                result = elementComparison
                continue
            }
            let foldOperator = Invariant.Required(
                BoundBinaryOperator.Bind(foldKind, TypeSymbol.Bool, TypeSymbol.Bool),
                "bool && / || is always defined",
                expression: "BoundBinaryOperator.Bind(foldKind, TypeSymbol.Bool, TypeSymbol.Bool)"
            )
            result = BoundBinaryExpression(nil, result!!, foldOperator, elementComparison, binderCtx.IsCheckedContext)
        }
        return if failed {
            default(BoundExpression?)
        } else {
            result
        }
    }

    /// Binds a single element pair through the ordinary equality chain:
    /// nested-tuple recursion, then the built-in table (with numeric
    /// adaptation), user-defined and CLR `op_*` operators, and the
    /// reference-equality last resort. Reports GS0129 with the element types
    /// and returns `null` when nothing binds.
    private func TryBindElementEquality(
        opKind SyntaxKind,
        left BoundExpression,
        right BoundExpression,
        opLocation TextLocation,
        opText string,
        leftSource BoundExpression?,
        rightSource BoundExpression?
    ) BoundExpression? {
        var left = left
        var right = right
        if left.Type is TupleTypeSymbol nestedLeft && right.Type is TupleTypeSymbol nestedRight {
            if nestedLeft.Arity != nestedRight.Arity {
                Diagnostics.ReportTupleEqualityArityMismatch(
                    opLocation,
                    nestedLeft,
                    nestedLeft.Arity,
                    nestedRight,
                    nestedRight.Arity
                )
                return nil
            }
            // Nested elements are `ItemN` accesses on the outer temps, so
            // they are already single-evaluation — no further spilling.
            return BindTupleElementwiseComparison(
                opKind,
                left,
                nestedLeft,
                right,
                nestedRight,
                opLocation,
                opText,
                leftSource,
                rightSource
            )
        }
        var boundOperator BoundBinaryOperator? = BindBinaryOperatorWithNumericAdaptation(
            opKind,
            &left,
            &right,
            opLocation,
            opLocation
        )
        if boundOperator == nil {
            let constantLeft = PreserveTupleElementConstant(left, leftSource)
            let constantRight = PreserveTupleElementConstant(right, rightSource)
            if !object.ReferenceEquals(left, constantLeft) || !object.ReferenceEquals(right, constantRight) {
                left = constantLeft
                right = constantRight
                boundOperator = BindBinaryOperatorWithNumericAdaptation(opKind, &left, &right, opLocation, opLocation)
            }
        }
        if boundOperator != nil {
            return BoundBinaryExpression(nil, left, boundOperator, right, binderCtx.IsCheckedContext)
        }
        let fallback BoundExpression? = TryBindBinaryWithUserAndClrFallback(
            opKind,
            &left,
            &right,
            opLocation,
            opLocation,
            out var ambiguous
        )
        if fallback != nil {
            return fallback
        }
        if ambiguous {
            Diagnostics.ReportAmbiguousOverload(opLocation, opText, candidateCount: 2)
            return nil
        }
        if BoundBinaryOperator.IsReferenceEqualityOperand(left.Type) && BoundBinaryOperator.IsReferenceEqualityOperand(
            right.Type
        ) {
            let referenceOperator = BoundBinaryOperator.MakeReferenceEquality(opKind, left.Type, right.Type)
            return BoundBinaryExpression(nil, left, referenceOperator, right, binderCtx.IsCheckedContext)
        }
        Diagnostics.ReportUndefinedBinaryOperator(opLocation, opText, left.Type, right.Type)
        return nil
    }

    private func PreserveTupleElementConstant(element BoundExpression, source BoundExpression?) BoundExpression {
        // Spilling removes constant identity. Recover only proven integer constants, never storage reads or effects (#5399).
        if source != nil && IsIntegerType(source.Type) && !ConstantExpressionEvaluator.TryFindNativeInteger(
            source,
            out _
        ) &&
            ConstantExpressionEvaluator.TryEvaluate(source, out var value) && IsIntegerLiteralValue(value) {
            return BoundLiteralExpression(source.Syntax, value, source.Type)
        }
        return element
    }
}
