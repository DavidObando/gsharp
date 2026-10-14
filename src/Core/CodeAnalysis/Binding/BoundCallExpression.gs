// <copyright file="BoundCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Bound call expression.
class BoundCallExpression : BoundCallOperationExpression {
    /// Initializes a new instance of the (cref:BoundCallExpression) class.
    /// @param syntax The originating syntax.
    /// @param function The function symbol.
    /// @param arguments The provided arguments.
    convenience init(syntax SyntaxNode?, function FunctionSymbol, arguments ImmutableArray[BoundExpression]) {
        init(syntax, function, arguments, nil)
    }

    /// Initializes a new instance of the (cref:BoundCallExpression) class with an explicit (substituted)
    /// return type for generic-call sites (Phase 4.1 / ADR-0020).
    /// @param syntax The originating syntax.
    /// @param function The function symbol.
    /// @param arguments The provided arguments.
    /// @param returnType The (already-substituted) call-site return type, or `null` to use `function.Type`.
    convenience init(
        syntax SyntaxNode?,
        function FunctionSymbol,
        arguments ImmutableArray[BoundExpression],
        returnType TypeSymbol?
    ) {
        init(syntax, function, arguments, returnType, false)
    }

    /// Initializes a new instance of the (cref:BoundCallExpression)
    /// class, optionally marking it as a `[Conditional]`-elided call
    /// (ADR-0047 §6 / issue #176). When elided the emitter and interpreter
    /// emit / evaluate no IL or behaviour at the call site, and the argument
    /// list is empty because C# semantics forbid evaluating arguments to a
    /// conditional method whose symbol is undefined.
    /// @param syntax The originating syntax.
    /// @param function The function symbol.
    /// @param arguments The provided arguments; empty when elided.
    /// @param returnType The (already-substituted) call-site return type, or `null` to use `function.Type`.
    /// @param isConditionalElided When `true`, the call has been elided per `[Conditional]` rules.
    init(
        syntax SyntaxNode?,
        function FunctionSymbol,
        arguments ImmutableArray[BoundExpression],
        returnType TypeSymbol?,
        isConditionalElided bool
    ) : base(syntax) {
        Function = function
        _arguments = arguments
        ReturnType = returnType
        IsConditionalElided = isConditionalElided
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.CallExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop CalledFunction Symbol -> Function

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> ReturnType ?? Function.Type

    /// Gets, for issue #1209, the constructed generic user type when a
    /// static (`shared`) method is dispatched on a constructed generic user
    /// type (`Box[int32].Make()`), so the emitter parents the call at the
    /// construction's `TypeSpec` (mirroring the static-field and
    /// static-property paths). `null` for ordinary calls and for
    /// non-generic static receivers (which use the bare accessor `MethodDef`).
    prop StaticGenericOwnerType StructSymbol? {
        get;
        internal set;
    }

    /// Gets, for issue #1433, the constructed generic interface when a static
    /// (`shared`) method is dispatched on a constructed generic interface
    /// (`IBox[int32].Create()`), so the emitter parents the call at the
    /// construction's `TypeSpec` (mirroring the interface static-field path
    /// of issue #1030). `null` for ordinary calls, non-generic
    /// interface receivers, and struct/class receivers (which use
    /// (cref:StaticGenericOwnerType) or a bare `MethodDef`).
    prop StaticGenericInterfaceOwnerType InterfaceSymbol? {
        get;
        internal set;
    }

    /// Gets the function symbol.
    prop Function FunctionSymbol {
        get;
    }

    /// Gets the provided arguments.
    private var _arguments ImmutableArray[BoundExpression]

    override prop Arguments ImmutableArray[BoundExpression] -> _arguments

    /// Gets the call-site (post-substitution) return type for generic-function calls, or `null` for
    /// non-generic calls. Phase 4.1 / ADR-0020.
    prop ReturnType TypeSymbol? {
        get;
    }

    /// Gets the call-site (explicit or inferred) method type arguments for a
    /// generic top-level/static function call, positionally aligned with
    /// (cref:FunctionSymbol.TypeParameters) on (cref:Function),
    /// or a default (empty) array for a non-generic call. Issue #1931: mirrors
    /// (cref:BoundUserInstanceCallExpression.MethodTypeArguments) so the
    /// emitter can use the authoritative bind-time substitution instead of
    /// blindly re-inferring it from (possibly uninformative) argument shapes.
    prop MethodTypeArguments ImmutableArray[TypeSymbol] {
        get;
        internal set;
    }

    /// Gets a value indicating whether this call has been elided by
    /// `[Conditional]` processing (ADR-0047 §6 / issue #176). When
    /// `true`, the emitter and interpreter must not evaluate the
    /// receiver, the arguments, or invoke the target method; the call is a
    /// no-op of type `void` at the call site.
    prop IsConditionalElided bool {
        get;
    }
}
