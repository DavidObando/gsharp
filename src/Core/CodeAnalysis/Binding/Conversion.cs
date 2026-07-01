// <copyright file="Conversion.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Type conversion classifier.
/// </summary>
public sealed class Conversion
{
    /// <summary>
    /// States that there's no conversion between the given types.
    /// </summary>
    public static readonly Conversion None = new Conversion(exists: false, isIdentity: false, isImplicit: false);

    /// <summary>
    /// States that there's an identity conversion between the given types.
    /// </summary>
    public static readonly Conversion Identity = new Conversion(exists: true, isIdentity: true, isImplicit: true);

    /// <summary>
    /// States that there's an implicit conversion between the given types.
    /// </summary>
    public static readonly Conversion Implicit = new Conversion(exists: true, isIdentity: false, isImplicit: true);

    /// <summary>
    /// States that there's an explicit conversion between the given types.
    /// </summary>
    public static readonly Conversion Explicit = new Conversion(exists: true, isIdentity: false, isImplicit: false);

    // Issue #1482: the implicit numeric-widening lattice and the numeric
    // primitive set now live in the single authoritative
    // `NumericWideningLattice` helper. Conversion classification and overload
    // "better conversion" ranking both query that one table so they cannot
    // drift apart (they previously disagreed about native-int widening).
    private Conversion(bool exists, bool isIdentity, bool isImplicit)
    {
        Exists = exists;
        IsIdentity = isIdentity;
        IsImplicit = isImplicit;
    }

    /// <summary>
    /// Gets a value indicating whether the conversion exists or not.
    /// </summary>
    public bool Exists { get; }

    /// <summary>
    /// Gets a value indicating whether the conversion is identity or not.
    /// </summary>
    public bool IsIdentity { get; }

    /// <summary>
    /// Gets a value indicating whether the conversion is implicit or not.
    /// </summary>
    public bool IsImplicit { get; }

    /// <summary>
    /// Gets a value indicating whether the conversion is explicit or not.
    /// </summary>
    public bool IsExplicit => Exists && !IsImplicit;

