// <copyright file="BoundClrBinaryOperatorExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Reflection

/// User-defined binary operator resolved to a public static operator method,
/// identified by C#-style operator name (e.g. `op_Addition`,
/// `op_Equality`). Stream C lets GSharp source write `a + b`
/// against operator-bearing CLR types such as `TimeSpan`,
/// `BigInteger`, or `System.Numerics.Vector2`, resolved via
/// (cref:Method) (a reflection (cref:MethodInfo)).
/// @remarks Issue #2388: this node is ALSO reused for the nullable-lifted form of a
/// same-compilation struct's Stream D user-defined operator (`func (a T)
/// operator ==(b T) bool`) when one or both operands are a value-type
/// `Nullable<T>` — that scenario has no reflection
/// (cref:MethodInfo) available at bind time (the declaring struct is
/// still (cref:System.Reflection.Emit.TypeBuilder)-backed), so
/// (cref:Function) carries the same-compilation
/// (cref:FunctionSymbol) instead. Exactly one of (cref:Method)
/// / (cref:Function) is non-null. Sharing one node type lets the
/// nullable-lifting machinery in `SlotPlanner` /
/// `MethodBodyEmitter.Operators` (`LiftedBinarySlots` /
/// `EmitLiftedNullableClrBinary`) drive both the imported-CLR-type and
/// same-compilation-struct cases uniformly.
class BoundClrBinaryOperatorExpression : BoundBinaryOperationExpression {
    convenience init(
        syntax SyntaxNode?,
        operatorKind SyntaxKind,
        left BoundExpression,
        right BoundExpression,
        method MethodInfo?,
        resultType TypeSymbol
    ) {
        init(syntax, operatorKind, left, right, method, nil, nil, resultType)
    }

    convenience init(
        syntax SyntaxNode?,
        operatorKind SyntaxKind,
        left BoundExpression,
        right BoundExpression,
        function FunctionSymbol,
        resultType TypeSymbol
    ) {
        init(syntax, operatorKind, left, right, function, function?.StaticOwnerType as StructSymbol, resultType)
    }

    convenience init(
        syntax SyntaxNode?,
        operatorKind SyntaxKind,
        left BoundExpression,
        right BoundExpression,
        function FunctionSymbol,
        functionOwnerType StructSymbol?,
        resultType TypeSymbol
    ) {
        init(syntax, operatorKind, left, right, nil, function, functionOwnerType, resultType)
    }

    private init(
        syntax SyntaxNode?,
        operatorKind SyntaxKind,
        left BoundExpression,
        right BoundExpression,
        method MethodInfo?,
        function FunctionSymbol?,
        functionOwnerType StructSymbol?,
        resultType TypeSymbol
    ) : base(syntax) {
        OperatorKind = operatorKind
        _left = left
        _right = right
        Method = method
        Function = function
        FunctionOwnerType = functionOwnerType
        _type = resultType
    }

    prop OperatorKind SyntaxKind {
        get;
    }

    private var _left BoundExpression
    override prop Left BoundExpression -> _left
    private var _right BoundExpression
    override prop Right BoundExpression -> _right

    /// Gets the resolved imported-CLR-type operator method, or `null` when (cref:Function) is used instead.
    prop Method MethodInfo? {
        get;
    }

    /// Gets the resolved same-compilation struct operator function (issue
    /// #2388), used for the nullable-lifted Stream D case instead of
    /// (cref:Method). `null` for the ordinary
    /// (imported-CLR-type or non-nullable Stream D) shape.
    prop Function FunctionSymbol? {
        get;
    }

    /// Gets the same-compilation operator's declaring type in the call-site
    /// construction (issue #2400), or `null` for imported CLR
    /// operators. The emitter uses this to parent calls on a closed generic
    /// TypeSpec rather than the open declaring TypeDef.
    prop FunctionOwnerType StructSymbol? {
        get;
    }

    private var _type TypeSymbol
    override prop Type TypeSymbol -> _type
    override prop Kind BoundNodeKind -> BoundNodeKind.ClrBinaryOperatorExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop BinaryOperatorKind BoundBinaryOperatorKind -> BoundBinaryOperationExpression.FromSyntaxKind(
        OperatorKind
    )
}
