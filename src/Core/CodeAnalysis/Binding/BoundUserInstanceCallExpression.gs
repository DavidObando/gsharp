// <copyright file="BoundUserInstanceCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis

/// Calls an instance method declared inside a user-defined class body
/// (Phase 3.B.3 sub-step 2b): `receiver.Method(args)`. The implicit
/// `this` argument is the bound receiver; user arguments correspond
/// 1:1 with (cref:FunctionSymbol.Parameters).
class BoundUserInstanceCallExpression : BoundCallOperationExpression {
    private let returnTypeOverride TypeSymbol?

    convenience init(
        syntax SyntaxNode?,
        receiver BoundExpression,
        method FunctionSymbol,
        arguments ImmutableArray[BoundExpression]
    ) {
        init(syntax, receiver, method, arguments, nil)
    }

    convenience init(
        syntax SyntaxNode?,
        receiver BoundExpression,
        method FunctionSymbol,
        arguments ImmutableArray[BoundExpression],
        returnTypeOverride TypeSymbol?
    ) {
        init(syntax, receiver, method, arguments, returnTypeOverride, nil, nil)
    }

    init(
        syntax SyntaxNode?,
        receiver BoundExpression,
        method FunctionSymbol,
        arguments ImmutableArray[BoundExpression],
        returnTypeOverride TypeSymbol?,
        constrainedReceiverTypeParameter TypeParameterSymbol?,
        constrainedInterfaceType TypeSymbol?
    ) : base(syntax) {
        Receiver = receiver
        Method = method
        _arguments = arguments
        this.returnTypeOverride = returnTypeOverride
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter
        ConstrainedInterfaceType = constrainedInterfaceType
    }

    prop Receiver BoundExpression {
        get;
    }

    prop Method FunctionSymbol {
        get;
    }

    private var _arguments ImmutableArray[BoundExpression]
    override prop Arguments ImmutableArray[BoundExpression] -> _arguments

    /// Gets the call-site (explicit or inferred) method type arguments for a
    /// generic instance method call, positionally aligned with
    /// (cref:FunctionSymbol.TypeParameters) on (cref:Method), or
    /// a default (empty) array for a non-generic method. Issue #1931: bind
    /// time already resolves this substitution (from an explicit `[T]` list or
    /// argument-type inference) to convert arguments/return type, but that
    /// substitution was previously discarded once bound whenever it did not
    /// affect the return type — forcing the emitter to blindly re-derive the
    /// method type arguments via structural unification over the (possibly
    /// uninformative, e.g. a bare `nil`) argument expressions, which can
    /// fail even though the call was validly bound. Stashing the resolved
    /// arguments here lets the emitter use the authoritative bind-time result
    /// directly.
    prop MethodTypeArguments ImmutableArray[TypeSymbol] {
        get;
        internal set;
    }

    /// Gets the type parameter whose user-declared interface constraint backs
    /// this call when it dispatches through a constraint (issue #1052), e.g.
    /// `x.Area()` where `x : T` and `T : IShape`. The emitter then
    /// produces a verifiable `constrained. !!T callvirt IShape::Area()`
    /// sequence instead of a bare `callvirt` on the unboxed type parameter.
    /// Null for ordinary user-instance calls.
    prop ConstrainedReceiverTypeParameter TypeParameterSymbol? {
        get;
    }

    /// Gets the user-declared interface (possibly a constructed generic
    /// interface) that backs (cref:ConstrainedReceiverTypeParameter)
    /// (issue #1052). Null for ordinary user-instance calls.
    prop ConstrainedInterfaceType TypeSymbol? {
        get;
    }

    @MemberNotNullWhen(true, "ConstrainedReceiverTypeParameter")
    prop IsConstrainedTypeParameterCall bool -> ConstrainedReceiverTypeParameter != nil

    override prop Type TypeSymbol -> returnTypeOverride ?? Method.Type
    override prop Kind BoundNodeKind -> BoundNodeKind.UserInstanceCallExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop CalledFunction Symbol -> Method
}
