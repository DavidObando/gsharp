// <copyright file="BoundBaseInterfaceCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// ADR-0091 / issue #757: an explicit-base interface call expression of
/// the form `base[IFoo].Method(args)`. Lets a class member delegate
/// to a specific interface's inherited default method (DIM) body, either
/// to disambiguate a diamond (ADR-0085 GS0318) or to augment a default
/// from inside an override. The emitter lowers this to a non-virtual
/// `call instance R IFoo::Method(...)`; the interpreter dispatches
/// directly to the interface method body without re-entering the
/// implementer's v-table.
class BoundBaseInterfaceCallExpression : BoundCallOperationExpression {
    /// Initializes a new instance of the (cref:BoundBaseInterfaceCallExpression) class.
    /// @param syntax The originating syntax.
    /// @param receiver The implicit `this` receiver of the enclosing instance member.
    /// @param interfaceSymbol The interface named in `base[IFoo]`.
    /// @param method The interface method whose default body is invoked. Must satisfy
    /// (cref:InterfaceSymbol.HasDefaultBody).
    /// @param arguments The bound argument expressions in declared order.
    init(
        syntax SyntaxNode?,
        receiver BoundExpression,
        interfaceSymbol InterfaceSymbol,
        method FunctionSymbol,
        arguments ImmutableArray[BoundExpression]
    ) : base(syntax) {
        Receiver = receiver
        Interface = interfaceSymbol
        Method = method
        _arguments = arguments
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.BaseInterfaceCallExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop CalledFunction Symbol -> Method

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> Method.Type

    /// Gets the implicit `this` receiver — a (cref:BoundVariableExpression) reading the enclosing method's
    /// first parameter.
    prop Receiver BoundExpression {
        get;
    }

    /// Gets the interface named in `base[IFoo]`.
    prop Interface InterfaceSymbol {
        get;
    }

    /// Gets the interface method whose default body is invoked.
    prop Method FunctionSymbol {
        get;
    }

    /// Gets the bound argument expressions in declared order.
    private var _arguments ImmutableArray[BoundExpression]

    override prop Arguments ImmutableArray[BoundExpression] -> _arguments
}
