// <copyright file="ParameterSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax

internal enum ParameterRefScope {
    Caller,
    ReturnOnly,
    FunctionLocal
}

internal enum ParameterValueScope {
    Caller,
    FunctionLocal
}

/// Represents a function declaration parameter symbol in the language.
class ParameterSymbol : LocalVariableSymbol {
    private var hasUnscopedRef bool
    private var usesUpdatedEscapeRules bool = true

    /// Initializes a new instance of the (cref:ParameterSymbol) class.
    /// @param name The parameter name.
    /// @param type The parameter type (already wrapped in `SliceTypeSymbol` if variadic).
    /// @param isVariadic Whether the parameter is variadic (Phase 4.8).
    /// @param declaringSyntax The originating parameter-declaration syntax (may be `null`
    /// for compiler-synthesised parameters — async kickoff `<>sm_this`,
    /// state-machine builder receivers, etc.). Consumed by the PDB emitter for
    /// arg-display in debuggers.
    /// @param isScoped Whether the parameter carries the `scoped` modifier (ADR-0058 / issue #376).
    /// When `true`, the parameter's safe-to-escape scope is restricted to the
    /// current function body and returning its value is rejected.
    /// @param refKind ADR-0060: the by-reference passing mode of this parameter (`none`, `ref`, `out`, or
    /// `in`).
    /// Defaults to (cref:Binding.RefKind.None). When non-`None`, the parameter's signature-effective
    /// type is the managed pointer `T&`; inside the body the symbol's (cref:Type) remains the
    /// pointee type `T` and reads/writes are implicitly indirected.
    init(
        name string,
        type TypeSymbol,
        isVariadic bool = false,
        declaringSyntax SyntaxNode? = nil,
        isScoped bool = false,
        refKind RefKind = RefKind.None
    ) : base(name, refKind == RefKind.None || refKind == RefKind.In, type, declaringSyntax) {
        IsVariadic = isVariadic
        IsScoped = isScoped
        RefKind = refKind
    }

