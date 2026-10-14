// <copyright file="BoundMethodGroupExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Issue #324 / ADR-0063 §9: a bare reference to a named function used in a
/// value context (C#/F# "method group"). A single non-generic candidate is
/// bound eagerly. Overloaded and generic candidates defer selection and generic
/// inference to `BindConversion`, where the target delegate signature is
/// available.
class BoundMethodGroupExpression : BoundMethodReferenceOperationExpression {
    convenience init(syntax SyntaxNode?, function FunctionSymbol, type FunctionTypeSymbol) {
        init(syntax, nil, function, type)
    }

    convenience init(syntax SyntaxNode?, candidates ImmutableArray[FunctionSymbol]) {
        init(syntax, nil, candidates)
    }

    convenience init(syntax SyntaxNode?, receiver BoundExpression?, function FunctionSymbol, type FunctionTypeSymbol) {
        init(syntax, receiver, function, type, nil, default(ImmutableArray[TypeSymbol]))
    }

    init(
        syntax SyntaxNode?,
        receiver BoundExpression?,
        function FunctionSymbol,
        type FunctionTypeSymbol,
        staticOwnerType StructSymbol?,
        methodTypeArguments ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol])
    ) : base(syntax) {
        Receiver = receiver
        Function = function
        FunctionType = type
        Candidates = ImmutableArray.Create(function)
        StaticOwnerType = staticOwnerType
        MethodTypeArguments = methodTypeArguments
    }

    convenience init(syntax SyntaxNode?, receiver BoundExpression?, candidates ImmutableArray[FunctionSymbol]) {
        init(syntax, receiver, candidates, nil)
    }

    init(
        syntax SyntaxNode?,
        receiver BoundExpression?,
        candidates ImmutableArray[FunctionSymbol],
        staticOwnerType StructSymbol?
    ) : base(syntax) {
        Receiver = receiver
        Function = if candidates.IsDefaultOrEmpty {
            default(FunctionSymbol?)
        } else {
            candidates[0]
        }
        FunctionType = nil
        Candidates = candidates
        StaticOwnerType = staticOwnerType
    }

    /// Gets the bound receiver expression for an instance method group, or
    /// `null` for a static/free-function method group. When
    /// non-null, the emitter binds the resulting delegate's `Target` to
    /// this receiver (`ldarg/ldfld; ldftn` or `dup; ldvirtftn`).
    prop Receiver BoundExpression? {
        get;
    }

    prop Function FunctionSymbol? {
        get;
    }

    prop FunctionType FunctionTypeSymbol? {
        get;
    }

    /// Gets every candidate overload sharing the source name. Equals
    /// `[Function]` when there is a single candidate.
    prop Candidates ImmutableArray[FunctionSymbol] {
        get;
    }

    /// Gets the type used to qualify a static method group.
    prop StaticOwnerType StructSymbol? {
        get;
    }

    /// Gets the inferred type arguments for a generic source method.
    prop MethodTypeArguments ImmutableArray[TypeSymbol] {
        get;
    }

    /// Gets a value indicating whether contextual conversion supplied
    /// the delegate/function target represented by this resolved group.
    prop HasTargetDelegateType bool {
        get;
        init;
    }

    /// Gets a value indicating whether the delegate must capture the BASE
    /// implementation non-virtually (issue #3501: `base.M` used as a
    /// method group — `ldftn` even though the method is open/override,
    /// exactly like C#'s `base.M` delegate conversion).
    prop ForceNonVirtualDispatch bool {
        get;
        init;
    }

    override prop Type TypeSymbol -> FunctionType ?? cast[TypeSymbol](TypeSymbol.Error)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Method Symbol? -> Function ??
        (
        if Candidates.IsDefaultOrEmpty {
            default(FunctionSymbol?)
        } else {
            Candidates[0]
        }
    )

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Instance BoundExpression? -> Receiver

    override prop Kind BoundNodeKind -> BoundNodeKind.MethodGroupExpression
}
