// <copyright file="BoundFunctionPointerFromMethodExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// ADR-0122 §9 / issue #1035. The result of taking the address of a static
/// method as a function pointer — `&StaticMethod`. Emits the CIL
/// `ldftn <method>` opcode, pushing the method's entry-point address
/// as a managed function pointer value. Its result type is a managed
/// (cref:FunctionPointerTypeSymbol) matching the method's signature.
class BoundFunctionPointerFromMethodExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundFunctionPointerFromMethodExpression) class.
    /// @param syntax The originating syntax (may be `null` for lowered nodes).
    /// @param method The target static method whose address is taken.
    /// @param type The managed function-pointer type produced.
    init(syntax SyntaxNode?, method FunctionSymbol, type FunctionPointerTypeSymbol) : base(syntax) {
        Method = method
        FunctionPointerType = type
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.FunctionPointerFromMethodExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> FunctionPointerType

    /// Gets the target static method whose address is taken.
    prop Method FunctionSymbol {
        get;
    }

    /// Gets the managed function-pointer type produced.
    prop FunctionPointerType FunctionPointerTypeSymbol {
        get;
    }
}