    /// Initializes a new instance of the (cref:ParameterSymbol) class
    /// with a substituted type and the same ref-safety contract as [`source`](paramref).
    /// @param source The parameter whose contract is copied.
    /// @param type The substituted parameter type.
    /// @param declaringSyntax The syntax to associate with the clone, if any.
    /// @param name An optional synthesized name for the clone.
    internal convenience init(
        source ParameterSymbol,
        type TypeSymbol,
        declaringSyntax SyntaxNode? = nil,
        name string? = nil
    ) {
        init(name ?? source.Name, type, source.IsVariadic, declaringSyntax, source.IsScoped, source.RefKind)
        hasUnscopedRef = source.HasUnscopedRef
        usesUpdatedEscapeRules = source.UsesUpdatedEscapeRules
        IsReceiverParameter = source.IsReceiverParameter
        IsUnscopedRefReceiver = source.IsUnscopedRefReceiver
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SymbolKind -> SymbolKind.Parameter

    /// Gets a value indicating whether this parameter is variadic (Phase 4.8).
    prop IsVariadic bool {
        get;
    }

    /// Gets or sets a value indicating whether this parameter carries the `scoped` modifier (ADR-0058 /
    /// issue #376).
    /// When `true`, the parameter's safe-to-escape scope is restricted to the
    /// current function body and it may not be directly returned from a ref-struct-returning function.
    override prop IsScoped bool

    /// Gets or sets the ADR-0060 by-reference passing mode of this parameter (`None`, `Ref`, `Out`, or
    /// `In`).
    override prop RefKind RefKind

    /// Gets a value indicating whether this parameter is the enclosing
    /// function's receiver (ADR-0184) — the implicit `this` of a member
    /// declared in a struct/class body, or the source-visible receiver of a
    /// receiver-clause function (`func (r R) M()`). Set once by
    /// (cref:FunctionSymbol)'s constructor for whichever parameter
    /// becomes (cref:FunctionSymbol.ThisParameter).
    /// @remarks The CLR passes a struct's receiver as `ref S`, so the receiver's
    /// storage is WRITABLE and its value-scope (safe-to-escape) is the caller's
    /// — unlike an ordinary by-value parameter slot. (cref:VariableSymbol.IsReadOnly)
    /// alone cannot express that, because it is derived from (cref:RefKind)
    /// and the receiver's (cref:RefKind) is (cref:Binding.RefKind.None).
    /// `ExpressionBinder.ReceiverVariableIsThis` already carried this
    /// exemption for member WRITES; this flag makes the same fact available to
    /// the static ref-capability classifiers that have no enclosing-function
    /// context.
    prop IsReceiverParameter bool {
        get;
        internal set;
    }

    /// Gets or sets a value indicating whether this receiver parameter's member
    /// carries `@UnscopedRef` (ADR-0184 / issue #376)
    /// ((cref:System.Diagnostics.CodeAnalysis.UnscopedRefAttribute)),
    /// lifting the implicit `scoped` on the receiver's REF-safe-context so
    /// the member may return a reference into its own instance state.
    /// @remarks Deliberately a dedicated flag rather than promoting the receiver's
    /// (cref:RefKind) to (cref:Binding.RefKind.Ref): the latter
    /// would make every lambda inside a struct member trip GS9010 ("a
    /// `ref` parameter cannot be captured by a closure"), which has
    /// nothing to do with this feature.
    prop IsUnscopedRefReceiver bool

    /// Gets a value indicating whether this parameter declares an explicit default value (ADR-0063).
    /// When `true`, callers may omit a corresponding argument and the binder
    /// substitutes (cref:ExplicitDefaultValue) at the call site.
    prop HasExplicitDefaultValue bool {
        get;
        private set;
    }

    /// Gets the constant default value declared on this parameter (ADR-0063).
    /// Only meaningful when (cref:HasExplicitDefaultValue) is `true`.
    /// Value kinds: numeric primitive, (cref:bool), (cref:char),
    /// (cref:string), enum constant (carried as its underlying integral value),
    /// or `null` for a nullable/reference parameter or a value-type
    /// `default(T)` / `T()` default (issue #1182), whose all-zero value is
    /// materialized at the call site via a (cref:Binding.BoundDefaultExpression).
    prop ExplicitDefaultValue object? {
        get;
        private set;
    }

    /// Gets a value indicating whether this parameter carries
    /// `@AllowNull` (issue #3907), the .NET-standard annotation for "this
    /// input accepts `nil` even though its type is not nullable".
    /// @remarks Purely an ANNOTATION: `Type` is untouched, so a
    /// value-type `T` keeps its `T` signature slot and never becomes
    /// `Nullable<T>`, and reads of the parameter inside the body
    /// still see a non-nullable `T`. Only the ARGUMENT conversion at a
    /// call site is relaxed, and only where the nullable source and the
    /// non-nullable target share a runtime representation — see
    /// `ConversionClassifier.AcceptsNilAnnotatedArgument`.
    prop AllowsNullArgument bool -> KnownAttributes.HasAllowNull(Attributes)

    /// Gets the resolved `@MarshalAs(UnmanagedType.…)` override for
    /// this parameter (ADR-0096 / issue #762), or `null`
    /// when the parameter has no such annotation. Attached by
    /// (cref:Binding.PInvokeBinder) on P/Invoke declarations after
    /// per-parameter validation; consumed by the emitter to write a
    /// `FieldMarshal` table row and stamp
    /// (cref:System.Reflection.ParameterAttributes.HasFieldMarshal)
    /// on the Param row.
    prop MarshalAsMetadata MarshalAsMetadata? {
        get;
        private set;
    }

    /// Gets a value indicating whether this parameter carries the
    /// `@UnscopedRef` contract, including on a source parameter clone
    /// whose attributes are intentionally not re-emitted.
    internal prop HasUnscopedRef bool -> hasUnscopedRef

    /// Gets a value indicating whether this parameter's declaring module uses
    /// the version-11 ref-safety rules. Source parameters always do; imported
    /// parameters require the module marker.
    internal prop UsesUpdatedEscapeRules bool -> usesUpdatedEscapeRules

    /// Records the constant default value for this parameter (ADR-0063). Called exactly
    /// once by the binder when the parameter syntax includes a `= constant` clause
    /// and the constant has passed all ADR-0063 §3 restrictions.
    /// @param value The encoded constant default. May be `null` to represent the source-level `nil` default
    /// or a value-type `default(T)` / `T()` all-zero default (issue #1182).
    func SetExplicitDefaultValue(value object?) {
        HasExplicitDefaultValue = true
        ExplicitDefaultValue = value
    }

    /// Attaches the resolved (cref:MarshalAsMetadata) for this
    /// parameter (ADR-0096 / issue #762). Called exactly once by the
    /// P/Invoke binder after the `@MarshalAs` annotation has been
    /// validated against the parameter type and the rest of the
    /// P/Invoke shape.
    /// @param metadata The resolved override. Must not be `null`.
    func SetMarshalAsMetadata(metadata MarshalAsMetadata) {
        MarshalAsMetadata = metadata
    }

    /// Records an imported `[UnscopedRef]` parameter contract.
    internal func MarkUnscopedRef() {
        hasUnscopedRef = true
    }

    /// Records that an imported parameter comes from a legacy module.
    internal func MarkLegacyRefSafetyRules() {
        usesUpdatedEscapeRules = false
    }

    /// Gets the parameter's effective ref-safe-context. Under C#'s updated
    /// escape rules, `ref`/`in` parameters are return-only,
    /// `out` parameters are function-local, and `@UnscopedRef`
    /// widens the applicable default.
    /// @returns The effective ref-safe-context.
    internal func GetEffectiveRefScope() ParameterRefScope {
        if IsScoped {
            return ParameterRefScope.FunctionLocal
        }
        if !UsesUpdatedEscapeRules {
            return ParameterRefScope.Caller
        }
        if RefKind == RefKind.Out {
            return if HasUnscopedRef {
                ParameterRefScope.ReturnOnly
            } else {
                ParameterRefScope.FunctionLocal
            }
        }
        if (RefKind is RefKind.Ref or RefKind.In or RefKind.RefReadOnly) {
            return if HasUnscopedRef {
                ParameterRefScope.Caller
            } else {
                ParameterRefScope.ReturnOnly
            }
        }
        return ParameterRefScope.Caller
    }

    /// Gets the parameter's effective safe-to-escape scope. A `ref`
    /// parameter of ref-struct type is implicitly scoped unless
    /// `@UnscopedRef` widens its value contract.
    /// @returns The effective value safe-to-escape scope.
    internal func GetEffectiveValueScope() ParameterValueScope -> if IsScoped ||
        (UsesUpdatedEscapeRules && RefKind == RefKind.Ref && TypeSymbol.IsByRefLike(Type) && !HasUnscopedRef) {
        ParameterValueScope.FunctionLocal
    } else {
        ParameterValueScope.Caller
    }

    /// Returns whether another parameter has the same effective ref-safety contract.
    /// @param other The parameter to compare.
    /// @returns `true` when ref kind and applicable effective ref/value scopes match.
    internal func HasSameRefContract(other ParameterSymbol) bool -> RefKind == other.RefKind &&
        GetEffectiveRefScope() == other.GetEffectiveRefScope() &&
        (
        (!TypeSymbol.IsByRefLike(Type) && !TypeSymbol.IsByRefLike(other.Type)) ||
            GetEffectiveValueScope() == other.GetEffectiveValueScope()
    )
}
