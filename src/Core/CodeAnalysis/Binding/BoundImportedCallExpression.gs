// <copyright file="BoundImportedCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Bound call expression.
class BoundImportedCallExpression : BoundCallOperationExpression {
    /// Initializes a new instance of the (cref:BoundImportedCallExpression) class.
    /// @param syntax The originating syntax.
    /// @param function The function symbol.
    /// @param arguments The provided arguments.
    /// @param argumentRefKinds Per-argument ref-kind annotations (default all-None).
    /// @param typeArgumentSymbols Issue #320: when the call site supplied an explicit generic type-argument
    /// list closing an imported generic method (e.g.
    /// `services.AddSingleton[Clock]()`), the resolved type-argument
    /// (cref:TypeSymbol)s in source order. Used by the emitter to encode the
    /// generic method specification so user-defined type arguments are written as
    /// their own TypeDef token. Default when there are no explicit type arguments.
    /// @param staticContainerType Issue #1330: the symbolic constructed container for a static call on a
    /// generic type constructed over an in-scope generic type parameter (e.g.
    /// `Comparer[TResult].Create(...)`), used by the emitter to parent the
    /// call at the constructed generic TypeSpec. Default for an ordinary call.
    init(
        syntax SyntaxNode?,
        function ImportedFunctionSymbol,
        arguments ImmutableArray[BoundExpression],
        argumentRefKinds ImmutableArray[RefKind] = default(ImmutableArray[RefKind]),
        typeArgumentSymbols ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?]),
        staticContainerType TypeSymbol? = nil
    ) : base(syntax) {
        Function = function
        _arguments = arguments
        ArgumentRefKinds = if argumentRefKinds.IsDefault {
            default(ImmutableArray[RefKind])
        } else {
            argumentRefKinds
        }
        TypeArgumentSymbols = if typeArgumentSymbols.IsDefault {
            default(ImmutableArray[TypeSymbol?])
        } else {
            typeArgumentSymbols
        }
        StaticContainerType = staticContainerType
        // Issue #3802: a `[return: NotNullIfNotNull(nameof(p))]` post-condition
        // is a fact about THIS call, so it narrows the node's type, never the
        // declared `Function.Type`.
        _type = ConditionalReturnNarrowing.Apply(function.Method, arguments, function.Type)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ImportedCallExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop CalledFunction Symbol -> Function

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type

    /// Gets the imported function symbol.
    prop Function ImportedFunctionSymbol {
        get;
    }

    /// Gets the provided arguments.
    private var _arguments ImmutableArray[BoundExpression]

    override prop Arguments ImmutableArray[BoundExpression] -> _arguments

    /// Gets the per-argument ref-kind annotations. May be default (all-None).
    prop ArgumentRefKinds ImmutableArray[RefKind] {
        get;
    }

    /// Gets the explicit generic type-argument symbols, in source order, when the
    /// call site supplied a `[T1, T2]` list closing an imported generic
    /// method (issue #320). Default when there are no explicit type arguments.
    prop TypeArgumentSymbols ImmutableArray[TypeSymbol?] {
        get;
    }

    /// Gets the symbolic constructed container (#1330) for a static call on a
    /// generic type constructed over an in-scope generic type parameter (e.g.
    /// `Comparer[TResult].Create(...)`). An (cref:ImportedTypeSymbol)
    /// over the open definition with symbolic type arguments; the emitter parents
    /// the static call at this constructed `Comparer<!TResult>`
    /// TypeSpec instead of the type-erased `Comparer<object>`.
    /// `null` for an ordinary imported call.
    prop StaticContainerType TypeSymbol? {
        get;
    }
}
