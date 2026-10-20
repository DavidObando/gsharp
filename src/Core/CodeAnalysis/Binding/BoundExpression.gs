// <copyright file="BoundExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound expression.
abstract class BoundExpression : BoundNode {
    /// Initializes a new instance of the (cref:BoundExpression) class.
    /// @param syntax The originating syntax.
    protected init(syntax SyntaxNode?) : base(syntax) { }

    /// Gets the bound expression type.
    abstract prop Type TypeSymbol {
        get;
    }

    /// Gets or sets the source operand of a binder-created implicit conversion.
    /// This binding-time provenance is not a tree child or a lowering contract.
    internal prop ImplicitConversionOperand BoundExpression? {
        get;
        set;
    }

    internal prop StaticQualifierType TypeSymbol? {
        get;
        private set;
    }

    internal prop StaticQualifierSyntax ExpressionSyntax? {
        get;
        private set;
    }

    internal prop StaticMemberSyntax ExpressionSyntax? {
        get;
        private set;
    }

    /// Retains the actual type-receiver decision before inherited syntax anchors
    /// lose its provenance. These references are not bound/syntax tree children.
    internal func RecordStaticQualifier(type TypeSymbol, member ExpressionSyntax) {
        if StaticQualifierType != nil {
            return
        }
        var current SyntaxNode = member
        while true {
            if current.Parent is IndexExpressionSyntax index && object.ReferenceEquals(index.Target, current) {
                current = index
            } else if current.Parent is AccessorExpressionSyntax accessor && object.ReferenceEquals(
                accessor.LeftPart,
                current
            ) {
                current = accessor
            } else {
                break
            }
        }
        if current.Parent is AccessorExpressionSyntax owner && object.ReferenceEquals(owner.RightPart, current) {
            StaticQualifierType = type
            StaticQualifierSyntax = owner.LeftPart
            StaticMemberSyntax = member
        }
    }

    /// Gets the compile-time constant value of this expression — the Roslyn
    /// `ConstantValue` analogue (ADR-0169). `HasValue` is false
    /// when the expression has no compile-time constant; a constant null
    /// literal reports `HasValue` true with a null `Value`.
    open prop ConstantValue OptionalValue -> default(OptionalValue)
}