    /// <summary>
    /// Clasifies the convertibility from one type to the other.
    /// </summary>
    /// <param name="from">From type.</param>
    /// <param name="to">To type.</param>
    /// <returns>The conversion mapping between the two types.</returns>
    public static Conversion Classify(TypeSymbol from, TypeSymbol to)
    {
        if (from == to)
        {
            return Conversion.Identity;
        }

        // Issue #1018: the bottom (`never`) type of a throw-expression is
        // implicitly convertible to ANY target type — a throw never yields a
        // value, so it satisfies any target without a runtime conversion.
        if (from == TypeSymbol.Never)
        {
            return Conversion.Implicit;
        }

        // Issue #1196: a generic type parameter `T` is implicitly convertible
        // to any interface (or base class) in its (transitive) constraint set.
        // Mirrors C# §10.2.12 (implicit reference conversions involving type
        // parameters): an identity / implicit reference conversion exists from
        // `T` to its effective interface set and to any base-class constraint.
        // The interface/base-class rule above is materialised by the emitter
        // with `box T` (a no-op for reference `T`), so a value-type or
        // reference-type argument both satisfy the interface-typed slot.
        //
        // NOTE: the interface/base rule above deliberately does NOT cover
        // `T -> object`; that genuine-object case is handled by the dedicated
        // #1540 rule below, which is safe because erased `!0` slots are
        // substituted back to their real `T` before this classifier runs (see
        // the extended comment on that rule).
        if (from is TypeParameterSymbol fromTypeParam && to != null
            && to is not TypeParameterSymbol
            && TypeParameterConvertsTo(fromTypeParam, to))
        {
            return Conversion.Implicit;
        }

        // Issue #1540: a generic type parameter `T` is ALWAYS implicitly
        // convertible to a GENUINE `object` slot — a boxing conversion for a
        // value `T`, a reference conversion for a reference `T`, and `box !!T`
        // (valid for both) for an unconstrained `T`. Mirrors C# §10.2.12: an
        // implicit reference/boxing conversion exists from any `T` to `object`.
        // This covers the implicit forms (`return val` with an `object` return
        // type, `let o object = val`, passing `T` to an `object` parameter) and,
        // since the conversion `Exists`, the explicit form `object(val)` too.
        //
        // Why this does NOT re-break #1196 (the erased-slot spurious box):
        // an ERASED open generic parameter slot (e.g. the `!0` element type of
        // `List[T].Add(!0)`) is presented as `object` ONLY at the raw CLR
        // signature level. Before this classifier is consulted for such a call,
        // `ConversionClassifier.BindClrParameterConversions` substitutes the
        // receiver's type arguments back into the open `!0` slot, so the target
        // type is the REAL type parameter `T` (not `object`) and the argument is
        // classified as `T -> T` identity with NO conversion node and NO box.
        // A `T -> object` conversion node is therefore only ever created for a
        // GENUINE `System.Object` destination, where boxing is correct. The
        // emitter materialises it with `box !!T` (see MethodBodyEmitter.
        // Conversions.cs), verifier-correct for value, reference and
        // unconstrained `T` alike.
        if (from is TypeParameterSymbol && to is not TypeParameterSymbol
            && to?.ClrType?.IsSameAs(typeof(object)) == true)
        {
            return Conversion.Implicit;
        }

        // ADR-0122 / issue #1014: unmanaged pointer conversions.
        // * pointer -> pointer: explicit reinterpret (e.g. `(byte*)p`).
        // * pointer <-> nint/nuint: explicit round-trip (IntPtr.ToPointer()).
        // * nil -> pointer: implicit null pointer.
        // These share the native-int CLR representation, so emit is a no-op
        // (or `conv.i` for narrower integer sources).
        if (from is PointerTypeSymbol || to is PointerTypeSymbol)
        {
            if (from == TypeSymbol.Null && to is PointerTypeSymbol)
            {
                return Conversion.Implicit;
            }

            if (from is PointerTypeSymbol && to is PointerTypeSymbol)
            {
                return Conversion.Explicit;
            }

            var nativeIntPartner = to is PointerTypeSymbol ? from : to;
            if (nativeIntPartner == TypeSymbol.NInt || nativeIntPartner == TypeSymbol.NUInt
                || nativeIntPartner == TypeSymbol.Int32 || nativeIntPartner == TypeSymbol.UInt32
                || nativeIntPartner == TypeSymbol.Int64 || nativeIntPartner == TypeSymbol.UInt64
                || TypeSymbol.IsLegalPointeeType(nativeIntPartner))
            {
                return Conversion.Explicit;
            }

            return Conversion.None;
        }

        // ADR-0122 §9 / issue #1035: function-pointer conversions.
        // * fnptr -> fnptr: explicit reinterpret.
        // * fnptr <-> nint/nuint/IntPtr/integer: explicit round-trip (an
        //   unmanaged function pointer is just an address-sized integer).
        // * nil -> fnptr: implicit null pointer.
        if (from is FunctionPointerTypeSymbol || to is FunctionPointerTypeSymbol)
        {
            if (from == TypeSymbol.Null && to is FunctionPointerTypeSymbol)
            {
                return Conversion.Implicit;
            }

            if (from is FunctionPointerTypeSymbol && to is FunctionPointerTypeSymbol)
            {
                return Conversion.Explicit;
            }

            var fpPartner = to is FunctionPointerTypeSymbol ? from : to;
            if (fpPartner == TypeSymbol.NInt || fpPartner == TypeSymbol.NUInt
                || fpPartner == TypeSymbol.Int32 || fpPartner == TypeSymbol.UInt32
                || fpPartner == TypeSymbol.Int64 || fpPartner == TypeSymbol.UInt64
                || fpPartner is PointerTypeSymbol)
            {
                return Conversion.Explicit;
            }

            return Conversion.None;
        }

        // Issue #813: a G# `TupleTypeSymbol` and an imported CLR
        // `System.ValueTuple<…>` instantiation denote the same type when
        // their closed CLR backings agree. The former is produced by tuple
        // literals (`yield (idx, v)`) and tuple type syntax; the latter
        // appears when a fully-closed tuple element is recovered from a
        // generic signature like `IEnumerable[(int32, string)]` whose
        // element type round-trips through `TypeSymbol.FromClrType`. Treat
        // them as identity so iterators returning tuple element types
        // accept tuple literals.
        if (IsTupleClrEquivalent(from, to))
        {
            return Conversion.Identity;
        }

        // Issue #1256: element-wise tuple conversion. A tuple `(T1, …, Tn)`
        // converts implicitly to `(U1, …, Un)` when both are tuple types of
        // the SAME arity and EACH element `Ti → Ui` has an implicit conversion
        // (identity, reference/interface upcast, nullable-reference upcast,
        // numeric widening, boxing, …). Mirrors C# §10.2.13 implicit tuple
        // conversions — the element conversions are classified recursively via
        // `Classify`, so this composes with every existing implicit rule
        // (including the #1255 lifted nullable-reference upcast). Identical
        // tuples are already returned as identity by the `from == to`
        // short-circuit (tuple symbols are cached per element sequence), so a
        // match here is always a NON-identity implicit conversion: the emitter
        // (via binder lowering in ConversionClassifier) rebuilds the target
        // `ValueTuple<…>` from per-element converted accesses, because two
        // distinct `ValueTuple<…>` instantiations are not IL-reinterpretable.
        // When any element lacks an implicit conversion (e.g. a downcast
        // `Base → Derived`, or `int32 → string`) or the arities differ, this
        // branch declines and the conversion falls through to `None`, so such
        // tuples remain errors exactly as C# requires.
        if (from is TupleTypeSymbol fromTuple && to is TupleTypeSymbol toTuple
            && fromTuple.Arity == toTuple.Arity)
        {
            var allElementsImplicit = true;
            for (var i = 0; i < fromTuple.Arity; i++)
            {
                var elementConversion = Classify(fromTuple.ElementTypes[i], toTuple.ElementTypes[i]);
                if (!elementConversion.Exists || !elementConversion.IsImplicit)
                {
                    allElementsImplicit = false;
                    break;
                }
            }

            if (allElementsImplicit)
            {
                return Conversion.Implicit;
            }
        }

        // #313: two erased generics constructed over the same open definition
        // with structurally-equivalent symbolic arguments (e.g. the `List[T]`
        // parameter type and the `List[T]` declared return type) are distinct
        // symbol instances but denote the same type. Treat them as identity so
        // `return items` inside a generic function binds.
        // Issue #1088 extends this to the same-compilation user-type-argument
        // case (e.g. `Channel[BufferEntry]`), where one side's `ClrType` erases
        // to `Channel`1[object]` (or is null entirely) while both carry the
        // same symbolic argument. Comparing the SYMBOLIC type arguments — rather
        // than the erased `ClrType` — lets `let ch Channel[BufferEntry] = ...`
        // bind even though `BufferEntry` has a null `ClrType` during binding.
        if (from is ImportedTypeSymbol fromGeneric
            && to is ImportedTypeSymbol toGeneric
            && fromGeneric.OpenDefinition != null
            && toGeneric.OpenDefinition != null
            && (fromGeneric.HasSubstitutableTypeArgument || toGeneric.HasSubstitutableTypeArgument)
            && AreConstructedGenericsIdentical(fromGeneric, toGeneric))
        {
            return Conversion.Identity;
        }

        // Issue #1420: identity between a CLR-backed closed constructed generic
        // (e.g. `Span<System.Int32>` recovered from a BCL signature such as
        // `CollectionsMarshal.AsSpan`, whose symbolic `TypeArguments` are empty
        // because the closed shape is fully described by its `ClrType`) and a
        // SYMBOLICALLY constructed generic produced by substituting an
        // extension's open receiver (e.g. `Span[T]` with `{T: int32}` →
        // `Span[int32]`). Substitution cannot rebuild the real closed CLR type
        // via `MakeGenericType` because the primitive alias `int32` carries the
        // RUNTIME `System.Int32` while the open `Span<>` came from a
        // MetadataLoadContext (mixing the two throws), so the substituted form
        // stays symbolic with an erased `ClrType`. Comparing the two structurally
        // — normalizing the CLR-backed side's generic arguments through
        // `TypeSymbol.FromClrType` so a BCL `System.Int32` and the alias `int32`
        // collapse to the SAME `TypeSymbol` — lets the generic-extension receiver
        // bind instead of failing GS0155.
        if (from is ImportedTypeSymbol fromImported
            && to is ImportedTypeSymbol toImported
            && AreConstructedGenericShapesIdentical(fromImported, toImported))
        {
            return Conversion.Identity;
        }

        // Phase 3.C.1 / ADR-0001: T → T? is an implicit widening; T? → T?
        // when underlyings match is identity. T? → T requires the bang
        // operator (Phase 3.C.3) and is not implicit here.
        if (to is NullableTypeSymbol toNullable)
        {
            if (from == TypeSymbol.Null)
            {
                return Conversion.Implicit;
            }

            if (from is NullableTypeSymbol fromNullable)
            {
                if (fromNullable.UnderlyingType == toNullable.UnderlyingType)
                {
                    return Conversion.Identity;
                }

                // Issue #1236: lifted numeric widening — `T1? → T2?` is an
                // implicit conversion whenever the underlying `T1 → T2` is an
                // implicit (lossless) numeric widening (e.g. `uint8? → int32?`,
                // `int32? → int64?`). This mirrors C# §10.2.6 lifted conversions
                // and lets nullable numeric operands participate in the same
                // widening lattice as their non-nullable forms, so a lifted
                // binary operator can bind at a common underlying type. The
                // emitter / evaluator unwrap the source, convert the underlying
                // value, and re-wrap, propagating null. Restricted to value-type
                // numeric underlyings so reference-typed nullable wrappers (which
                // share a CLR representation) keep their identity-only rule.
                if (fromNullable.UnderlyingType?.ClrType is { IsValueType: true }
                    && toNullable.UnderlyingType?.ClrType is { IsValueType: true })
                {
                    var liftedUnderlying = Classify(fromNullable.UnderlyingType, toNullable.UnderlyingType);
                    if (liftedUnderlying.Exists && liftedUnderlying.IsImplicit && !liftedUnderlying.IsIdentity)
                    {
                        return Conversion.Implicit;
                    }
                }

                // Issue #1255: lifted nullable reference upcast — `T? → U?` is an
                // implicit conversion whenever the underlying `T → U` is an
                // implicit reference/interface upcast (T derives from or
                // implements U). This mirrors the non-null #1121 rule (`T → U?`)
                // for the nullable-source case so the two stay consistent. For
                // reference-type underlyings a nullable wrapper shares the CLR
                // representation of the bare reference (null stays null, a
                // non-null value reference-upcasts), so this is a representation-
                // preserving no-op conversion — never boxing or wrapping. The
                // value-type underlying case is handled by the lifted numeric
                // rule above and intentionally excluded here. Issue #1552 later
                // made the sibling `T? → U` (non-nullable reference target) case
                // implicit too — see the dedicated nullable-reference-source
                // rule after this `to is NullableTypeSymbol` block — so a
                // nullable reference argument narrows to its underlying/base as
                // a representation-preserving reference conversion.
                if (IsReferenceLikeTarget(fromNullable.UnderlyingType)
                    && IsReferenceLikeTarget(toNullable.UnderlyingType))
                {
                    var underlyingConversion = Classify(fromNullable.UnderlyingType, toNullable.UnderlyingType);
                    if (underlyingConversion.Exists && underlyingConversion.IsImplicit)
                    {
                        return Conversion.Implicit;
                    }
                }

                return Conversion.None;
            }

            if (from == toNullable.UnderlyingType)
            {
                return Conversion.Implicit;
            }

            // Issue #1121: a non-nullable T is implicitly convertible to U?
            // whenever T is implicitly convertible to its underlying U. This
            // combines a reference upcast (to a base class or an implemented
            // interface of T) with nullable wrapping into a single implicit
            // conversion — a non-null reference is always a valid U?. For a
            // reference-type underlying U the nullable wrap is a representation
            // no-op, so we defer to the full implicit-conversion classification
            // of `T → U` (identity, reference/upcast, interface implementation,
            // boxing-to-object). Restricted to reference-like underlying targets
            // so numeric nullable lifting (e.g. int32 → int64?) is unaffected.
            if (IsReferenceLikeTarget(toNullable.UnderlyingType))
            {
                var underlyingConversion = Classify(from, toNullable.UnderlyingType);
                if (underlyingConversion.Exists && underlyingConversion.IsImplicit)
                {
                    return Conversion.Implicit;
                }
            }
        }

        // Issue #1552: a nullable REFERENCE argument `S?` shares the CLR
        // representation of its underlying reference type `S` (null stays null,
        // a non-null value is the very same reference), so every implicit
        // reference conversion available from the bare `S` — identity `S -> S`,
        // an upcast `S -> Base`, or an interface implementation `S -> IFace` —
        // is equally available from `S?`. Imported reference nullables already
        // reach this through the #521 CLR-assignability rule below (their
        // wrapper inherits the underlying's `ClrType`), but a user-declared
        // class/interface/delegate underlying carries no `ClrType` during
        // binding, so the #521 arm and the symbolic reference-upcast arms
        // (which key on `from is StructSymbol`/`InterfaceSymbol`, not the
        // nullable wrapper) never fire and `Dog? -> Dog`/`Dog? -> Animal`
        // wrongly errored. Classify against the underlying reference symbol
        // here so user and imported reference nullables narrow identically —
        // matching the ranking the #1552 overload tie-break relies on. Scoped
        // to reference-like underlyings and non-nullable targets: value-type
        // `int32? -> int32` stays an explicit narrowing (handled elsewhere),
        // and the `S? -> U?` nullable-target case is handled by the #1255 rule
        // above.
        if (from is NullableTypeSymbol fromNullableReference
            && to is not NullableTypeSymbol
            && IsReferenceLikeTarget(fromNullableReference.UnderlyingType))
        {
            var underlyingConversion = Classify(fromNullableReference.UnderlyingType, to);
            if (underlyingConversion.Exists && (underlyingConversion.IsImplicit || underlyingConversion.IsIdentity))
            {
                return Conversion.Implicit;
            }
        }

        // Issue #1455: a nullable wrapper over an open type parameter (`T?`)
        // boxes implicitly to `object` (and reference-upcasts to any interface
        // in `T`'s effective constraint set). Unlike the bare `T -> object`
        // case — deliberately excluded above because an erased `!0` parameter
        // slot is indistinguishable from a genuine `object` and would inject a
        // spurious box (#1196 regression) — a `T?` argument is NEVER identity
        // with an erased `!0`/`T` slot, so the boxing here is always genuine
        // and unambiguous. This wraps the implicit-boxing argument/return/
        // delegate-covariance positions (where no explicit cast is written) in
        // a BoundConversionExpression so emit materialises `box !!T`
        // (ref/unconstrained `T`) or `box Nullable<!!T>` (value-type
        // constrained `T`). Scoped to `object` and constraint-satisfying
        // interface targets so no narrowing or otherwise-invalid conversion is
        // admitted.
        if (from is NullableTypeSymbol fromNullableTypeParam
            && fromNullableTypeParam.UnderlyingType is TypeParameterSymbol nullableUnderlyingTypeParam
            && to is not NullableTypeSymbol)
        {
            if (to?.ClrType.IsSameAs(typeof(object)) == true)
            {
                return Conversion.Implicit;
            }

            if (IsInterfaceLikeType(to) && TypeParameterConvertsTo(nullableUnderlyingTypeParam, to))
            {
                return Conversion.Implicit;
            }
        }

        // Phase 3.C.2: nil literal is never assignable to a non-nullable type.
        if (from == TypeSymbol.Null && !(to is NullableTypeSymbol))
        {
            return Conversion.None;
        }

        // ADR-0102 follow-up / issue #818: two anonymous function types that
        // share parameter types and return type but differ only in the
        // per-parameter variadic flag tuple convert implicitly. The variadic
        // flag is a call-site directive (pack / pass-through) — it does not
        // change the parameter storage shape or the underlying CLR delegate
        // erasure, so a `(int32, ...string) -> int32` value can flow into a
        // `(int32, []string) -> int32` slot and vice versa. Identity (i.e.
        // exact same FunctionTypeSymbol cache instance) was already handled
        // by the early reference-equality short circuit at the top.
        //
        // Issue #1150: also allow the conversion when the parameter types match
        // but the source's numeric return type implicitly, losslessly widens to
        // the target's return type (e.g. `(int32) -> uint16` flowing into a
        // `(int32) -> int64` slot) — mirroring C#'s implicit numeric conversion
        // of a lambda body to an expected delegate return type.
        if (from is FunctionTypeSymbol fnFrom && to is FunctionTypeSymbol fnTo
            && fnFrom.Arity == fnTo.Arity
            && (fnFrom.ReturnType == fnTo.ReturnType || ReturnTypeWidens(fnFrom.ReturnType, fnTo.ReturnType)))
        {
            var sameShape = true;
            for (var i = 0; i < fnFrom.Arity; i++)
            {
                if (fnFrom.ParameterTypes[i] != fnTo.ParameterTypes[i])
                {
                    sameShape = false;
                    break;
                }
            }

            if (sameShape)
            {
                return Conversion.Implicit;
            }
        }

        // Issue #295: a GSharp function value (a `func` literal or any
        // function-typed value) implicitly converts to ANY compatible CLR
        // delegate type — one deriving from System.MulticastDelegate whose
        // `Invoke` signature is assignment-compatible. This lifts the
        // materialization that previously only happened in argument position
        // into a general rule, so assignment, return, and cast positions all
        // accept func → delegate conversions (Action/Func/Predicate and named
        // delegate types alike).
        if (from is FunctionTypeSymbol fnSource && to?.ClrType != null
            && IsFunctionToDelegateConvertible(fnSource, to.ClrType))
        {
            return Conversion.Implicit;
        }

        // ADR-0059 / issue #255: same rule for user-declared named delegate
        // types. They have no ClrType during binding, so the func→delegate
        // path above does not fire — classify the conversion structurally
        // against the delegate's parameter/return signature instead.
        if (from is FunctionTypeSymbol fnSource2 && to is DelegateTypeSymbol toDelegate
            && IsFunctionStructurallyAssignable(fnSource2, toDelegate))
        {
            return Conversion.Implicit;
        }

        // ADR-0059: a named delegate VALUE (variable typed as a
        // DelegateTypeSymbol) is structurally a delegate; widening to
        // System.Delegate / System.MulticastDelegate follows the existing
        // rule and is handled below. Conversions BETWEEN two distinct
        // DelegateTypeSymbol instances are explicitly *not* implicit, per
        // CLR rules — the user must round-trip through a func value.

        // Issue #323: any delegate-typed value widens implicitly to
        // System.Delegate (and System.MulticastDelegate), since every CLR
        // delegate derives from those base types. This covers both a GSharp
        // `func` literal (FunctionTypeSymbol, which materializes as a delegate
        // instance) and a named/generic CLR delegate value such as
        // `Func[string]`. At the IL level this is a plain reference upcast,
        // so EMIT needs no conversion opcode.
        if (to?.ClrType != null && IsSystemDelegateBaseType(to.ClrType))
        {
            if (from is FunctionTypeSymbol)
            {
                return Conversion.Implicit;
            }

            if (from?.ClrType != null && ClrTypeUtilities.IsDelegateType(from.ClrType))
            {
                return Conversion.Implicit;
            }

            if (from is DelegateTypeSymbol)
            {
                return Conversion.Implicit;
            }
        }

        // Issue #421 P2-5: user-defined and imported enums convert to/from
        // their underlying numeric primitive, and one enum converts to
        // another. Mirrors C# §10.2.4: every enum⇄numeric direction is an
        // explicit conversion (even enum→its own underlying), since enum
        // identity is intentionally distinct from the integral identity.
        if (TryClassifyEnumConversion(from, to, out var enumConversion))
        {
            return enumConversion;
        }

        // ADR-0044 numeric lattice. Both operands must be CLR primitives in
        // the numeric set; the widening map decides implicit vs. explicit.
        // Decimal narrowings (decimal → int etc.) and signed/unsigned
        // mismatches at the same width (int ↔ uint) are explicit per C#.
        var fromClr = from?.ClrType?.FullName;
        var toClr = to?.ClrType?.FullName;
        if (fromClr != null && toClr != null
            && NumericWideningLattice.IsNumericPrimitive(fromClr)
            && NumericWideningLattice.IsNumericPrimitive(toClr))
        {
            if (NumericWideningLattice.IsWidening(fromClr, toClr))
            {
                return Conversion.Implicit;
            }

            return Conversion.Explicit;
        }

        if (from == TypeSymbol.Bool || from == TypeSymbol.Int32)
        {
            if (to == TypeSymbol.String)
            {
                return Conversion.Explicit;
            }
        }

        if (from == TypeSymbol.String)
        {
            if (to == TypeSymbol.Bool || to == TypeSymbol.Int32)
            {
                return Conversion.Explicit;
            }
        }

        // Any value backed by a CLR type can be converted to string via ToString().
        if (to == TypeSymbol.String && from?.ClrType != null)
        {
            return Conversion.Explicit;
        }

        // ADR-0045: every value-type primitive (and every user struct)
        // boxes implicitly to `object`. Reference types convert to
        // `object` as a plain reference widening.
        if (to?.ClrType.IsSameAs(typeof(object)) == true && from?.ClrType != null)
        {
            return Conversion.Implicit;
        }

        // Boxing conversion for user value types to System.Object.
        if (from is StructSymbol fromStruct && !fromStruct.IsClass && to?.ClrType.IsSameAs(typeof(object)) == true)
        {
            return Conversion.Implicit;
        }

        // Issue #1218: an enum value boxes implicitly to its CLR reference base
        // types — System.Object, System.ValueType, and System.Enum. An
        // EnumSymbol carries no ClrType during binding (the enum is still being
        // compiled), so the general object-boxing rule above cannot fire. This
        // makes inherited Enum/ValueType/Object members callable on enum values
        // (e.g. passing an enum to System.Enum.HasFlag(System.Enum)); the
        // emitter lowers the conversion to a single `box <Enum>`.
        if (from is EnumSymbol && to?.ClrType is System.Type enumBoxTarget
            && (enumBoxTarget.IsSameAs(typeof(object))
                || enumBoxTarget.IsSameAs(typeof(System.ValueType))
                || enumBoxTarget.IsSameAs(typeof(System.Enum))))
        {
            return Conversion.Implicit;
        }

        // ADR-0045 explicit unbox: `(T)objectValue` for any value-type T.
        if (from?.ClrType.IsSameAs(typeof(object)) == true && to?.ClrType != null && to.ClrType.IsValueType)
        {
            return Conversion.Explicit;
        }

        // Issue #1532: an explicit cast from `object` (or `object?`) to a type
        // parameter `T` — written `T(o)` — is an explicit reference/unboxing
        // conversion checked at runtime, valid for ANY `T` (unconstrained,
        // `class`-, `struct`-, or interface/base-constrained). C# §10.3.5
        // lowers `(T)o` to `unbox.any <T>`, which the JIT specialises per
        // instantiation: a checked reference cast for reference `T`, an unbox
        // for value `T` (a null source throwing at runtime is expected). This
        // is EXPLICIT only — an implicit `object -> T` is still rejected
        // (GS0155) — and does not disturb the reverse `T -> object` erasure
        // rule (excluded above) because `from` here is a genuine `object`, not
        // a type parameter. `object?` reaches this via its `object` ClrType.
        // The emitter materialises this with `unbox.any T`.
        if (from?.ClrType.IsSameAs(typeof(object)) == true && to is TypeParameterSymbol)
        {
            return Conversion.Explicit;
        }

        // Issue #421 P2-5: an interface-typed reference holding a boxed
        // value type unboxes back to that value type via an explicit cast
        // (`MyStruct(iface)`). On the CLR this lowers to `unbox.any`. We
        // accept either a user-declared interface (InterfaceSymbol, whose
        // own ClrType is null) or an imported CLR interface (e.g.
        // System.IComparable). Mirrors C# §10.3.5.
        if (IsInterfaceLikeType(from) && to?.ClrType != null && to.ClrType.IsValueType)
        {
            return Conversion.Explicit;
        }

        // Issue #421 P2-5: a value-typed expression implicitly boxes to any
        // interface it implements. The IL is a single `box <T>` followed by
        // a reference-level interface upcast (which is a no-op since the
        // boxed object's type implements the interface). User-declared
        // value structs reach this path once they participate in the
        // interface relation; imported value types (e.g. `int32`
        // implementing `System.IComparable`) use the CLR's
        // `IsAssignableFrom` check.
        if (IsValueTypeLikeFrom(from) && IsInterfaceLikeType(to)
            && IsValueTypeAssignableToInterface(from, to))
        {
            return Conversion.Implicit;
        }

        // Issue #1302: a constructed BCL value struct (e.g.
        // `List[T].Enumerator`) whose element `T` is a same-compilation user
        // type has a null `ClrType` during binding — `MakeGenericType` could
        // not close the type because the argument lives in the assembly being
        // emitted — so `IsValueTypeLikeFrom`/`IsInterfaceLikeType` cannot fire
        // and the value-type → interface box above is skipped. The target
        // generic interface (`IEnumerator[T]`) is likewise unclosed. Match the
        // target interface's open definition against the generic interfaces the
        // struct's open definition implements, substituting the struct's
        // symbolic type arguments by generic-parameter position and comparing
        // each element via `AreTypeArgumentsEquivalent`, so
        // `List[Ch].Enumerator -> IEnumerator[Ch]` boxes implicitly while a
        // genuine element mismatch still reports GS0155.
        if (from is ImportedTypeSymbol fromCtorStruct
            && fromCtorStruct.OpenDefinition is { IsValueType: true }
            && to is ImportedTypeSymbol toCtorIface
            && toCtorIface.OpenDefinition is { IsInterface: true }
            && ConstructedValueTypeImplementsInterfaceSymbolically(fromCtorStruct, toCtorIface))
        {
            return Conversion.Implicit;
        }

        // Reference upcast: a class implicitly converts to any interface in
        // its (transitive) implements-list or to any of its (transitive)
        // base classes. The interpreter stores instances as objects of the
        // concrete class, and on the CLR the upcast is a no-op reference
        // conversion, so no representation change is needed.
        if (from is StructSymbol fromClass && fromClass.IsClass)
        {
            // Issue #1229: every user-declared `class` is a reference type
            // whose implicit root base is System.Object. The class carries no
            // ClrType during binding (its TypeDef only exists in the assembly
            // being emitted), so the general object-widening rule above (which
            // requires `from.ClrType != null`) cannot fire. This is a plain
            // reference upcast — NO boxing, since classes are reference types —
            // mirroring the user-to-user-base case below; the emitter lowers it
            // to a no-op (Issue #990). The nullable `object?` target is routed
            // through this same path by the #1121 nullable-wrapping rule above.
            if (to == TypeSymbol.Object || to?.ClrType?.IsSameAs(typeof(object)) == true)
            {
                return Conversion.Implicit;
            }

            if (to is InterfaceSymbol toInterface)
            {
                for (var c = fromClass; c != null; c = c.BaseClass)
                {
                    foreach (var i in c.Interfaces)
                    {
                        if (i == toInterface)
                        {
                            return Conversion.Implicit;
                        }
                    }
                }
            }

            // Issue #525: a G# class implicitly upcasts to any imported CLR
            // interface that appears in its base-type clause (or any base
            // class's base-type clause). The G# class has no ClrType during
            // binding, so the general #521 rule below cannot fire — match
            // structurally against `ImplementedClrInterfaces` and use the
            // CLR's IsAssignableFrom to cover interface inheritance from the
            // imported side (e.g. implementing `IList<T>` also satisfies
            // `IEnumerable<T>`).
            if (to?.ClrType != null && to.ClrType.IsInterface)
            {
                for (var c = fromClass; c != null; c = c.BaseClass)
                {
                    foreach (var iface in c.ImplementedClrInterfaces)
                    {
                        var ifaceClr = iface?.ClrType;
                        if (ifaceClr == null)
                        {
                            continue;
                        }

                        if (ifaceClr == to.ClrType || to.ClrType.IsAssignableFrom(ifaceClr))
                        {
                            return Conversion.Implicit;
                        }
                    }
                }
            }

            if (to is StructSymbol toClass && toClass.IsClass)
            {
                if (DerivesFromConstructed(fromClass, toClass))
                {
                    return Conversion.Implicit;
                }
            }

            // Issue #1274: a G# class that (transitively) derives from an
            // imported/BCL base class (e.g. `MyStream : System.IO.Stream`)
            // implicitly upcasts to that imported base class — or any base of
            // it. The user class carries no ClrType during binding, so the
            // general #521 reference upcast above (which requires
            // `from.ClrType != null`) cannot fire. Walk the user base chain and
            // match the first imported base class (`ImportedBaseType`) by name
            // against the target's CLR type using IsAssignableByName, which
            // covers the full CLR base chain of the imported base.
            if (to?.ClrType is Type toClrClass
                && !toClrClass.IsInterface
                && !toClrClass.IsValueType
                && !toClrClass.IsPointer
                && !toClrClass.IsByRef)
            {
                for (var c = fromClass; c != null; c = c.BaseClass)
                {
                    if (c.ImportedBaseType?.ClrType is Type importedBaseClr
                        && ClrTypeUtilities.IsAssignableByName(toClrClass, importedBaseClr))
                    {
                        return Conversion.Implicit;
                    }
                }
            }
        }

        // Issue #1421: a user-declared interface value is a CLR reference type
        // whose implicit root base is System.Object, so it converts implicitly
        // to `object`/`object?` as a plain reference upcast (no IL op, no box —
        // an interface reference already IS an object reference). It also
        // upcasts to any of its (transitive) base interfaces, whether
        // user-declared (`BaseInterfaces`) or imported CLR (`BaseClrInterfaces`,
        // including interfaces those transitively inherit). An InterfaceSymbol
        // carries no ClrType during binding (its TypeDef only exists in the
        // assembly being emitted), so the general object-widening rule and the
        // #521 reference-upcast arm — both of which require `from.ClrType != null`
        // — cannot fire. Without this, passing an interface-typed value to a
        // `ThrowIfNull(object?, …)`-style overload failed to bind (GS0159). The
        // `object?` target is routed here by the #1121 nullable-wrapping rule.
        if (from is InterfaceSymbol fromInterface)
        {
            if (to == TypeSymbol.Object || to?.ClrType?.IsSameAs(typeof(object)) == true)
            {
                return Conversion.Implicit;
            }

            if (to is InterfaceSymbol toBaseInterface)
            {
                foreach (var baseInterface in fromInterface.SelfAndAllBaseInterfaces())
                {
                    if (baseInterface == toBaseInterface)
                    {
                        return Conversion.Implicit;
                    }
                }
            }

            if (to?.ClrType is { IsInterface: true } toClrInterface)
            {
                foreach (var baseClrInterface in fromInterface.BaseClrInterfaces)
                {
                    var clr = baseClrInterface?.ClrType;
                    if (clr != null && (clr.IsSameAs(toClrInterface) || toClrInterface.IsAssignableFrom(clr)))
                    {
                        return Conversion.Implicit;
                    }
                }
            }
        }

        // Issue #528: a G# slice `[]T` is backed by a CLR `T[]` at runtime
        // (`SliceTypeSymbol.ClrType` is built via `MakeArrayType()` on the
        // element's `ClrType`). The reverse direction (`T[] → []T`) is
        // already classified above; this branch documents and enforces the
        // forward direction (`[]T → T[]`) explicitly so it survives any
        // future refactor of the generic #521 reference upcast below.
        // Element-type identity is required (matched by CLR full name to
        // bridge live ↔ MetadataLoadContext types), preserving slice
        // invariance: `[]string` does NOT convert to `object[]` even though
        // the CLR allows array reference covariance, because G# slices are
        // invariant in their element type. The IL is a no-op since the
        // runtime representation is identical.
        if (from is SliceTypeSymbol sliceSrc
            && to?.ClrType != null && to.ClrType.IsArray && to.ClrType.GetArrayRank() == 1
            && sliceSrc.ElementType?.ClrType != null
            && to.ClrType.GetElementType() is Type targetElement
            && string.Equals(targetElement.FullName, sliceSrc.ElementType.ClrType.FullName, StringComparison.Ordinal))
        {
            return Conversion.Implicit;
        }

        // Issue #1162: same forward slice-to-array conversion when the
        // slice element is a same-compilation user type whose backing
        // ClrType is still null during binding (so the CLR-backed arm
        // above cannot fire). The target may itself be a SliceTypeSymbol
        // or ArrayTypeSymbol with a null ClrType; match symbolically by
        // element equivalence. Slice invariance is preserved because
        // `AreTypeArgumentsEquivalent` requires the elements to match.
        if (from is SliceTypeSymbol sliceSrcSym && sliceSrcSym.ClrType == null)
        {
            TypeSymbol targetElementSym = to switch
            {
                SliceTypeSymbol toSlice => toSlice.ElementType,
                ArrayTypeSymbol toArray => toArray.ElementType,
                _ => null,
            };

            if (targetElementSym != null
                && AreTypeArgumentsEquivalent(targetElementSym, sliceSrcSym.ElementType))
            {
                return Conversion.Implicit;
            }
        }

        // Slice-to-interface: a G# slice `[]T` is backed by a CLR `T[]`
        // at runtime. Extend to every interface that `T[]` implements
        // (IEnumerable<T>, IReadOnlyList<T>, IList<T>, non-generic
        // IEnumerable/ICollection/IList, ICloneable, etc.) using the
        // cross-context-safe `ImplementsInterfaceByName` walk (#570/#610).
        //
        // G# slices are invariant: `[]string` does NOT convert to
        // `IEnumerable<object>` despite CLR array covariance.
        // `ImplementsInterfaceByName` matches generic arguments by name,
        // enforcing invariance. This block also serves as the invariance
        // guard: slices that do NOT match are rejected here, preventing
        // the general #521 arm below (whose same-context fast path would
        // accept covariant matches via `IsAssignableFrom`) from firing.
        if (from is SliceTypeSymbol sliceForIface && to?.ClrType != null && to.ClrType.IsInterface)
        {
            if ((sliceForIface.ClrType != null && SliceImplementsInterface(sliceForIface, to))
                || (sliceForIface.ClrType == null && SliceImplementsInterfaceSymbolically(sliceForIface, to)))
            {
                return Conversion.Implicit;
            }

            return Conversion.None;
        }

        // Issue #521: standard CLR identity / reference upcast — a
        // reference-typed expression of CLR type `from` widens implicitly
        // to any base class or implemented interface `to`. The CLR
        // satisfies the contract at the reference level (no IL op
        // required), so the emitter treats this as a no-op. Restricted to
        // genuine reference types on both sides to avoid colliding with
        // the boxing / unboxing / value-type-to-interface rules above.
        if (from?.ClrType != null && to?.ClrType != null
            && !from.ClrType.IsValueType && !to.ClrType.IsValueType
            && !from.ClrType.IsPointer && !to.ClrType.IsPointer
            && !from.ClrType.IsByRef && !to.ClrType.IsByRef
            && ClrTypeUtilities.IsAssignableByName(to.ClrType, from.ClrType))
        {
            return Conversion.Implicit;
        }

        return Conversion.None;
    }

