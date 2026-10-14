// <copyright file="BoundImportedInstanceCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Reflection

/// Bound call expression for an instance method invoked on a value whose type
/// originates from a CLR (cref:System.Type).
class BoundImportedInstanceCallExpression : BoundCallOperationExpression {
    private var calledFunction ImportedFunctionSymbol?

    /// Initializes a new instance of the (cref:BoundImportedInstanceCallExpression) class.
    /// @param syntax The originating syntax.
    /// @param receiver The expression that produces the instance.
    /// @param method The (cref:MethodInfo) to invoke.
    /// @param returnType The bound return type.
    /// @param arguments The provided arguments.
    /// @param argumentRefKinds Per-argument ref-kind annotations (default all-None).
    /// @param typeArgumentSymbols Issue #320: when the call site supplied an explicit generic type-argument
    /// list (e.g. `provider.GetService[Clock]()`), the resolved type-argument
    /// (cref:TypeSymbol)s in source order. Used by the emitter to encode the
    /// generic method specification so user-defined type arguments (which have no
    /// reference-context CLR type) are written as their own TypeDef token. Default
    /// when there are no explicit type arguments.
    /// @param constrainedReceiverTypeParameter Issue #943: when the call is dispatched through a type
    /// parameter's CLR
    /// interface constraint (e.g. `a.CompareTo(b)` with `T : IComparable[T]`),
    /// the constrained type parameter whose address feeds a `constrained.`
    /// prefix. Default for ordinary imported instance calls.
    /// @param constrainedInterfaceType Issue #943: the symbolic (possibly constructed generic) interface
    /// type
    /// that parents the emitted `MemberRef` for a constrained call. Default
    /// for ordinary imported instance calls.
    /// @param isNonVirtualBaseCall Issue #1260: when `true`, this call originates from a
    /// `base.Member(...)` (or `base.Prop`) access into an imported/BCL
    /// base class and must be emitted with a non-virtual `call` (not
    /// `callvirt`), exactly like C# `base.M(...)` — otherwise the
    /// virtual dispatch would re-enter the derived override and recurse
    /// infinitely. Default `false` for ordinary imported
    /// instance calls.
    init(
        syntax SyntaxNode?,
        receiver BoundExpression,
        method MethodInfo,
        returnType TypeSymbol,
        arguments ImmutableArray[BoundExpression],
        argumentRefKinds ImmutableArray[RefKind] = default(ImmutableArray[RefKind]),
        typeArgumentSymbols ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?]),
        constrainedReceiverTypeParameter TypeParameterSymbol? = nil,
        constrainedInterfaceType TypeSymbol? = nil,
        isNonVirtualBaseCall bool = false
    ) : base(syntax) {
        Receiver = receiver
        Method = method
        // Issue #3802: a `[return: NotNullIfNotNull(nameof(p))]` post-condition
        // is a fact about THIS call, so it narrows the node's type, never the
        // declared return type read from metadata.
        _type = ConditionalReturnNarrowing.Apply(method, arguments, returnType)
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
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter
        ConstrainedInterfaceType = constrainedInterfaceType
        IsNonVirtualBaseCall = isNonVirtualBaseCall
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ImportedInstanceCallExpression

    /// Gets the called method as a symbol (ADR-0169, issue #3920). Built on
    /// demand from (cref:Method) with THIS node's return type, so an
    /// imported generic method closed over a user-defined type reports the
    /// constructed type rather than the reflected placeholder (PR #3968
    /// review).
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

    /// Gets the receiver expression.
    prop Receiver BoundExpression {
        get;
    }

    /// Gets the method to invoke.
    prop Method MethodInfo {
        get;
    }

    /// Gets the bound arguments.
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

    /// Gets the type parameter the call is constrained through, when the
    /// receiver is a value of a generic type parameter whose interface
    /// constraint declares the invoked method (issue #943, e.g. calling
    /// `a.CompareTo(b)` where `a : T` and `T : IComparable[T]`).
    /// When non-`null`, the emitter loads the receiver by address, prefixes
    /// the call with `constrained. !!T`, and parents the `MemberRef` at
    /// (cref:ConstrainedInterfaceType) so the IL is verifiable for both
    /// value-type and reference-type substitutions. `null` for an ordinary
    /// imported instance call.
    prop ConstrainedReceiverTypeParameter TypeParameterSymbol? {
        get;
    }

    /// Gets the (possibly constructed-generic) interface type that parents the
    /// emitted `MemberRef` when (cref:ConstrainedReceiverTypeParameter)
    /// is set (issue #943) — e.g. `System.IComparable[T]`. `null` for an
    /// ordinary imported instance call.
    prop ConstrainedInterfaceType TypeSymbol? {
        get;
    }

    /// Gets a value indicating whether this call dispatches through a type-parameter interface constraint
    /// (issue #943).
    @MemberNotNullWhen(true, "ConstrainedReceiverTypeParameter")
    prop IsConstrainedTypeParameterCall bool -> ConstrainedReceiverTypeParameter != nil

    /// Gets a value indicating whether this call originates from a
    /// `base.Member(...)`/`base.Prop` access into an imported/BCL base
    /// class (issue #1260), which the emitter lowers with a non-virtual
    /// `call` rather than `callvirt` so it does not re-enter the derived
    /// override.
    prop IsNonVirtualBaseCall bool {
        get;
    }
}
