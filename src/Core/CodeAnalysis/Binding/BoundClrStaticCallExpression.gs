// <copyright file="BoundClrStaticCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable
import System.Reflection

/// Represents a call to a CLR static method resolved at compile time via (cref:MethodInfo).
/// Used by synthesized code (state-machine bodies) where no user-facing symbol exists.
class BoundClrStaticCallExpression : BoundCallOperationExpression {
    private var calledFunction ImportedFunctionSymbol?

    init(
        syntax SyntaxNode?,
        method MethodInfo,
        returnType TypeSymbol,
        arguments ImmutableArray[BoundExpression],
        argumentRefKinds ImmutableArray[RefKind] = default(ImmutableArray[RefKind])
    ) : base(syntax) {
        Method = method
        _type = returnType
        _arguments = arguments
        ArgumentRefKinds = if argumentRefKinds.IsDefault {
            default(ImmutableArray[RefKind])
        } else {
            argumentRefKinds
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ClrStaticCallExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop CalledFunction Symbol -> (
        if calledFunction == nil {
            (calledFunction = BoundCallOperationExpression.ImportedCallee(Method, Type))
        } else {
            calledFunction
        }
    )!!

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type

    /// Gets the static CLR method to call.
    prop Method MethodInfo {
        get;
    }

    /// Gets the provided arguments.
    private var _arguments ImmutableArray[BoundExpression]

    override prop Arguments ImmutableArray[BoundExpression] -> _arguments

    /// Gets the per-argument ref-kind annotations. May be default (all-None).
    prop ArgumentRefKinds ImmutableArray[RefKind] {
        get;
    }

    /// Creates an equivalent call with replacement arguments.
    /// @param arguments The replacement arguments.
    /// @returns An equivalent call containing [`arguments`](paramref).
    func WithArguments(arguments ImmutableArray[BoundExpression]) BoundClrStaticCallExpression {
        if !ArgumentRefKinds.IsDefault && ArgumentRefKinds.Length != arguments.Length {
            throw ArgumentException("Replacement arguments must preserve the tracked ref-kind arity.", "arguments")
        }
        return BoundClrStaticCallExpression(Syntax, Method, Type, arguments, ArgumentRefKinds)
    }

    /// Creates an equivalent call with replacement arguments and ref kinds.
    /// @param arguments The replacement arguments.
    /// @param argumentRefKinds The replacement per-argument ref kinds.
    /// @returns An equivalent call containing the replacements.
    func WithArguments(
        arguments ImmutableArray[BoundExpression],
        argumentRefKinds ImmutableArray[RefKind]
    ) BoundClrStaticCallExpression -> BoundClrStaticCallExpression(Syntax, Method, Type, arguments, argumentRefKinds)
}
