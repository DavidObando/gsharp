// <copyright file="ClosureValue.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic

/// Runtime representation of a function-literal value (Phase 4.7, interpreter-only).
/// Captures the synthetic function symbol, body, signature, and a value-snapshot of captured locals.
class ClosureValue {
    /// Initializes a new instance of the (cref:ClosureValue) class.
    /// @param function The synthetic function symbol.
    /// @param body The lambda body.
    /// @param functionType The function-type signature.
    /// @param capturedLocals Value-snapshot of captured locals at literal-evaluation time.
    /// @param capturedTypeArguments Generic type-argument bindings visible at literal-evaluation time.
    init(
        function FunctionSymbol,
        body BoundBlockStatement,
        functionType FunctionTypeSymbol,
        capturedLocals Dictionary[VariableSymbol, object],
        capturedTypeArguments Dictionary[TypeParameterSymbol, TypeSymbol]
    ) {
        Function = function
        Body = body
        FunctionType = functionType
        CapturedLocals = capturedLocals
        CapturedTypeArguments = capturedTypeArguments
    }

    /// Gets the synthetic function symbol.
    prop Function FunctionSymbol {
        get;
    }

    /// Gets the lambda body.
    prop Body BoundBlockStatement {
        get;
    }

    /// Gets the function type.
    prop FunctionType FunctionTypeSymbol {
        get;
    }

    /// Gets the captured locals snapshot.
    prop CapturedLocals Dictionary[VariableSymbol, object] {
        get;
    }

    /// Gets the captured generic type-argument bindings.
    prop CapturedTypeArguments Dictionary[TypeParameterSymbol, TypeSymbol] {
        get;
    }
}
