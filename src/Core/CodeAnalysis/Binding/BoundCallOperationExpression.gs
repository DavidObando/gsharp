// <copyright file="BoundCallOperationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Reflection

/// The shape shared by every bound node that CALLS a method (ADR-0169, issue
/// #3920).
/// @remarks G# binds a call to a different node for each callee provenance —
/// same-compilation static and instance, imported static and instance,
/// constrained static-virtual, base-interface, and raw CLR static. Roslyn
/// models all of them as one `IInvocationOperation`.
///
/// The split is a codegen distinction, not a program-meaning one, and an
/// analyzer that does not know it silently sees a fraction of the calls in the
/// program. Covering only the first three left `receiver.Method()` — the
/// most ordinary call there is, a `BoundUserInstanceCallExpression` —
/// invisible to every migrated invocation rule (PR #3968 review). The concrete
/// nodes and their (cref:BoundNode.Kind) values are unchanged.
///
/// Two call shapes deliberately stay outside this base because they have no
/// callee symbol to report: `BoundIndirectCallExpression` invokes a
/// delegate VALUE, and `BoundBaseClassCallExpression`'s property-accessor
/// form carries neither a `FunctionSymbol` nor a `MethodInfo`.
/// Constructor calls are excluded by design — Roslyn models those as
/// `ObjectCreation`, not `Invocation`.
abstract class BoundCallOperationExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundCallOperationExpression) class.
    /// @param syntax The originating syntax.
    internal init(syntax SyntaxNode?) : base(syntax) { }

    /// Gets the symbol of the called method — the Roslyn
    /// `IInvocationOperation.TargetMethod` analogue. Typed as
    /// (cref:Symbol): a same-compilation callee is a
    /// (cref:FunctionSymbol) and an imported one an
    /// (cref:ImportedFunctionSymbol), and (cref:Symbol.Name) and
    /// (cref:Symbol.ContainingType) — the members the Roslyn call-site
    /// surface maps onto — are meaningful on both.
    /// @remarks Deliberately NOT a richer callee type. The two other members a migrated
    /// analyzer reaches through `TargetMethod` cannot be answered from
    /// this symbol honestly (PR #3968 review):
    /// - `ReturnType` — the callee symbol carries the DECLARATION's return type, so a constructed generic
    /// call reports `T` where the call site produces `int32`. cs2gs maps `TargetMethod.ReturnType` to the
    /// call node's own (cref:BoundExpression.Type), which is the constructed type.
    /// - `OverriddenMethod` — an imported callee has no override chain in G#, so exposing it here would
    /// answer null for every call into metadata. A member that silently returns null for the common case is
    /// worse than an absent one, because analyzers branch on it; it is absent, and cs2gs reports reaching
    /// it as a gap.
    abstract prop CalledFunction Symbol {
        get;
    }

    /// Gets the candidates overload resolution considered for this call: (cref:FunctionSymbol)s or
    /// reflected methods, in the order the resolver held them, or the default array when the resolver
    /// had a single candidate (ADR-0212 slice S4).
    internal prop MemberGroup ImmutableArray[object] {
        get;
        set;
    }

    /// Gets the arguments, in source order.
    abstract prop Arguments ImmutableArray[BoundExpression] {
        get;
    }

    shared {
        /// Builds the callee symbol for a node that stores the reflected method
        /// rather than a symbol. Only the analyzer surface needs one, so it is
        /// built on demand by the caller and cached there.
        /// @param method The reflected callee.
        /// @param returnType The CALL SITE's return type, which is what the node already computed:
        /// an imported generic method closed over a user-defined type reflects a
        /// placeholder return type, so deriving it from [`method`](paramref)
        /// would report the placeholder (PR #3968 review).
        /// @returns The callee symbol.
        internal func ImportedCallee(
            method MethodInfo,
            returnType TypeSymbol
        ) ImportedFunctionSymbol -> ImportedFunctionSymbol(
            method.Name,
            ImportedClassSymbol(method.DeclaringType ?? typeof(object), declaration: nil),
            method,
            declaration: nil,
            returnTypeOverride: returnType
        )
    }
}
