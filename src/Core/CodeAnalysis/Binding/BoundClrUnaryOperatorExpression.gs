// <copyright file="BoundClrUnaryOperatorExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Reflection

/// User-defined unary operator on an imported CLR type, resolved to a public
/// static (cref:MethodInfo) (`op_UnaryNegation`,
/// `op_UnaryPlus`, `op_LogicalNot`, `op_OnesComplement`).
/// Stream C companion to (cref:BoundClrBinaryOperatorExpression).
class BoundClrUnaryOperatorExpression : BoundExpression {
    init(
        syntax SyntaxNode?,
        operatorKind SyntaxKind,
        operand BoundExpression,
        method MethodInfo,
        resultType TypeSymbol
    ) : base(syntax) {
        OperatorKind = operatorKind
        Operand = operand
        Method = method
        _type = resultType
    }

    prop OperatorKind SyntaxKind {
        get;
    }

    prop Operand BoundExpression {
        get;
    }

    prop Method MethodInfo {
        get;
    }

    private var _type TypeSymbol
    override prop Type TypeSymbol -> _type
    override prop Kind BoundNodeKind -> BoundNodeKind.ClrUnaryOperatorExpression
}
