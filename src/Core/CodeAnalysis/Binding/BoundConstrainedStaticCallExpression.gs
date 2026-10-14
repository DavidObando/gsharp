// <copyright file="BoundConstrainedStaticCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Reflection

/// ADR-0089 / issue #755: a constrained static-virtual interface call site
/// of the form `T.Method(args)` where `T` is a generic
/// type-parameter constrained to (cref:InterfaceSymbol). The
/// emitter lowers this to the IL sequence
/// `constrained. !!T call !iface::Method(args)` (ECMA-335 §III.2.1);
/// the interpreter resolves (cref:InterfaceMethod) on the runtime
/// type-argument's (cref:StructSymbol.StaticMethods) table.
/// Issue #3525: the same call shape also covers a type-parameter constrained
/// to an imported CLR interface (e.g. `T : IParsable[T]`) — that
/// variant carries (cref:ClrMethod)/(cref:ConstrainedInterfaceType)
/// instead of (cref:InterfaceMethod).
class BoundConstrainedStaticCallExpression : BoundCallOperationExpression {
    private var calledFunction ImportedFunctionSymbol?

    /// Initializes a new instance of the (cref:BoundConstrainedStaticCallExpression) class for a
    /// source-interface static-virtual slot.
    /// @param syntax The originating syntax.
    /// @param typeParameter The receiver type parameter (the `T` in `T.M(...)`).
    /// @param interfaceMethod The static-virtual interface method symbol that supplies the slot.
    /// @param arguments The bound argument expressions in declared order.
    /// @param returnType The call-site (post-substitution) return type.
    init(
        syntax SyntaxNode?,
        typeParameter TypeParameterSymbol,
        interfaceMethod FunctionSymbol,
        arguments ImmutableArray[BoundExpression],
        returnType TypeSymbol
    ) : base(syntax) {
        TypeParameter = typeParameter
        InterfaceMethod = interfaceMethod
        _arguments = arguments
        ReturnType = returnType
    }

    /// Initializes a new instance of the (cref:BoundConstrainedStaticCallExpression) class for a
    /// static-virtual member declared by an imported CLR interface (issue #3525).
    /// @param syntax The originating syntax.
    /// @param typeParameter The receiver type parameter (the `T` in `T.M(...)`).
    /// @param clrMethod The static-virtual interface method resolved via reflection.
    /// @param arguments The bound argument expressions in declared (parameter) order.
    /// @param argumentRefKinds Per-argument ref-kind annotations (default all-None).
    /// @param returnType The call-site return type.
    /// @param constrainedInterfaceType The (possibly constructed generic) imported interface type that
    /// parents the emitted `MemberRef`.
    /// @param typeArgumentSymbols Recovered symbolic generic-method arguments used to reify the emitted
    /// MethodSpec.
    init(
        syntax SyntaxNode?,
        typeParameter TypeParameterSymbol,
        clrMethod MethodInfo,
        arguments ImmutableArray[BoundExpression],
        argumentRefKinds ImmutableArray[RefKind],
        returnType TypeSymbol,
        constrainedInterfaceType TypeSymbol,
        typeArgumentSymbols ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?])
    ) : base(syntax) {
        TypeParameter = typeParameter
        ClrMethod = clrMethod
        _arguments = arguments
        ArgumentRefKinds = if argumentRefKinds.IsDefault {
            default(ImmutableArray[RefKind])
        } else {
            argumentRefKinds
        }
        ReturnType = returnType
        ConstrainedInterfaceType = constrainedInterfaceType
        TypeArgumentSymbols = if typeArgumentSymbols.IsDefault {
            default(ImmutableArray[TypeSymbol?])
        } else {
            typeArgumentSymbols
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ConstrainedStaticCallExpression

    // `ClrMethod!` is safe for the same reason the Type fallback above is:
    // exactly one of InterfaceMethod/ClrMethod is set, and the only way to reach
    // that arm is InterfaceMethod being null, which happens exclusively via the
    // ClrMethod-taking constructor overload, which requires a non-null clrMethod.
    /// Gets the callee symbol. Exactly one of (cref:InterfaceMethod) and
    /// (cref:ClrMethod) is set, so this is always answerable.
    override prop CalledFunction Symbol -> InterfaceMethod ??
        cast[Symbol](
        (
            (
                if calledFunction == nil {
                    (calledFunction = BoundCallOperationExpression.ImportedCallee(ClrMethod!!, Type))
                } else {
                    calledFunction
                }
            )!!
        )
    )

    // ReturnType is always supplied by both constructors (see call sites), so this
    // fallback chain is dead in practice; ClrMethod! is safe because the only way
    // to reach it is InterfaceMethod being null, which happens exclusively via the
    // ClrMethod-taking constructor overload, which requires a non-null clrMethod.
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> ReturnType ?? InterfaceMethod?.Type ?? ClrNullability.GetReturnTypeSymbol(
        ClrMethod!!
    )

    /// Gets the type-parameter symbol that supplies the runtime receiver (the `T` in `T.M(...)`).
    prop TypeParameter TypeParameterSymbol {
        get;
    }

    /// Gets the static-virtual interface method symbol that supplies the slot, when the constraint is a
    /// source G# interface. `null` when (cref:ClrMethod) is set instead.
    prop InterfaceMethod FunctionSymbol? {
        get;
    }

    /// Gets the static-virtual interface method resolved via reflection, when the constraint is an imported
    /// CLR interface (issue #3525). `null` when (cref:InterfaceMethod) is set instead.
    prop ClrMethod MethodInfo? {
        get;
    }

    /// Gets the bound argument expressions in declared order.
    private var _arguments ImmutableArray[BoundExpression]

    override prop Arguments ImmutableArray[BoundExpression] -> _arguments

    /// Gets the per-argument ref-kind annotations for the (cref:ClrMethod) shape. May be default
    /// (all-None).
    prop ArgumentRefKinds ImmutableArray[RefKind] {
        get;
    }

    /// Gets the recovered symbolic generic-method arguments for the imported CLR slot.
    prop TypeArgumentSymbols ImmutableArray[TypeSymbol?] {
        get;
    }

    /// Gets the call-site (post-substitution) return type, or `null` to fall back to
    /// (cref:InterfaceMethod).(cref:FunctionSymbol.Type).
    prop ReturnType TypeSymbol {
        get;
    }

    /// Gets the (possibly constructed generic) imported interface type that
    /// parents the emitted `MemberRef` for the (cref:ClrMethod)
    /// shape (issue #3525) — e.g. `System.IParsable[T]`. `null` for
    /// the source-interface shape.
    prop ConstrainedInterfaceType TypeSymbol? {
        get;
    }
}
