// <copyright file="BoundInitializationPlan.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Linq

/// Emit-local constructor/type-initializer storage, separate from cached declaration symbols.
internal class BoundInitializationPlan {
    internal init(
        function FunctionSymbol,
        arguments ImmutableArray[BoundExpression],
        prologue BoundBlockStatement,
        body BoundBlockStatement
    ) {
        Function = function
        Arguments = arguments
        Prologue = prologue
        Body = body
    }

    internal prop Function FunctionSymbol {
        get;
    }

    internal prop Arguments ImmutableArray[BoundExpression] {
        get;
    }

    internal prop Prologue BoundBlockStatement {
        get;
    }

    internal prop Body BoundBlockStatement {
        get;
    }

    internal func Rewrite(
        expression(BoundExpression) -> BoundExpression,
        statement(BoundStatement) -> BoundStatement
    ) BoundInitializationPlan {
        let arguments = Arguments.Select(expression).ToImmutableArray()
        let prologue = cast[BoundBlockStatement](statement(Prologue))
        let body = cast[BoundBlockStatement](statement(Body))
        return if arguments.SequenceEqual(Arguments) && prologue == Prologue && body == Body {
            this
        } else {
            BoundInitializationPlan(Function, arguments, prologue, body)
        }
    }
}