    /// <summary>
    /// Issue #1196: determines whether a generic type parameter
    /// <paramref name="typeParam"/> is implicitly convertible (identity /
    /// implicit reference conversion) to <paramref name="target"/> on the
    /// strength of its declared constraints alone. Returns <see langword="true"/>
    /// when <paramref name="target"/> is (transitively) contained in the type
    /// parameter's effective interface set, or is a (transitive) base class of
    /// its class constraint. Mirrors C# §10.2.12.
    /// </summary>
    /// <remarks>
    /// Deliberately excludes <c>object</c>: the binder erases open generic
    /// parameter slots (such as the <c>!0</c> element type of
    /// <c>List[T].Add(!0)</c>) to the <c>object</c> singleton, so a
    /// <c>T -&gt; object</c> rule here cannot be distinguished from the identity
    /// argument conversion <c>T -&gt; !0</c> and would cause the emitter to box
    /// the argument, yielding invalid IL.
    /// </remarks>
    private static bool TypeParameterConvertsTo(TypeParameterSymbol typeParam, TypeSymbol target)
    {
        // `object` (and any target whose CLR type erases to `object`) is
        // excluded: an erased open generic parameter slot is represented as the
        // `object` singleton, so converting `T -> object` here is ambiguous with
        // the identity argument conversion `T -> !0` and would cause a spurious
        // box. `T -> object` needs no special-casing — it is a plain reference
        // conversion handled by the value-type/box paths in the emitter.
        if (target == TypeSymbol.Object || target?.ClrType?.IsSameAs(typeof(object)) == true)
        {
            return false;
        }

        // G#-declared interface bound: include the bound and all of its
        // transitive base interfaces (plus any imported CLR base interfaces).
        if (typeParam.InterfaceConstraint is InterfaceSymbol gInterface)
        {
            foreach (var iface in gInterface.SelfAndAllBaseInterfaces())
            {
                if (iface == target || ClrInterfaceMatches(iface, target))
                {
                    return true;
                }

                if (!iface.BaseClrInterfaces.IsDefaultOrEmpty)
                {
                    foreach (var clrBase in iface.BaseClrInterfaces)
                    {
                        if (ClrAssignableTarget(clrBase, target))
                        {
                            return true;
                        }
                    }
                }
            }
        }

        // Imported CLR interface bound: a `T : ISomeClrInterface` constraint.
        if (typeParam.ClrInterfaceConstraint is TypeSymbol clrInterface
            && ClrAssignableTarget(clrInterface, target))
        {
            return true;
        }

        // Base-class constraint: include the class, its transitive base
        // classes, and every interface it (transitively) implements.
        if (typeParam.ClassConstraint is TypeSymbol classConstraint)
        {
            if (classConstraint == target)
            {
                return true;
            }

            var underlyingConversion = Classify(classConstraint, target);
            if (underlyingConversion.Exists && underlyingConversion.IsImplicit)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #1196: matches a G#-declared interface symbol against a target that
    /// may itself be an imported CLR interface (e.g. when the interface bound's
    /// own <c>ClrType</c> is populated during a later phase).
    /// </summary>
    private static bool ClrInterfaceMatches(InterfaceSymbol iface, TypeSymbol target)
    {
        return iface?.ClrType != null && target?.ClrType != null
            && ClrTypeUtilities.IsAssignableByName(target.ClrType, iface.ClrType);
    }

    /// <summary>
    /// Issue #1196: determines whether an imported CLR-typed constraint source is
    /// assignable to the target via the cross-context-safe by-name check.
    /// </summary>
    private static bool ClrAssignableTarget(TypeSymbol source, TypeSymbol target)
    {
        if (source == target)
        {
            return true;
        }

        return source?.ClrType != null && target?.ClrType != null
            && ClrTypeUtilities.IsAssignableByName(target.ClrType, source.ClrType);
    }

    /// <summary>
    /// Issue #1420: determines whether two <see cref="ImportedTypeSymbol"/>
    /// instances denote the same closed constructed generic when ONE side
    /// carries symbolic <see cref="ImportedTypeSymbol.TypeArguments"/> (produced
    /// by substituting an extension's open generic receiver) while the OTHER is a
    /// plain CLR-backed closed generic whose arguments are described only by its
    /// <see cref="TypeSymbol.ClrType"/>. The CLR-backed side's generic arguments
    /// are normalized through <see cref="TypeSymbol.FromClrType"/> so a BCL
    /// primitive (e.g. <c>System.Int32</c>) and the corresponding G# alias (e.g.
    /// <c>int32</c>) resolve to the SAME <see cref="TypeSymbol"/>. Requires at
    /// least one side to be symbolic so genuinely CLR-backed comparisons keep
    /// flowing through the existing (variance-aware) rules.
    /// </summary>
    private static bool AreConstructedGenericShapesIdentical(ImportedTypeSymbol from, ImportedTypeSymbol to)
    {
        var fromSymbolic = !from.TypeArguments.IsDefaultOrEmpty;
        var toSymbolic = !to.TypeArguments.IsDefaultOrEmpty;

        // Scope to the asymmetric case: the symmetric symbolic/symbolic and the
        // symmetric CLR/CLR paths are already handled above and elsewhere.
        if (fromSymbolic == toSymbolic)
        {
            return false;
        }

        if (!TryGetConstructedGenericShape(from, out var fromOpen, out var fromArgs)
            || !TryGetConstructedGenericShape(to, out var toOpen, out var toArgs))
        {
            return false;
        }

        if (!ClrTypeUtilities.IsSameAs(fromOpen, toOpen) || fromArgs.Length != toArgs.Length)
        {
            return false;
        }

        for (var i = 0; i < fromArgs.Length; i++)
        {
            if (!AreTypeArgumentsEquivalent(fromArgs[i], toArgs[i]))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #1420: extracts the open generic CLR definition and the symbolic
    /// type arguments of a constructed generic <see cref="ImportedTypeSymbol"/>,
    /// whether the arguments are carried symbolically (#313 construction) or only
    /// by the closed <see cref="TypeSymbol.ClrType"/>. CLR-backed arguments are
    /// projected through <see cref="TypeSymbol.FromClrType"/> so primitive
    /// aliases and their BCL counterparts unify.
    /// </summary>
    private static bool TryGetConstructedGenericShape(ImportedTypeSymbol symbol, out Type openDefinition, out ImmutableArray<TypeSymbol> typeArguments)
    {
        if (symbol.OpenDefinition != null && !symbol.TypeArguments.IsDefaultOrEmpty)
        {
            openDefinition = symbol.OpenDefinition;
            typeArguments = symbol.TypeArguments;
            return true;
        }

        var clr = symbol.ClrType;
        if (clr != null && clr.IsGenericType && !clr.IsGenericTypeDefinition)
        {
            var clrArgs = clr.GetGenericArguments();
            var builder = ImmutableArray.CreateBuilder<TypeSymbol>(clrArgs.Length);
            foreach (var arg in clrArgs)
            {
                builder.Add(TypeSymbol.FromClrType(arg));
            }

            openDefinition = clr.GetGenericTypeDefinition();
            typeArguments = builder.MoveToImmutable();
            return true;
        }

        openDefinition = null;
        typeArguments = ImmutableArray<TypeSymbol>.Empty;
        return false;
    }

    /// <summary>
    /// Issue #1088: determines whether two constructed generic
    /// <see cref="ImportedTypeSymbol"/> instances denote the same closed type
    /// by comparing their open definitions and SYMBOLIC type arguments, rather
    /// than their (possibly erased) <see cref="TypeSymbol.ClrType"/>. A
    /// same-compilation user type used as a CLR generic argument has a
    /// <see langword="null"/> <c>ClrType</c> and erases to <c>object</c> on the
    /// closed shape, so a purely CLR-based comparison spuriously fails for
    /// otherwise identical instantiations (e.g. the declared variable type
    /// <c>Channel[BufferEntry]</c> vs. a factory method's return type).
    /// </summary>
    private static bool AreConstructedGenericsIdentical(ImportedTypeSymbol from, ImportedTypeSymbol to)
    {
        if (!ClrTypeUtilities.IsSameAs(from.OpenDefinition, to.OpenDefinition))
        {
            return false;
        }

        if (from.TypeArguments.IsDefaultOrEmpty || to.TypeArguments.IsDefaultOrEmpty
            || from.TypeArguments.Length != to.TypeArguments.Length)
        {
            return false;
        }

        for (var i = 0; i < from.TypeArguments.Length; i++)
        {
            if (!AreTypeArgumentsEquivalent(from.TypeArguments[i], to.TypeArguments[i]))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #1248: determines whether a (possibly constructed generic) class
    /// <paramref name="fromClass"/> implicitly upcasts to a constructed generic
    /// base class <paramref name="toClass"/> by walking the inheritance chain
    /// while substituting type arguments at each level.
    /// <para>
    /// A base-type reference is declared in terms of the derived class's OWN
    /// type parameters (e.g. <c>TransformBase[TIn, TOut] : FilterBase[TIn]</c>),
    /// and a constructed instance keeps that base reference unsubstituted
    /// (<see cref="StructSymbol.BaseClass"/> is the open definition's base). A
    /// naive reference-equality walk therefore compares <c>FilterBase[TIn]</c>
    /// against the target <c>FilterBase[int32]</c> and fails. This walk threads
    /// a substitution map mapping each class's declaration type parameters onto
    /// the concrete type arguments seen at the most-derived level, composing the
    /// map down every hop, so the base reference is fully substituted before the
    /// comparison. Handles multi-level chains (concrete leaf → generic mid →
    /// generic base), type-parameter renaming, and partial type-parameter flow
    /// (only some of the derived's parameters reaching the base). A wrong type
    /// argument or an unrelated definition still fails (GS0155).
    /// </para>
    /// </summary>
    private static bool DerivesFromConstructed(StructSymbol fromClass, StructSymbol toClass)
    {
        // Maps each visited class's declaration type parameters onto concrete
        // type arguments resolved in fromClass's context, composed across hops.
        Dictionary<TypeParameterSymbol, TypeSymbol> running = null;

        for (var c = fromClass; c != null; c = c.BaseClass)
        {
            // The most-derived class itself is the identity case (handled by the
            // caller); only its base chain is an upcast target.
            if (!ReferenceEquals(c, fromClass) && MatchesConstructedTarget(c, toClass, running))
            {
                return true;
            }

            // Extend the running map with this class's own declaration
            // parameters -> (resolved) arguments, so a deeper base whose type
            // arguments reference these parameters can be substituted.
            if (c.Definition != null
                && !c.TypeArguments.IsDefaultOrEmpty
                && !c.Definition.TypeParameters.IsDefaultOrEmpty)
            {
                var defParams = c.Definition.TypeParameters;
                var count = Math.Min(defParams.Length, c.TypeArguments.Length);
                for (var i = 0; i < count; i++)
                {
                    var arg = c.TypeArguments[i];
                    if (arg is TypeParameterSymbol tpArg && running != null
                        && running.TryGetValue(tpArg, out var resolved))
                    {
                        arg = resolved;
                    }

                    running ??= new Dictionary<TypeParameterSymbol, TypeSymbol>();
                    running[defParams[i]] = arg;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #1248: tests whether a base-chain class <paramref name="c"/>, after
    /// substituting its type arguments through <paramref name="running"/>, denotes
    /// the same constructed type as <paramref name="toClass"/>.
    /// </summary>
    private static bool MatchesConstructedTarget(
        StructSymbol c,
        StructSymbol toClass,
        Dictionary<TypeParameterSymbol, TypeSymbol> running)
    {
        if (!ReferenceEquals(c.Definition, toClass.Definition))
        {
            return false;
        }

        // Non-generic class along the chain: definition identity is sufficient.
        if (c.TypeArguments.IsDefaultOrEmpty && toClass.TypeArguments.IsDefaultOrEmpty)
        {
            return true;
        }

        if (c.TypeArguments.IsDefaultOrEmpty
            || toClass.TypeArguments.IsDefaultOrEmpty
            || c.TypeArguments.Length != toClass.TypeArguments.Length)
        {
            return false;
        }

        for (var i = 0; i < c.TypeArguments.Length; i++)
        {
            var arg = c.TypeArguments[i];
            if (arg is TypeParameterSymbol tp && running != null
                && running.TryGetValue(tp, out var resolved))
            {
                arg = resolved;
            }

            if (!AreTypeArgumentsEquivalent(arg, toClass.TypeArguments[i]))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #1088: compares two symbolic generic type arguments for identity,
    /// recovering same-compilation user types whose <see cref="TypeSymbol.ClrType"/>
    /// has erased to <c>object</c> (or is <see langword="null"/>). Same-compilation
    /// symbols are reference-equal; distinct user types differ by reference / name
    /// so genuine negative conversions (e.g. <c>Channel[A]</c> → <c>Channel[B]</c>)
    /// still report GS0155.
    /// </summary>
    private static bool AreTypeArgumentsEquivalent(TypeSymbol a, TypeSymbol b)
    {
        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a is null || b is null)
        {
            return false;
        }

        // Nested constructed generics (e.g. List[List[MyGs]]) compare structurally.
        if (a is ImportedTypeSymbol nestedA && b is ImportedTypeSymbol nestedB
            && nestedA.OpenDefinition != null && nestedB.OpenDefinition != null)
        {
            return AreConstructedGenericsIdentical(nestedA, nestedB);
        }

        // Both arguments resolve to a real CLR type: compare those by name.
        if (a.ClrType != null && b.ClrType != null)
        {
            return ClrTypeUtilities.AreSame(a.ClrType, b.ClrType);
        }

        // Both arguments are same-compilation user types with a null ClrType:
        // compare by symbol kind and name so distinct user types stay distinct.
        if (a.ClrType == null && b.ClrType == null)
        {
            return a.GetType() == b.GetType()
                && string.Equals(a.Name, b.Name, StringComparison.Ordinal);
        }

        return false;
    }

    /// <summary>
    /// Determines whether a GSharp function type is convertible to a CLR
    /// delegate type by matching parameter arity / assignability and the
    /// return type. Uses metadata-safe (name-based) checks so it works for
    /// delegate types loaded through a MetadataLoadContext.
    /// </summary>
    private static bool IsFunctionToDelegateConvertible(FunctionTypeSymbol fn, Type delegateType)
    {
        if (!ClrTypeUtilities.IsDelegateType(delegateType))
        {
            return false;
        }

        // Issue #1100: a constructed generic delegate closed over a
        // same-compilation user type (e.g. `Action[Entry]`) surfaces as a
        // `System.Reflection.Emit.TypeBuilderInstantiation` whose
        // `GetMethod("Invoke")` throws `NotSupportedException` ("TypeBuilder
        // generic instantiation does not support resolving members"). Recover
        // the `Invoke` signature from the open generic definition and
        // substitute the type arguments by position so convertibility is
        // decided without resolving a member directly off the instantiation.
        if (!TryGetDelegateInvokeSignature(delegateType, out var invokeParamTypes, out var invokeReturnType))
        {
            return false;
        }

        if (invokeParamTypes.Length != fn.ParameterTypes.Length)
        {
            return false;
        }

        for (var i = 0; i < invokeParamTypes.Length; i++)
        {
            var fnParamClr = fn.ParameterTypes[i]?.ClrType;
            if (fnParamClr == null || !ClrTypeUtilities.IsAssignableByName(invokeParamTypes[i], fnParamClr))
            {
                return false;
            }
        }

        var invokeReturnIsVoid = invokeReturnType == null
            || string.Equals(invokeReturnType.FullName, "System.Void", StringComparison.Ordinal);
        if (fn.ReturnType == TypeSymbol.Void || fn.ReturnType == null)
        {
            return invokeReturnIsVoid;
        }

        if (invokeReturnIsVoid)
        {
            return false;
        }

        var fnReturnClr = fn.ReturnType.ClrType;
        if (fnReturnClr == null)
        {
            return false;
        }

        // Identity / reference-assignable return (covers exact match and
        // reference covariance).
        if (ClrTypeUtilities.IsAssignableByName(invokeReturnType, fnReturnClr))
        {
            return true;
        }

        // Issue #1150: the function's numeric return type implicitly, losslessly
        // widens to the delegate's numeric return type (e.g. a `uint16`-returning
        // lambda flowing into a `Func<int32,int64>` parameter). Mirrors C#'s
        // implicit numeric conversion of a lambda body to the expected delegate
        // return type. Consulted by CLR full name so it is safe across reflection
        // contexts. Narrowing and signed/unsigned same-width mismatches are not
        // accepted here; they still require an explicit cast.
        return WidensNumerically(fnReturnClr, invokeReturnType);
    }

    /// <summary>
    /// Issue #1100: resolves a delegate type's <c>Invoke</c> parameter and
    /// return types without resolving a member directly off a
    /// <c>System.Reflection.Emit.TypeBuilderInstantiation</c>. A
    /// constructed generic delegate closed over a same-compilation user type
    /// (whose CLR backing is an in-flight emit <c>TypeBuilder</c>) cannot serve
    /// <see cref="Type.GetMethod(string)"/> — it throws
    /// <see cref="NotSupportedException"/>. In that case the <c>Invoke</c>
    /// signature is recovered from the open generic definition and each
    /// generic parameter is substituted by position with the constructed type's
    /// actual type argument. Returns <see langword="false"/> when no usable
    /// <c>Invoke</c> can be resolved.
    /// </summary>
    private static bool TryGetDelegateInvokeSignature(Type delegateType, out Type[] parameterTypes, out Type returnType)
    {
        parameterTypes = Array.Empty<Type>();
        returnType = null;

        try
        {
            var invoke = delegateType.GetMethodSafe("Invoke");
            if (invoke == null)
            {
                return false;
            }

            var parms = invoke.GetParameters();
            parameterTypes = new Type[parms.Length];
            for (var i = 0; i < parms.Length; i++)
            {
                parameterTypes[i] = parms[i].ParameterType;
            }

            returnType = invoke.ReturnType;
            return true;
        }
        catch (NotSupportedException)
        {
            // delegateType is a TypeBuilderInstantiation; fall through to the
            // open-definition resolution below.
        }

        if (!delegateType.IsGenericType || delegateType.IsGenericTypeDefinition)
        {
            return false;
        }

        Type definition;
        Type[] typeArguments;
        try
        {
            definition = delegateType.GetGenericTypeDefinition();
            typeArguments = delegateType.GetGenericArguments();
        }
        catch (NotSupportedException)
        {
            return false;
        }

        var openInvoke = definition.GetMethodSafe("Invoke");
        if (openInvoke == null)
        {
            return false;
        }

        Type Substitute(Type t)
        {
            if (t != null && t.IsGenericParameter)
            {
                var pos = t.GenericParameterPosition;
                if ((uint)pos < (uint)typeArguments.Length)
                {
                    return typeArguments[pos];
                }
            }

            return t;
        }

        var openParms = openInvoke.GetParameters();
        parameterTypes = new Type[openParms.Length];
        for (var i = 0; i < openParms.Length; i++)
        {
            parameterTypes[i] = Substitute(openParms[i].ParameterType);
        }

        returnType = Substitute(openInvoke.ReturnType);
        return true;
    }

    /// <summary>
    /// Determines whether a CLR type is the System.Delegate or
    /// System.MulticastDelegate base type (the common bases of every delegate),
    /// using name-based checks so it works under a MetadataLoadContext.
    /// </summary>
    private static bool IsSystemDelegateBaseType(Type type)
    {
        var fullName = type.FullName;
        return string.Equals(fullName, "System.Delegate", StringComparison.Ordinal)
            || string.Equals(fullName, "System.MulticastDelegate", StringComparison.Ordinal);
    }

    /// <summary>
    /// ADR-0059 / issue #255: structural compatibility check between a
    /// G# function-typed value and a user-declared named delegate
    /// (<see cref="DelegateTypeSymbol"/>). Used in lieu of the CLR-Type-based
    /// <see cref="IsFunctionToDelegateConvertible"/> because the delegate has
    /// no <c>ClrType</c> during binding — its TypeDef is materialized at emit.
    /// </summary>
    private static bool IsFunctionStructurallyAssignable(FunctionTypeSymbol fn, DelegateTypeSymbol target)
    {
        var parameters = target.Parameters;
        if (parameters.Length != fn.ParameterTypes.Length)
        {
            return false;
        }

        for (var i = 0; i < parameters.Length; i++)
        {
            var fromType = fn.ParameterTypes[i];
            var toType = parameters[i].Type;
            if (fromType == null || toType == null)
            {
                return false;
            }

            // Parameter types are contravariant in C#; G# v1 mirrors the
            // existing CLR-typed func→delegate rule, which is name-based
            // assignability — i.e., identity or an implicit conversion.
            var conv = Classify(fromType, toType);
            if (!conv.Exists || !conv.IsImplicit)
            {
                return false;
            }
        }

        var fnReturn = fn.ReturnType ?? TypeSymbol.Void;
        var targetReturn = target.ReturnType ?? TypeSymbol.Void;
        if (fnReturn == TypeSymbol.Void)
        {
            return targetReturn == TypeSymbol.Void;
        }

        if (targetReturn == TypeSymbol.Void)
        {
            return false;
        }

        var retConv = Classify(fnReturn, targetReturn);
        return retConv.Exists && retConv.IsImplicit;
    }

    // Issue #421 P2-5: enum⇄numeric and enum⇄enum conversions. Both
    // directions are explicit per C# §10.3.3 / §10.3.4 — the binder must
    // permit them so the cast syntax (`int32(myEnum)`) reaches the emitter,
    // which then routes them through the underlying numeric primitive.
    private static bool TryClassifyEnumConversion(TypeSymbol from, TypeSymbol to, out Conversion conversion)
    {
        var fromIsEnum = IsEnumLikeType(from);
        var toIsEnum = IsEnumLikeType(to);

        if (!fromIsEnum && !toIsEnum)
        {
            conversion = Conversion.None;
            return false;
        }

        // enum → enum (any pair, including the same enum). Identity already
        // returned above, so this only fires for distinct enum types.
        if (fromIsEnum && toIsEnum)
        {
            conversion = Conversion.Explicit;
            return true;
        }

        // enum → numeric primitive.
        if (fromIsEnum && to?.ClrType?.FullName is string toName && NumericWideningLattice.IsNumericPrimitive(toName))
        {
            conversion = Conversion.Explicit;
            return true;
        }

        // numeric primitive → enum.
        if (toIsEnum && from?.ClrType?.FullName is string fromName && NumericWideningLattice.IsNumericPrimitive(fromName))
        {
            conversion = Conversion.Explicit;
            return true;
        }

        conversion = Conversion.None;
        return false;
    }

    /// <summary>
    /// Issue #1150: determines whether the CLR type <paramref name="fromClr"/>
    /// implicitly, losslessly widens to the CLR type <paramref name="toClr"/>
    /// per the standard numeric-widening lattice (e.g. <c>uint16</c> →
    /// <c>int64</c>). Compared by <see cref="Type.FullName"/> so it is safe
    /// across reflection contexts. Narrowing and signed/unsigned same-width
    /// mismatches return <see langword="false"/>.
    /// </summary>
    private static bool WidensNumerically(Type fromClr, Type toClr)
    {
        return NumericWideningLattice.IsWidening(fromClr, toClr);
    }

    /// <summary>
    /// Issue #1150: determines whether <paramref name="fromReturn"/> implicitly,
    /// losslessly widens to <paramref name="toReturn"/> per the numeric-widening
    /// lattice. Used for the function-type → function-type return-type
    /// relaxation. Both types must be non-void numeric CLR primitives.
    /// </summary>
    private static bool ReturnTypeWidens(TypeSymbol fromReturn, TypeSymbol toReturn)
    {
        if (fromReturn == null || toReturn == null
            || fromReturn == TypeSymbol.Void || toReturn == TypeSymbol.Void)
        {
            return false;
        }

        if (WidensNumerically(fromReturn.ClrType, toReturn.ClrType))
        {
            return true;
        }

        // Issue #1356: a function returning a bare type `T` widens to a function
        // returning `T?` (the nullable form of the same type). This mirrors the
        // scalar `T → T?` implicit conversion and is the return-covariance
        // analogue that, until now, only `WidensNumerically` handled for
        // concrete numeric returns. It is essential for a return type that is a
        // bare type parameter `T` widening to `T?`: such a type parameter carries
        // no CLR backing during binding, so the numeric path never fires, yet
        // widening a non-null value to its nullable form is always safe.
        //
        // The reverse direction (`T? → T`, a null-dropping narrowing) is
        // intentionally NOT recognized here — it requires the bang operator — so
        // an unsafe `(T) -> T?` to `(T) -> T` conversion stays rejected.
        if (toReturn is NullableTypeSymbol toNullable
            && toNullable.UnderlyingType == fromReturn)
        {
            return true;
        }

        return false;
    }

    private static bool IsEnumLikeType(TypeSymbol type)
    {
        if (type is EnumSymbol)
        {
            return true;
        }

        var clr = type?.ClrType;
        if (clr == null)
        {
            return false;
        }

        // Issue #1100: a constructed generic delegate closed over a
        // same-compilation user type (whose CLR backing is an in-flight emit
        // TypeBuilder) surfaces as a
        // System.Reflection.Emit.TypeBuilderInstantiation. Its reflection
        // predicates throw NotSupportedException ("TypeBuilder generic
        // instantiation does not support resolving members") — IsEnum probes the
        // base-type chain via IsSubclassOf, which is one of the unsupported
        // operations. Such a delegate type is never an enum, so treat a throw as
        // a definite "not enum-like".
        try
        {
            return clr.IsEnum;
        }
        catch (NotSupportedException)
        {
            return false;
        }
    }

    private static bool IsReferenceLikeTarget(TypeSymbol type)
    {
        if (type is InterfaceSymbol)
        {
            return true;
        }

        if (type is StructSymbol { IsClass: true })
        {
            return true;
        }

        // Imported / CLR-backed types are reference-like when the CLR backing
        // is a class or interface (not a value type, pointer, or by-ref). User
        // value structs carry a null ClrType during binding and fall through.
        if (type?.ClrType is { } clrBacking)
        {
            return !clrBacking.IsValueType && !clrBacking.IsPointer && !clrBacking.IsByRef;
        }

        return false;
    }

    private static bool IsInterfaceLikeType(TypeSymbol type)
    {
        if (type is InterfaceSymbol)
        {
            return true;
        }

        var clr = type?.ClrType;
        if (clr == null)
        {
            return false;
        }

        // Issue #1100: as with IsEnumLikeType, querying IsInterface on a
        // TypeBuilderInstantiation throws NotSupportedException. A constructed
        // generic delegate is never an interface.
        try
        {
            return clr.IsInterface;
        }
        catch (NotSupportedException)
        {
            return false;
        }
    }

    private static bool IsValueTypeLikeFrom(TypeSymbol type)
    {
        // User structs (non-class StructSymbol) and user enums are CLR value
        // types even though their symbols carry no ClrType.
        if (type is StructSymbol s && !s.IsClass)
        {
            return true;
        }

        if (type is EnumSymbol)
        {
            return true;
        }

        return type?.ClrType != null && type.ClrType.IsValueType;
    }

    private static bool IsValueTypeAssignableToInterface(TypeSymbol from, TypeSymbol to)
    {
        // User-declared struct → user-declared interface: walk the struct's
        // declared interface list.
        if (from is StructSymbol fromStruct && to is InterfaceSymbol toInterface)
        {
            foreach (var i in fromStruct.Interfaces)
            {
                if (i == toInterface)
                {
                    return true;
                }
            }

            return false;
        }

        // Issue #976: a user-declared value-type struct → imported CLR
        // interface declared in its `: …` clause. The struct symbol has no
        // ClrType during binding, so the general CLR-assignability path below
        // cannot fire — match structurally against `ImplementedClrInterfaces`,
        // mirroring the class reference-upcast rule. This covers both plain
        // CLR interfaces (e.g. `IComparable`) and CLR generic interfaces closed
        // over a user G# type (e.g. `IEquatable[Money]`).
        if (from is StructSymbol fromValueStruct && !fromValueStruct.IsClass
            && to?.ClrType != null && to.ClrType.IsInterface)
        {
            foreach (var iface in fromValueStruct.ImplementedClrInterfaces)
            {
                var ifaceClr = iface?.ClrType;
                if (ifaceClr == null)
                {
                    continue;
                }

                if (ifaceClr == to.ClrType
                    || ClrTypeUtilities.IsAssignableByName(to.ClrType, ifaceClr))
                {
                    return true;
                }
            }
        }

        // Either side imported / CLR-typed: defer to the CLR's own
        // assignability check.
        var fromClr = from?.ClrType;
        var toClr = to?.ClrType;
        if (fromClr != null && toClr != null)
        {
            return ClrTypeUtilities.IsAssignableByName(toClr, fromClr);
        }

        return false;
    }

    /// <summary>
    /// Issue #813: returns <see langword="true"/> when one side is a G#
    /// <see cref="TupleTypeSymbol"/> and the other is the equivalent CLR
    /// <c>System.ValueTuple&lt;…&gt;</c> instantiation (with identical
    /// closed element types).
    /// </summary>
    private static bool IsTupleClrEquivalent(TypeSymbol a, TypeSymbol b)
    {
        if (a == null || b == null)
        {
            return false;
        }

        if (a is TupleTypeSymbol ta && b is not TupleTypeSymbol)
        {
            return ta.ClrType != null && b.ClrType != null && ta.ClrType == b.ClrType;
        }

        if (b is TupleTypeSymbol tb && a is not TupleTypeSymbol)
        {
            return tb.ClrType != null && a.ClrType != null && tb.ClrType == a.ClrType;
        }

        return false;
    }

    /// <summary>
    /// Issue #821: cross-context-safe slice-to-interface check. When the
    /// target is a constructed <see cref="ImportedTypeSymbol"/> whose
    /// <c>ClrType</c> is the type-erased open-definition form (because
    /// <see cref="Type.MakeGenericType(Type[])"/> could not be closed at
    /// substitution time — typically because the open definition lives in a
    /// <see cref="System.Reflection.MetadataLoadContext"/> while the
    /// substituted argument types live in the live runtime) the symbolic
    /// <see cref="ImportedTypeSymbol.TypeArguments"/> carry the real
    /// substituted G# types. Match against those, not the erased CLR
    /// arguments, so the slice still classifies as implicitly convertible to
    /// the constructed interface.
    /// </summary>
    /// <param name="slice">The source slice type.</param>
    /// <param name="targetInterface">The constructed interface target.</param>
    /// <returns><see langword="true"/> when the slice's backing array
    /// implements the target interface.</returns>
    private static bool SliceImplementsInterface(SliceTypeSymbol slice, TypeSymbol targetInterface)
    {
        // Cheap path: the target's CLR generic arguments are already the
        // properly substituted closed form. Defer to the existing
        // by-name interface walk.
        if (ClrTypeUtilities.ImplementsInterfaceByName(slice.ClrType, targetInterface.ClrType))
        {
            return true;
        }

        if (targetInterface is not ImportedTypeSymbol imported
            || imported.OpenDefinition is null
            || imported.TypeArguments.IsDefaultOrEmpty)
        {
            return false;
        }

        // Cross-context fallback: walk the slice's backing CLR array
        // interfaces and match each generic argument against the symbolic
        // TypeArguments by ClrType FullName, which is assembly-qualifier
        // free for leaf types (System.Int32, System.String, …) and so
        // compares correctly across reflection contexts.
        var openDef = imported.OpenDefinition;
        foreach (var iface in slice.ClrType.GetInterfaces())
        {
            if (!iface.IsGenericType)
            {
                continue;
            }

            if (!string.Equals(
                    iface.GetGenericTypeDefinition().FullName,
                    openDef.FullName,
                    StringComparison.Ordinal))
            {
                continue;
            }

            var ifaceArgs = iface.GetGenericArguments();
            if (ifaceArgs.Length != imported.TypeArguments.Length)
            {
                continue;
            }

            var allMatch = true;
            for (var i = 0; i < ifaceArgs.Length; i++)
            {
                var symbolic = imported.TypeArguments[i];
                if (symbolic?.ClrType is null
                    || !string.Equals(ifaceArgs[i].FullName, symbolic.ClrType.FullName, StringComparison.Ordinal))
                {
                    allMatch = false;
                    break;
                }
            }

            if (allMatch)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #1162: symbolic counterpart to <see cref="SliceImplementsInterface"/>
    /// for a slice <c>[]T</c> whose element <c>T</c> is a same-compilation user
    /// type and whose backing <see cref="TypeSymbol.ClrType"/> is therefore
    /// <see langword="null"/> during binding. The backing CLR array cannot be
    /// walked, so instead match the target interface's open definition against
    /// the known generic interfaces that a one-dimensional <c>T[]</c> implements
    /// (<c>IEnumerable&lt;T&gt;</c>, <c>IReadOnlyList&lt;T&gt;</c>,
    /// <c>IReadOnlyCollection&lt;T&gt;</c>, <c>IList&lt;T&gt;</c>,
    /// <c>ICollection&lt;T&gt;</c>) and require the single type argument to match
    /// the slice element. Slice invariance is preserved because
    /// <see cref="AreTypeArgumentsEquivalent"/> demands an exact element match.
    /// </summary>
    private static bool SliceImplementsInterfaceSymbolically(SliceTypeSymbol slice, TypeSymbol targetInterface)
    {
        if (targetInterface is not ImportedTypeSymbol imported
            || imported.OpenDefinition is null
            || imported.TypeArguments.Length != 1)
        {
            return false;
        }

        var openName = imported.OpenDefinition.FullName;
        if (openName is null)
        {
            return false;
        }

        var isArrayInterface =
            string.Equals(openName, typeof(System.Collections.Generic.IEnumerable<>).FullName, StringComparison.Ordinal)
            || string.Equals(openName, typeof(System.Collections.Generic.IReadOnlyList<>).FullName, StringComparison.Ordinal)
            || string.Equals(openName, typeof(System.Collections.Generic.IReadOnlyCollection<>).FullName, StringComparison.Ordinal)
            || string.Equals(openName, typeof(System.Collections.Generic.IList<>).FullName, StringComparison.Ordinal)
            || string.Equals(openName, typeof(System.Collections.Generic.ICollection<>).FullName, StringComparison.Ordinal);

        if (!isArrayInterface)
        {
            return false;
        }

        return AreTypeArgumentsEquivalent(imported.TypeArguments[0], slice.ElementType);
    }

    /// <summary>
    /// Issue #1302: symbolic struct → generic-interface implementation check for
    /// a constructed BCL value struct (e.g. <c>List[T].Enumerator</c>) whose
    /// element <c>T</c> is a same-compilation user type, so its
    /// <see cref="TypeSymbol.ClrType"/> (and the target interface's) is
    /// <see langword="null"/> during binding. Walk the generic interfaces the
    /// struct's OPEN definition implements, match the target interface's open
    /// definition by full name, then substitute each interface argument through
    /// the struct's symbolic <see cref="ImportedTypeSymbol.TypeArguments"/> by
    /// generic-parameter position and compare to the target's arguments via
    /// <see cref="AreTypeArgumentsEquivalent"/>. A genuine element mismatch
    /// returns <see langword="false"/> (GS0155).
    /// </summary>
    private static bool ConstructedValueTypeImplementsInterfaceSymbolically(
        ImportedTypeSymbol from,
        ImportedTypeSymbol toInterface)
    {
        var fromOpen = from.OpenDefinition;
        var toOpen = toInterface.OpenDefinition;
        if (fromOpen is null || toOpen?.FullName is null || toInterface.TypeArguments.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var iface in fromOpen.GetInterfaces())
        {
            if (!iface.IsGenericType)
            {
                continue;
            }

            if (!string.Equals(
                    iface.GetGenericTypeDefinition().FullName,
                    toOpen.FullName,
                    StringComparison.Ordinal))
            {
                continue;
            }

            var ifaceArgs = iface.GetGenericArguments();
            if (ifaceArgs.Length != toInterface.TypeArguments.Length)
            {
                continue;
            }

            var allMatch = true;
            for (var i = 0; i < ifaceArgs.Length; i++)
            {
                var ifaceArg = ifaceArgs[i];
                TypeSymbol substituted;
                if (ifaceArg.IsGenericParameter
                    && ifaceArg.GenericParameterPosition >= 0
                    && ifaceArg.GenericParameterPosition < from.TypeArguments.Length)
                {
                    substituted = from.TypeArguments[ifaceArg.GenericParameterPosition];
                }
                else
                {
                    substituted = TypeSymbol.FromClrType(ifaceArg);
                }

                if (!AreTypeArgumentsEquivalent(substituted, toInterface.TypeArguments[i]))
                {
                    allMatch = false;
                    break;
                }
            }

            if (allMatch)
            {
                return true;
            }
        }

        return false;
    }
}
