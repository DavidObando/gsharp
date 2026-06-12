// <copyright file="ExpressionBinder.Operators.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class ExpressionBinder
{
    private BoundExpression BindUnaryExpression(UnaryExpressionSyntax syntax)
    {
        // Phase 5.5 / ADR-0022: prefix `<-ch` is a channel-receive expression,
        // not a unary operator. Route to a dedicated binder so the operator
        // table doesn't need a per-element-type entry.
        if (syntax.OperatorToken.Kind == SyntaxKind.LeftArrowToken)
        {
            return BindChannelReceiveExpression(syntax);
        }

        // ADR-0039: `&expr` — address-of (managed by-ref pointer).
        if (syntax.OperatorToken.Kind == SyntaxKind.AmpersandToken)
        {
            return BindAddressOfExpression(syntax);
        }

        // ADR-0039: `*expr` — dereference a by-ref pointer.
        if (syntax.OperatorToken.Kind == SyntaxKind.StarToken)
        {
            return BindDereferenceExpression(syntax);
        }

        var boundOperand = BindExpression(syntax.Operand);

        if (boundOperand.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var boundOperator = BoundUnaryOperator.Bind(syntax.OperatorToken.Kind, boundOperand.Type);

        if (boundOperator == null)
        {
            // Stream D: try user-defined `func (a T) operator <op>() R` on the
            // operand's user type. Same-package methods bind onto the struct
            // (Phase 6.4); the receiver is Parameters[0] (Parameters.Length==1
            // for unary ops). Extension-function fallback also covered.
            var userOpName = OperatorNames.TryGetUnaryName(syntax.OperatorToken.Kind);
            if (userOpName != null && boundOperand.Type != null)
            {
                FunctionSymbol userOp = null;
                bool isStructReceiver = false;
                if (boundOperand.Type is StructSymbol operandStruct && operandStruct.TryGetMethodIncludingInherited(userOpName, out var structOp))
                {
                    userOp = structOp;
                    isStructReceiver = true;
                }
                else if (scope.TryLookupExtensionFunction(boundOperand.Type, userOpName, out var extOp))
                {
                    userOp = extOp;
                }

                if (userOp != null && userOp.Parameters.Length == 1)
                {
                    var convertedOperand = conversions.BindConversion(syntax.Operand.Location, boundOperand, userOp.Parameters[0].Type);
                    if (isStructReceiver)
                    {
                        return new BoundUserInstanceCallExpression(null, convertedOperand, userOp, ImmutableArray<BoundExpression>.Empty);
                    }

                    return new BoundCallExpression(null, userOp, ImmutableArray.Create(convertedOperand));
                }
            }

            // Stream C: fall back to a public-static unary `op_*` method on
            // the operand's CLR type (`-time`, `~bits`, ...).
            var ambiguous = false;
            if (boundOperand.Type?.ClrType != null
                && ClrOperatorResolution.TryResolveUnary(syntax.OperatorToken.Kind, boundOperand.Type, out var clrMethod, out ambiguous))
            {
                return new BoundClrUnaryOperatorExpression(
                    null,
                    syntax.OperatorToken.Kind,
                    boundOperand,
                    clrMethod,
                    TypeSymbol.FromClrType(clrMethod.ReturnType));
            }
            else if (ambiguous)
            {
                Diagnostics.ReportAmbiguousOverload(syntax.OperatorToken.Location, syntax.OperatorToken.Text, candidateCount: 2);
                return new BoundErrorExpression(null);
            }

            Diagnostics.ReportUndefinedUnaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, boundOperand.Type);
            return new BoundErrorExpression(null);
        }

        return new BoundUnaryExpression(null, boundOperator, boundOperand);
    }

    /// <summary>ADR-0039: Binds <c>&amp;expr</c> — takes managed pointer to an lvalue.</summary>
    private BoundExpression BindAddressOfExpression(UnaryExpressionSyntax syntax)
    {
        // ADR-0061: `&(cond ? a : b)` and `&cond ? a : b` (parser tail
        // form). Dispatch to the conditional ref-argument binder, which
        // produces a BoundConditionalAddressExpression of type `T&`.
        // The operand may be wrapped in parens by the parser; unwrap.
        var rawOperand = syntax.Operand;
        while (rawOperand is ParenthesizedExpressionSyntax pen)
        {
            rawOperand = pen.Expression;
        }

        if (rawOperand is ConditionalRefArgumentExpressionSyntax condOperand)
        {
            return conversions.BindConditionalRefArgument(condOperand, outerModifier: null);
        }

        // ADR-0062: a general conditional expression as the operand of `&`
        // binds to the conditional-address path (preserving ADR-0061 byref
        // safety) when both arms are lvalues of a common pointee type.
        if (rawOperand is ConditionalExpressionSyntax generalCond)
        {
            return BindConditionalAddressFromGeneral(generalCond, outerModifier: null);
        }

        var operand = BindExpression(syntax.Operand);
        if (operand is BoundErrorExpression)
        {
            return operand;
        }

        // GS9005: cannot take address of a constant binding.
        if (operand is BoundVariableExpression bve && bve.Variable.IsReadOnly)
        {
            // ADR-0060: address-of an `in` parameter would let callers write
            // through the pointer, defeating the read-only contract. Report
            // GS0237 instead of the generic "cannot take address of constant".
            if (bve.Variable is ParameterSymbol inParam && inParam.RefKind == RefKind.In)
            {
                Diagnostics.ReportCannotAssignToInParameter(syntax.OperatorToken.Location, inParam.Name);
            }
            else
            {
                Diagnostics.ReportCannotTakeAddressOfConstant(syntax.OperatorToken.Location, bve.Variable.Name);
            }

            return new BoundErrorExpression(null);
        }

        // Lvalue check.
        if (!IsLvalue(operand))
        {
            var exprText = syntax.Operand.ToString();
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.OperatorToken.Location, exprText);
            return new BoundErrorExpression(null);
        }

        return new BoundAddressOfExpression(null, operand);
    }

    /// <summary>ADR-0039: Binds <c>*expr</c> — dereferences a managed pointer.</summary>
    private BoundExpression BindDereferenceExpression(UnaryExpressionSyntax syntax)
    {
        var operand = BindExpression(syntax.Operand);
        if (operand is BoundErrorExpression)
        {
            return operand;
        }

        if (operand.Type is not ByRefTypeSymbol)
        {
            Diagnostics.ReportUndefinedUnaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, operand.Type);
            return new BoundErrorExpression(null);
        }

        return new BoundDereferenceExpression(null, operand);
    }

    /// <summary>
    /// ADR-0062: binds a general two-arm conditional expression in value
    /// context. Validates the condition is <c>bool</c>, computes a common
    /// result type using identity / one-way implicit conversion / numeric
    /// tie-break rules, and produces a <see cref="BoundConditionalExpression"/>.
    /// </summary>
    /// <param name="syntax">The conditional expression syntax.</param>
    /// <returns>The bound conditional expression, or a <see cref="BoundErrorExpression"/> on failure.</returns>
    private BoundExpression BindConditionalExpression(ConditionalExpressionSyntax syntax)
    {
        var condition = BindExpression(syntax.Condition, TypeSymbol.Bool);
        var whenTrue = BindExpression(syntax.WhenTrue);
        var whenFalse = BindExpression(syntax.WhenFalse);

        if (condition is BoundErrorExpression || whenTrue is BoundErrorExpression || whenFalse is BoundErrorExpression)
        {
            return new BoundErrorExpression(null);
        }

        var resultType = ComputeConditionalCommonType(whenTrue.Type, whenFalse.Type);
        if (resultType == null)
        {
            Diagnostics.ReportConditionalNoCommonResultType(
                syntax.Location,
                whenTrue.Type?.Name ?? "?",
                whenFalse.Type?.Name ?? "?");
            return new BoundErrorExpression(null);
        }

        var convertedTrue = ConvertConditionalBranch(syntax.WhenTrue.Location, whenTrue, resultType);
        var convertedFalse = ConvertConditionalBranch(syntax.WhenFalse.Location, whenFalse, resultType);
        if (convertedTrue is BoundErrorExpression || convertedFalse is BoundErrorExpression)
        {
            return new BoundErrorExpression(null);
        }

        return new BoundConditionalExpression(null, condition, convertedTrue, convertedFalse, resultType);
    }

    /// <summary>
    /// Issue #669: binds an if-expression to a <see cref="BoundConditionalExpression"/>
    /// (the same bound node used by the ternary operator). Multi-statement blocks
    /// are lowered to <see cref="BoundBlockExpression"/> wrapping the final value.
    /// </summary>
    private BoundExpression BindIfExpression(IfExpressionSyntax syntax)
    {
        // An if-expression in value position must have an else branch.
        if (syntax.ElseExpression == null)
        {
            Diagnostics.ReportIfExpressionMissingElse(syntax.IfKeyword.Location);
            return new BoundErrorExpression(null);
        }

        var condition = BindExpression(syntax.Condition, TypeSymbol.Bool);

        var whenTrue = BindBlockExpressionValue(syntax.ThenBlock);
        var whenFalse = BindIfExpressionElseBranch(syntax.ElseExpression);

        if (condition is BoundErrorExpression || whenTrue is BoundErrorExpression || whenFalse is BoundErrorExpression)
        {
            return new BoundErrorExpression(null);
        }

        var resultType = ComputeConditionalCommonType(whenTrue.Type, whenFalse.Type);
        if (resultType == null)
        {
            Diagnostics.ReportConditionalNoCommonResultType(
                syntax.Location,
                whenTrue.Type?.Name ?? "?",
                whenFalse.Type?.Name ?? "?");
            return new BoundErrorExpression(null);
        }

        var convertedTrue = ConvertConditionalBranch(syntax.ThenBlock.Location, whenTrue, resultType);
        var convertedFalse = ConvertConditionalBranch(syntax.ElseExpression.Location, whenFalse, resultType);
        if (convertedTrue is BoundErrorExpression || convertedFalse is BoundErrorExpression)
        {
            return new BoundErrorExpression(null);
        }

        return new BoundConditionalExpression(null, condition, convertedTrue, convertedFalse, resultType);
    }

    /// <summary>
    /// Binds the else branch of an if-expression: either a nested if-expression
    /// (<c>else if</c> chain) or a block expression.
    /// </summary>
    private BoundExpression BindIfExpressionElseBranch(ExpressionSyntax elseSyntax)
    {
        if (elseSyntax is IfExpressionSyntax nestedIf)
        {
            return BindIfExpression(nestedIf);
        }

        if (elseSyntax is BlockExpressionSyntax block)
        {
            return BindBlockExpressionValue(block);
        }

        // Should not happen from well-formed parse trees.
        return new BoundErrorExpression(null);
    }

    /// <summary>
    /// Binds a block-with-trailing-expression in value position. If the block
    /// has no trailing expression, reports a diagnostic. The result is either
    /// the bound trailing expression (when there are no prefix statements), or
    /// a <see cref="BoundBlockExpression"/> wrapping the prefix statements and
    /// the trailing value.
    /// </summary>
    private BoundExpression BindBlockExpressionValue(BlockExpressionSyntax syntax)
    {
        if (syntax.Expression == null)
        {
            Diagnostics.ReportBlockExpressionMissingTrailingExpression(syntax.CloseBraceToken.Location);
            return new BoundErrorExpression(null);
        }

        // If there are no prefix statements, just bind the expression directly.
        if (syntax.Statements.IsDefaultOrEmpty)
        {
            return BindExpression(syntax.Expression);
        }

        // Bind prefix statements.
        var boundStatements = ImmutableArray.CreateBuilder<BoundStatement>();
        foreach (var stmt in syntax.Statements)
        {
            var boundStmt = bindStatement(stmt);
            boundStatements.Add(boundStmt);
        }

        var boundExpression = BindExpression(syntax.Expression);
        if (boundExpression is BoundErrorExpression)
        {
            return boundExpression;
        }

        return new BoundBlockExpression(null, boundStatements.ToImmutable(), boundExpression);
    }

    /// <summary>
    /// ADR-0074 / issue #714: binds the body of an arrow lambda
    /// <c>(p T) -&gt; body</c>. The body is either a single expression
    /// (returned as the lambda's value) or a brace-delimited block
    /// expression. Unlike <see cref="BindBlockExpressionValue"/>, a block
    /// body without a trailing expression is permitted — it produces a
    /// <see cref="TypeSymbol.Void"/>-returning lambda.
    /// </summary>
    /// <param name="bodySyntax">The lambda body syntax.</param>
    /// <returns>The bound body expression. <see cref="TypeSymbol.Void"/> is
    /// allowed; a missing-trailing-expression block lowers to a
    /// <see cref="BoundBlockExpression"/> whose trailing expression is a
    /// synthesized <see cref="BoundLiteralExpression"/> placeholder of type
    /// <see cref="TypeSymbol.Void"/>.</returns>
    internal BoundExpression BindLambdaBodyExpression(ExpressionSyntax bodySyntax)
    {
        if (bodySyntax is BlockExpressionSyntax block)
        {
            // Lambda body block: a missing trailing expression means a void
            // lambda. Bind any prefix statements; if there is a trailing
            // expression, use it as the value; otherwise the value is void.
            var boundStatements = ImmutableArray.CreateBuilder<BoundStatement>();
            if (!block.Statements.IsDefaultOrEmpty)
            {
                foreach (var stmt in block.Statements)
                {
                    boundStatements.Add(bindStatement(stmt));
                }
            }

            if (block.Expression == null)
            {
                // No trailing expression — surface as a void-returning body.
                // Re-package the prefix statements via a BoundBlockExpression
                // wrapping a synthetic void placeholder; the LambdaBinder
                // treats void bodies by emitting an ExpressionStatement +
                // void return.
                if (boundStatements.Count == 0)
                {
                    // Empty body `{ }` — synthesize a no-op void expression.
                    return new BoundLiteralExpression(bodySyntax, value: 0, TypeSymbol.Void);
                }

                return new BoundBlockExpression(
                    bodySyntax,
                    boundStatements.ToImmutable(),
                    new BoundLiteralExpression(bodySyntax, value: 0, TypeSymbol.Void));
            }

            var trailing = BindExpression(block.Expression, canBeVoid: true);
            if (boundStatements.Count == 0)
            {
                return trailing;
            }

            return new BoundBlockExpression(bodySyntax, boundStatements.ToImmutable(), trailing);
        }

        return BindExpression(bodySyntax, canBeVoid: true);
    }

    /// <summary>
    /// ADR-0062: chooses a common result type for two conditional branches
    /// using the following ordered rules (mirroring the ADR §2 common-type
    /// procedure):
    /// <list type="number">
    ///   <item><description>Identity (<c>Tx == Ty</c>).</description></item>
    ///   <item><description>One-way implicit conversion (<c>Tx → Ty</c> but not <c>Ty → Tx</c>, or vice versa).</description></item>
    ///   <item><description>Both convertible implicitly — pick the wider via the numeric tie-break rule (ADR-0037) when both are numeric; otherwise no common type.</description></item>
    ///   <item><description><c>nil</c> compatibility — when one arm is the nil/null sentinel and the other is reference- or nullable-compatible, use the other arm's type.</description></item>
    /// </list>
    /// Returns <see langword="null"/> when no common type exists.
    /// </summary>
    /// <param name="left">The true-arm type.</param>
    /// <param name="right">The false-arm type.</param>
    /// <returns>The chosen common type, or <see langword="null"/>.</returns>
    private static TypeSymbol ComputeConditionalCommonType(TypeSymbol left, TypeSymbol right)
    {
        if (left == null || right == null)
        {
            return null;
        }

        if (left == TypeSymbol.Error || right == TypeSymbol.Error)
        {
            return TypeSymbol.Error;
        }

        // Identity.
        if (ReferenceEquals(left, right))
        {
            return left;
        }

        // Nil/null compatibility: when one arm is the null sentinel and the
        // other is non-null, pick the non-null. The conversion machinery
        // accepts the trivial null → reference/nullable widening.
        if (left == TypeSymbol.Null)
        {
            return right;
        }

        if (right == TypeSymbol.Null)
        {
            return left;
        }

        var leftToRight = Conversion.Classify(left, right);
        var rightToLeft = Conversion.Classify(right, left);

        bool leftImplicit = leftToRight.IsImplicit;
        bool rightImplicit = rightToLeft.IsImplicit;

        // Identity already handled; treat IsIdentity here as implicit too.
        if (leftImplicit && !rightImplicit)
        {
            return right;
        }

        if (rightImplicit && !leftImplicit)
        {
            return left;
        }

        if (leftImplicit && rightImplicit)
        {
            // ADR-0037 numeric tie-break: prefer the wider canonical numeric
            // target when both arms are numeric.
            var widened = TryNumericTieBreak(left, right);
            if (widened != null)
            {
                return widened;
            }

            // Both convert to each other and neither is numeric — they're
            // effectively identical; pick the left arm deterministically.
            return left;
        }

        return null;
    }

    /// <summary>
    /// ADR-0037-style numeric tie-break: when both arms are numeric primitives,
    /// pick the wider canonical type using a simple rank. Returns
    /// <see langword="null"/> when either type isn't a recognised primitive.
    /// </summary>
    private static TypeSymbol TryNumericTieBreak(TypeSymbol a, TypeSymbol b)
    {
        int ra = NumericRank(a);
        int rb = NumericRank(b);
        if (ra == 0 || rb == 0)
        {
            return null;
        }

        return ra >= rb ? a : b;
    }

    private static int NumericRank(TypeSymbol t)
    {
        if (t == TypeSymbol.Int8 || t == TypeSymbol.UInt8)
        {
            return 1;
        }

        if (t == TypeSymbol.Int16 || t == TypeSymbol.UInt16)
        {
            return 2;
        }

        if (t == TypeSymbol.Int32 || t == TypeSymbol.UInt32)
        {
            return 3;
        }

        if (t == TypeSymbol.Int64 || t == TypeSymbol.UInt64)
        {
            return 4;
        }

        if (t == TypeSymbol.Float32)
        {
            return 5;
        }

        if (t == TypeSymbol.Float64)
        {
            return 6;
        }

        return 0;
    }

    private BoundExpression ConvertConditionalBranch(TextLocation location, BoundExpression branch, TypeSymbol target)
    {
        if (target == TypeSymbol.Error || branch.Type == TypeSymbol.Error)
        {
            return branch;
        }

        if (ReferenceEquals(branch.Type, target))
        {
            return branch;
        }

        return conversions.BindConversion(location, branch, target);
    }

    private BoundExpression BindChannelReceiveExpression(UnaryExpressionSyntax syntax)
    {
        var operand = BindExpression(syntax.Operand);
        if (operand is BoundErrorExpression)
        {
            return operand;
        }

        if (operand.Type is not ChannelTypeSymbol chan)
        {
            Diagnostics.ReportReceiveOperandIsNotChannel(syntax.Operand.Location, operand.Type);
            return new BoundErrorExpression(null);
        }

        return new BoundChannelReceiveExpression(null, operand, chan.ElementType);
    }

    private BoundExpression BindBinaryExpression(BinaryExpressionSyntax syntax)
    {
        var boundLeft = BindExpression(syntax.Left);

        // ADR-0069 / issue #700: `&&` short-circuits — the right operand is
        // only evaluated when the left operand was true. Thread any
        // narrowing implied by the left operand into the right-operand
        // binder so `x is T && f(x)` binds `f(x)` with `x` narrowed to `T`.
        //
        // ADR-0069 addendum / issue #712: `||` short-circuits too — the
        // right operand is only evaluated when the left operand was false.
        // Thread the left's else-frame (its negative narrowing) so
        // `!(x is T) || f(x)` binds `f(x)` with `x` narrowed to `T`.
        BoundExpression boundRight;
        if (syntax.OperatorToken.Kind == SyntaxKind.AmpersandAmpersandToken)
        {
            var rightFrame = TryClassifyTypeTestNarrowingForAnd(boundLeft);
            boundRight = BindExpressionWithNarrowing(syntax.Right, rightFrame);
        }
        else if (syntax.OperatorToken.Kind == SyntaxKind.PipePipeToken)
        {
            var rightFrame = TryClassifyTypeTestNarrowingForOr(boundLeft);
            boundRight = BindExpressionWithNarrowing(syntax.Right, rightFrame);
        }
        else
        {
            boundRight = BindExpression(syntax.Right);
        }

        if (boundLeft.Type == TypeSymbol.Error || boundRight.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var boundOperator = BoundBinaryOperator.Bind(syntax.OperatorToken.Kind, boundLeft.Type, boundRight.Type);

        // PR N-4 / §6.1 / C# §7.3.7: mixed-mode lift. When one operand is
        // a value-type Nullable<T> and the other is its underlying T, lift
        // T to T? via the existing implicit conversion and re-bind. The
        // re-bound operator hits the lifted arm in BoundBinaryOperator.Bind
        // which returns a (T?, T?) operator; the converted operands then
        // match its declared operand types so emit can rely on both sides
        // being Nullable<T> at the operator site.
        if (boundOperator == null)
        {
            if (boundLeft.Type is NullableTypeSymbol leftNullable
                && leftNullable.UnderlyingType?.ClrType is { IsValueType: true }
                && boundRight.Type == leftNullable.UnderlyingType)
            {
                var lifted = BoundBinaryOperator.Bind(syntax.OperatorToken.Kind, leftNullable, leftNullable);
                if (lifted != null)
                {
                    boundRight = conversions.BindConversion(syntax.Right.Location, boundRight, leftNullable);
                    boundOperator = lifted;
                }
            }
            else if (boundRight.Type is NullableTypeSymbol rightNullable
                && rightNullable.UnderlyingType?.ClrType is { IsValueType: true }
                && boundLeft.Type == rightNullable.UnderlyingType)
            {
                var lifted = BoundBinaryOperator.Bind(syntax.OperatorToken.Kind, rightNullable, rightNullable);
                if (lifted != null)
                {
                    boundLeft = conversions.BindConversion(syntax.Left.Location, boundLeft, rightNullable);
                    boundOperator = lifted;
                }
            }
        }

        // 6.6 / §6.1: mixed-mode lift for heterogeneous nullable operands.
        // Handles enum? + int32 → lift int32 to int32?, then re-bind as
        // (enum?, int32?) which the heterogeneous lifted arm resolves.
        // Also handles int32 + enum? → lift int32 to int32?.
        if (boundOperator == null)
        {
            if (boundLeft.Type is NullableTypeSymbol leftN2
                && boundRight.Type is not NullableTypeSymbol
                && boundRight.Type?.ClrType is { IsValueType: true })
            {
                var rightLifted = NullableTypeSymbol.Get(boundRight.Type);
                var lifted = BoundBinaryOperator.Bind(syntax.OperatorToken.Kind, leftN2, rightLifted);
                if (lifted != null)
                {
                    boundRight = conversions.BindConversion(syntax.Right.Location, boundRight, rightLifted);
                    boundOperator = lifted;
                }
            }
            else if (boundRight.Type is NullableTypeSymbol rightN2
                && boundLeft.Type is not NullableTypeSymbol
                && boundLeft.Type?.ClrType is { IsValueType: true })
            {
                var leftLifted = NullableTypeSymbol.Get(boundLeft.Type);
                var lifted = BoundBinaryOperator.Bind(syntax.OperatorToken.Kind, leftLifted, rightN2);
                if (lifted != null)
                {
                    boundLeft = conversions.BindConversion(syntax.Left.Location, boundLeft, leftLifted);
                    boundOperator = lifted;
                }
            }
        }

        if (boundOperator == null)
        {
            // Stream D: try user-defined `func (a T) operator <op>(b U) R` on
            // either operand's user type. Same-package operators are bound as
            // methods on the struct (Phase 6.4); the receiver is at
            // Parameters[0] (so binary ops have Parameters.Length == 2).
            var userOpName = OperatorNames.TryGetBinaryName(syntax.OperatorToken.Kind);
            if (userOpName != null)
            {
                FunctionSymbol userOp = null;
                bool leftIsStructReceiver = false;
                bool rightIsStructReceiver = false;
                if (boundLeft.Type is StructSymbol leftStruct && leftStruct.TryGetMethodIncludingInherited(userOpName, out var leftOp))
                {
                    userOp = leftOp;
                    leftIsStructReceiver = true;
                }
                else if (boundRight.Type is StructSymbol rightStruct && rightStruct.TryGetMethodIncludingInherited(userOpName, out var rightOp))
                {
                    userOp = rightOp;
                    rightIsStructReceiver = true;
                }
                else if (boundLeft.Type != null && scope.TryLookupExtensionFunction(boundLeft.Type, userOpName, out var leftExt))
                {
                    userOp = leftExt;
                }
                else if (boundRight.Type != null && scope.TryLookupExtensionFunction(boundRight.Type, userOpName, out var rightExt))
                {
                    userOp = rightExt;
                }

                if (userOp != null && userOp.Parameters.Length == 2)
                {
                    var convertedLeft = conversions.BindConversion(syntax.Left.Location, boundLeft, userOp.Parameters[0].Type);
                    var convertedRight = conversions.BindConversion(syntax.Right.Location, boundRight, userOp.Parameters[1].Type);
                    if (leftIsStructReceiver)
                    {
                        return new BoundUserInstanceCallExpression(null, convertedLeft, userOp, ImmutableArray.Create(convertedRight));
                    }

                    if (rightIsStructReceiver)
                    {
                        return new BoundUserInstanceCallExpression(null, convertedRight, userOp, ImmutableArray.Create(convertedLeft));
                    }

                    return new BoundCallExpression(null, userOp, ImmutableArray.Create(convertedLeft, convertedRight));
                }
            }

            // Stream C: fall back to a public-static `op_*` method on either
            // operand's CLR type (TimeSpan + TimeSpan, BigInteger * int, ...).
            var ambiguous = false;
            if ((boundLeft.Type?.ClrType != null || boundRight.Type?.ClrType != null)
                && ClrOperatorResolution.TryResolveBinary(syntax.OperatorToken.Kind, boundLeft.Type, boundRight.Type, out var clrMethod, out ambiguous))
            {
                return new BoundClrBinaryOperatorExpression(
                    null,
                    syntax.OperatorToken.Kind,
                    boundLeft,
                    boundRight,
                    clrMethod,
                    TypeSymbol.FromClrType(clrMethod.ReturnType));
            }
            else if (ambiguous)
            {
                Diagnostics.ReportAmbiguousOverload(syntax.OperatorToken.Location, syntax.OperatorToken.Text, candidateCount: 2);
                return new BoundErrorExpression(null);
            }

            Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, boundLeft.Type, boundRight.Type);
            return new BoundErrorExpression(null);
        }

        return new BoundBinaryExpression(null, boundLeft, boundOperator, boundRight);
    }
}
