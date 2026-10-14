// <copyright file="BoundFunctionPointerInvocationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// ADR-0122 §9 / issue #1035. A direct invocation through a function-pointer
/// value — `fp(args)`. Emits the CIL `calli` opcode with the
/// function pointer's standalone signature (managed or unmanaged calling
/// convention). Its result type is the function pointer's return type.
class BoundFunctionPointerInvocationExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundFunctionPointerInvocationExpression) class.
    /// @param syntax The originating syntax.
    /// @param pointer The function-pointer expression to invoke.
    /// @param arguments The converted call arguments.
    /// @param functionPointerType The function-pointer type being invoked.
    init(
        syntax SyntaxNode?,
        pointer BoundExpression,
        arguments ImmutableArray[BoundExpression],
        functionPointerType FunctionPointerTypeSymbol
    ) : base(syntax) {
        Pointer = pointer
        Arguments = arguments
        FunctionPointerType = functionPointerType
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.FunctionPointerInvocationExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> FunctionPointerType.ReturnType

    /// Gets the function-pointer expression to invoke.
    prop Pointer BoundExpression {
        get;
    }

    /// Gets the converted call arguments.
    prop Arguments ImmutableArray[BoundExpression] {
        get;
    }

    /// Gets the function-pointer type being invoked.
    prop FunctionPointerType FunctionPointerTypeSymbol {
        get;
    }
}
