// <copyright file="ReflectionMetadataEmitter.Helpers.2.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
#pragma warning disable SA1028 // trailing whitespace
#pragma warning disable SA1116 // parameters begin on line after declaration
#pragma warning disable SA1117 // parameters on same line
#pragma warning disable SA1214 // readonly fields before non-readonly
#pragma warning disable SA1515 // single-line comment preceded by blank line
#pragma warning disable SA1201 // method should not follow a class (this file mixes private helper classes inline with methods)
#pragma warning disable SA1202 // 'internal' members should come before 'private' members (PR-E-5: IsValueTypeSymbol was widened to internal in-place for ConversionEmitter; ordering is restored once Phase 2 decomposition finishes)
#pragma warning disable SA1304 // non-private readonly field naming — PR-E-11 widened several emitter-internal fields to internal so the promoted MethodBodyEmitter can read them; ordering/casing restored after E-12 root thinning
#pragma warning disable SA1307 // field naming casing — same as SA1304
#pragma warning disable SA1401 // field should be private — same as SA1304
#pragma warning disable SA1611 // parameter documentation missing — PR-E-11 widened internal helpers used by MethodBodyEmitter; existing call-site comments document them
#pragma warning disable SA1615 // return-value documentation missing — same as SA1611

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Lowering.Iterators;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Emits a managed PE for a <see cref="BoundProgram"/> using
/// <see cref="System.Reflection.Metadata"/> directly.
/// </summary>
/// <remarks>
/// Phase 2 (p2-langcov) coverage: locals, parameters, unary/binary operators,
/// assignments, label/goto/conditional-goto, user-defined function calls
/// (emitted as static methods on <c>&lt;Program&gt;</c>), and the imported-call
/// surface inherited from Phase 1. Per ADR-0027 the bespoke emitter is the
/// production path for v1.0; the Roslyn-fork escape valve referenced in
/// earlier comments here has been removed from the tree.
/// </remarks>

internal sealed partial class ReflectionMetadataEmitter
{


    private static bool TryUnify(TypeSymbol formal, TypeSymbol actual, TypeParameterSymbol tp, out TypeSymbol inferred)
    {
        if (ReferenceEquals(formal, tp))
        {
            inferred = actual;
            return true;
        }

        if (formal is SliceTypeSymbol fs && actual is SliceTypeSymbol asl)
        {
            return TryUnify(fs.ElementType, asl.ElementType, tp, out inferred);
        }

        if (formal is ArrayTypeSymbol fa && actual is ArrayTypeSymbol aa)
        {
            return TryUnify(fa.ElementType, aa.ElementType, tp, out inferred);
        }

        // Issue #810: unify open-generic iterator returns of
        // `sequence[T]` / `async sequence[T]` against their substituted
        // counterparts so the MethodSpec for a call like
        // `Sequences.Empty[int32]()` can be built when no parameters
        // mention `T`.
        if (formal is SequenceTypeSymbol fseq && actual is SequenceTypeSymbol aseq)
        {
            return TryUnify(fseq.ElementType, aseq.ElementType, tp, out inferred);
        }

        // Issue #814 / ADR-0084 §L5: an extension method's open
        // `sequence[T]` receiver may have a call-site actual that is a
        // slice (`[]T`), a fixed-length array (`[N]T`), or any CLR
        // generic type implementing `IEnumerable<T>`. The binder
        // inserts a `BoundConversionExpression` widening to
        // `sequence[T]`, but `StripConversion` peels it off so emit
        // sees the pre-widening type. Without these branches the
        // method-spec inference falls through and throws
        // "Cannot infer type argument for 'T'" for the
        // `arr.FirstOrNil()` / `arr.LastOrNil()` / `arr.SingleOrNil()`
        // class/struct overload pair.
        if (formal is SequenceTypeSymbol fseqAny)
        {
            if (actual is SliceTypeSymbol aSliceEnum)
            {
                return TryUnify(fseqAny.ElementType, aSliceEnum.ElementType, tp, out inferred);
            }

            if (actual is ArrayTypeSymbol aArrEnum)
            {
                return TryUnify(fseqAny.ElementType, aArrEnum.ElementType, tp, out inferred);
            }

            if (actual?.ClrType is { } actualClrSeq)
            {
                var openIEnumerable = typeof(System.Collections.Generic.IEnumerable<>);
                System.Type matched = null;
                if (actualClrSeq.IsArray)
                {
                    var elt = actualClrSeq.GetElementType();
                    if (elt != null)
                    {
                        matched = openIEnumerable.MakeGenericType(elt);
                    }
                }
                else if (actualClrSeq.IsGenericType
                    && actualClrSeq.GetGenericTypeDefinition() == openIEnumerable)
                {
                    matched = actualClrSeq;
                }
                else
                {
                    foreach (var iface in actualClrSeq.GetInterfaces())
                    {
                        if (iface.IsGenericType
                            && iface.GetGenericTypeDefinition() == openIEnumerable)
                        {
                            matched = iface;
                            break;
                        }
                    }
                }

                if (matched != null)
                {
                    var elementSym = TypeSymbol.FromClrType(matched.GetGenericArguments()[0]);
                    if (TryUnify(fseqAny.ElementType, elementSym, tp, out inferred))
                    {
                        return true;
                    }
                }
            }
        }

        if (formal is AsyncSequenceTypeSymbol faseq && actual is AsyncSequenceTypeSymbol aaseq)
        {
            return TryUnify(faseq.ElementType, aaseq.ElementType, tp, out inferred);
        }

        // Issue #814: mirror of the synchronous sequence-vs-enumerable
        // unification above for `async sequence[T]` receivers against
        // any CLR generic implementing `IAsyncEnumerable<T>`.
        if (formal is AsyncSequenceTypeSymbol faseqAny && actual?.ClrType is { } actualClrAseq)
        {
            var openIAsync = typeof(System.Collections.Generic.IAsyncEnumerable<>);
            System.Type matched = null;
            if (actualClrAseq.IsGenericType
                && actualClrAseq.GetGenericTypeDefinition() == openIAsync)
            {
                matched = actualClrAseq;
            }
            else
            {
                foreach (var iface in actualClrAseq.GetInterfaces())
                {
                    if (iface.IsGenericType
                        && iface.GetGenericTypeDefinition() == openIAsync)
                    {
                        matched = iface;
                        break;
                    }
                }
            }

            if (matched != null)
            {
                var elementSym = TypeSymbol.FromClrType(matched.GetGenericArguments()[0]);
                if (TryUnify(faseqAny.ElementType, elementSym, tp, out inferred))
                {
                    return true;
                }
            }
        }

        if (formal is NullableTypeSymbol fnu && actual is NullableTypeSymbol anu)
        {
            return TryUnify(fnu.UnderlyingType, anu.UnderlyingType, tp, out inferred);
        }

        // Issue #813: unify value-tuple element types so the MethodSpec
        // for an iterator-returning call like
        // `Sequences.Indexed[int32](source)` resolves `T` from the
        // formal return shape `sequence[(int32, T)]` against the
        // substituted `sequence[(int32, int32)]`. Without this branch
        // the recursive sequence unification above would only see the
        // tuple wrapper and fail to descend into its element types.
        // The actual side may arrive either as a TupleTypeSymbol (when
        // the binder's SubstituteType produced one) or as an
        // ImportedTypeSymbol whose ClrType is a closed `ValueTuple<…>`
        // (when SubstituteType lifted it back through
        // TypeSymbol.FromClrType on the closed CLR shape).
        if (formal is TupleTypeSymbol ftup)
        {
            ImmutableArray<TypeSymbol> actualElements = default;
            if (actual is TupleTypeSymbol atup
                && ftup.ElementTypes.Length == atup.ElementTypes.Length)
            {
                actualElements = atup.ElementTypes;
            }
            else if (actual?.ClrType is { } actualClr
                && actualClr.IsGenericType
                && IsValueTupleOpenDefinition(actualClr.GetGenericTypeDefinition())
                && actualClr.GenericTypeArguments.Length == ftup.ElementTypes.Length)
            {
                var b = ImmutableArray.CreateBuilder<TypeSymbol>(actualClr.GenericTypeArguments.Length);
                foreach (var arg in actualClr.GenericTypeArguments)
                {
                    b.Add(TypeSymbol.FromClrType(arg));
                }

                actualElements = b.MoveToImmutable();
            }

            if (!actualElements.IsDefault)
            {
                for (int i = 0; i < ftup.ElementTypes.Length; i++)
                {
                    if (TryUnify(ftup.ElementTypes[i], actualElements[i], tp, out inferred))
                    {
                        return true;
                    }
                }
            }
        }

        // Issue #821: when the formal is a constructed CLR generic
        // interface that the actual's backing array satisfies — e.g.
        // `IEnumerable[T]` / `IList[T]` / `ICollection[T]` /
        // `IReadOnlyList[T]` (any interface implemented by `T[]`) — and
        // the actual is a `[]T` slice or `[N]T` fixed-length array,
        // bridge their generic arguments by locating the matching
        // interface instantiation on the actual's backing CLR `T[]` and
        // recursing into the element-type slot. Mirrors the binder's
        // slice-to-interface classifier (#570) and the
        // `sequence[T]`-vs-slice/array arm above (#774/#814) at the
        // static-method / free-function argument-slot inference path so
        // generic-method-spec construction can recover `T` from a
        // slice argument when the type parameter only appears in an
        // interface-typed formal parameter (no `T` in the return).
        if (formal is ImportedTypeSymbol formalImported
            && formalImported.ClrType is { IsInterface: true, IsGenericType: true } formalIface
            && !formalImported.TypeArguments.IsDefaultOrEmpty
            && (actual is SliceTypeSymbol || actual is ArrayTypeSymbol)
            && actual?.ClrType is { IsArray: true } actualClrArray)
        {
            Type matched = null;
            foreach (var iface in actualClrArray.GetInterfaces())
            {
                if (iface.IsGenericType
                    && ClrTypeUtilities.AreSame(
                        iface.GetGenericTypeDefinition(),
                        formalIface.GetGenericTypeDefinition()))
                {
                    matched = iface;
                    break;
                }
            }

            if (matched != null)
            {
                var matchedArgs = matched.GetGenericArguments();
                if (formalImported.TypeArguments.Length == matchedArgs.Length)
                {
                    for (int i = 0; i < formalImported.TypeArguments.Length; i++)
                    {
                        if (TryUnify(
                                formalImported.TypeArguments[i],
                                TypeSymbol.FromClrType(matchedArgs[i]),
                                tp,
                                out inferred))
                        {
                            return true;
                        }
                    }
                }
            }
        }

        var formalArgs = GetGenericTypeArguments(formal);
        var actualArgs = GetGenericTypeArguments(actual);
        if (!formalArgs.IsDefaultOrEmpty && !actualArgs.IsDefaultOrEmpty
            && formalArgs.Length == actualArgs.Length)
        {
            for (int i = 0; i < formalArgs.Length; i++)
            {
                if (TryUnify(formalArgs[i], actualArgs[i], tp, out inferred))
                {
                    return true;
                }
            }
        }

        inferred = null;
        return false;
    }

    /// <summary>
    /// Issue #813: returns <see langword="true"/> when <paramref name="openDef"/>
    /// is one of the BCL <c>System.ValueTuple&lt;…&gt;</c> open generic
    /// definitions (arities 1–8). Used by the structural unification
    /// engine so a formal <see cref="TupleTypeSymbol"/> can match against
    /// an actual CLR <c>ValueTuple</c> instance recovered through
    /// <see cref="TypeSymbol.FromClrType"/>.
    /// </summary>
    private static bool IsValueTupleOpenDefinition(Type openDef)
    {
        if (openDef == null)
        {
            return false;
        }

        return openDef.IsSameAs(typeof(ValueTuple<>))
            || openDef.IsSameAs(typeof(ValueTuple<,>))
            || openDef.IsSameAs(typeof(ValueTuple<,,>))
            || openDef.IsSameAs(typeof(ValueTuple<,,,>))
            || openDef.IsSameAs(typeof(ValueTuple<,,,,>))
            || openDef.IsSameAs(typeof(ValueTuple<,,,,,>))
            || openDef.IsSameAs(typeof(ValueTuple<,,,,,,>))
            || openDef.IsSameAs(typeof(ValueTuple<,,,,,,,>));
    }

    /// <summary>
    /// ADR-0087 §3 R3: resolves the right token for a call to a user
    /// instance method. For a non-generic containing type returns the
    /// bare <c>MethodDef</c>; for a generic containing type returns a
    /// <c>MemberRef</c> parented at the constructed (or self-) <c>TypeSpec</c>.
    /// </summary>
    // ADR-0118 / issue #944: a type that declares a user indexer member must
    // carry a System.Reflection.DefaultMemberAttribute("Item") so the CLR (and
    // C# consumers) recognise its `Item` property as the default indexer.
    private void EmitDefaultMemberAttributeIfIndexer(StructSymbol structSym)
    {
        if (structSym.Properties.IsDefaultOrEmpty)
        {
            return;
        }

        var hasIndexer = false;
        foreach (var prop in structSym.Properties)
        {
            if (prop.IsIndexer)
            {
                hasIndexer = true;
                break;
            }
        }

        if (!hasIndexer)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSym, out var typeDefHandle))
        {
            return;
        }

        this.customAttrEncoder.EmitStringAttribute(
            typeDefHandle,
            "System.Reflection.DefaultMemberAttribute",
            typeof(System.Reflection.DefaultMemberAttribute),
            "Item");
    }

    /// <summary>
    /// Issue #774: normalises any receiver type that carries open generic
    /// arguments (an <see cref="ImportedTypeSymbol"/> with
    /// <see cref="ImportedTypeSymbol.OpenDefinition"/>, a
    /// <see cref="SequenceTypeSymbol"/> with no <see cref="TypeSymbol.ClrType"/>,
    /// or its async counterpart) into the open CLR definition plus the
    /// symbolic argument list. Lets the symbolic-container MemberRef path
    /// fire uniformly for all three shapes.
    /// </summary>
    private static bool TryNormalizeToSymbolicContainer(
        TypeSymbol containingTypeSymbol,
        out Type openDefinition,
        out ImmutableArray<TypeSymbol> typeArguments)
    {
        switch (containingTypeSymbol)
        {
            case ImportedTypeSymbol imp when imp.OpenDefinition != null && !imp.TypeArguments.IsDefaultOrEmpty:
                openDefinition = imp.OpenDefinition;
                typeArguments = imp.TypeArguments;
                return true;
            case SequenceTypeSymbol seq when seq.ClrType == null:
                openDefinition = typeof(System.Collections.Generic.IEnumerable<>);
                typeArguments = ImmutableArray.Create<TypeSymbol>(seq.ElementType);
                return true;
            case AsyncSequenceTypeSymbol aseq when aseq.ClrType == null:
                openDefinition = typeof(System.Collections.Generic.IAsyncEnumerable<>);
                typeArguments = ImmutableArray.Create<TypeSymbol>(aseq.ElementType);
                return true;
            case NullableTypeSymbol nul when nul.UnderlyingType is TypeParameterSymbol nullableTp && nullableTp.HasValueTypeConstraint:
                // Issue #806: a `T?` receiver where T is an open value-type
                // type parameter has no constructed CLR `Nullable<T>` here —
                // route member-ref encoding through the symbolic container
                // path so the MemberRef parent is `Nullable<!!T>` against
                // System.Runtime, not against the current assembly.
                openDefinition = typeof(System.Nullable<>);
                typeArguments = ImmutableArray.Create<TypeSymbol>(nullableTp);
                return true;
            default:
                openDefinition = null;
                typeArguments = default;
                return false;
        }
    }

    // Issue #821: choose the right erased `object` for an open generic
    // definition's MakeGenericType call. The open def may live in a
    // MetadataLoadContext (reference-pack assemblies); passing a live
    // `typeof(object)` to its MakeGenericType raises ArgumentException with
    // "type was not loaded by the MetadataLoadContext that loaded the
    // generic type or method." Use `emitCtx.CoreObjectType`, which is the
    // System.Object resolved through the active reference context, when the
    // open def lives outside the host runtime.
    private Type[] GetErasedObjectArgs(Type openDefinition)
    {
        var parameters = openDefinition.GetGenericArguments();
        var result = new Type[parameters.Length];
        var coreObject = ChooseErasedObjectType(openDefinition);
        for (var i = 0; i < parameters.Length; i++)
        {
            // Issue #806: a generic parameter with the `struct`
            // constraint cannot be closed with `System.Object`
            // (MakeGenericType throws ArgumentException). Use a
            // BCL value-type placeholder (`int32`) so the
            // symbolic-container path can construct the closed
            // type purely for parent-TypeSpec encoding. The
            // closed type's identity is irrelevant beyond the
            // open definition's reflection metadata.
            var p = parameters[i];
            if ((p.GenericParameterAttributes & System.Reflection.GenericParameterAttributes.NotNullableValueTypeConstraint) != 0)
            {
                result[i] = ChooseErasedValueTypeType(openDefinition);
            }
            else
            {
                result[i] = coreObject;
            }
        }

        return result;
    }

    // Issue #671 (construction-call follow-up): a generic type-argument
    // position carries a "user-defined" symbol when it is itself a
    // user-declared type (Struct/Class/Interface/Enum/Delegate) — its
    // ClrType is only produced during emit — or when it is a nested
    // constructed generic whose own arguments transitively carry one.
    // This predicate gates the symbolic-container emit paths so a
    // <c>List[List[MyGs]]</c> receiver is recognised even though its
    // outer argument is an <see cref="ImportedTypeSymbol"/> rather than a
    // direct user-defined symbol.
    private static bool ArgIsSymbolicUserDefined(TypeSymbol arg)
    {
        if (arg is StructSymbol or InterfaceSymbol or EnumSymbol or DelegateTypeSymbol)
        {
            return true;
        }

        // Issue #833: an in-scope generic type parameter (MVar/Var) carried
        // through as a call-site type argument must drive the symbolic
        // encoding path so the resulting MethodSpec references `MVar(idx)`
        // / `Var(idx)` instead of the type-erased `System.Object`
        // placeholder.
        if (arg is TypeParameterSymbol)
        {
            return true;
        }

        if (arg is ImportedTypeSymbol nested
            && nested.OpenDefinition != null
            && !nested.TypeArguments.IsDefaultOrEmpty
            && nested.TypeArguments.Any(ArgIsSymbolicUserDefined))
        {
            return true;
        }

        if (arg is ArrayTypeSymbol arr)
        {
            return ArgIsSymbolicUserDefined(arr.ElementType);
        }

        if (arg is SliceTypeSymbol slice)
        {
            return ArgIsSymbolicUserDefined(slice.ElementType);
        }

        if (arg is NullableTypeSymbol nullable && nullable.UnderlyingType != null)
        {
            return ArgIsSymbolicUserDefined(nullable.UnderlyingType);
        }

        return false;
    }

    /// <summary>
    /// Issue #456: deterministic ordering for FunctionSymbols emitted into
    /// the MethodDef table. Sort first by the function's source declaration
    /// start (so user-visible order matches source order), then by name
    /// (Ordinal) for synthesized helpers that lack a Declaration or share a
    /// span. This guarantees byte-identical MethodDef layout across
    /// Compilation instances, which is required for byte-deterministic emit
    /// (cf. <see cref="DebugInformationOptions.Deterministic"/>).
    /// </summary>
    private sealed class FunctionEmitOrderComparer : IComparer<FunctionSymbol>
    {
        public static readonly FunctionEmitOrderComparer Instance = new FunctionEmitOrderComparer();

        private FunctionEmitOrderComparer()
        {
        }

        public int Compare(FunctionSymbol x, FunctionSymbol y)
        {
            if (ReferenceEquals(x, y))
            {
                return 0;
            }

            if (x is null)
            {
                return -1;
            }

            if (y is null)
            {
                return 1;
            }

            int xPos = x.Declaration?.Span.Start ?? int.MaxValue;
            int yPos = y.Declaration?.Span.Start ?? int.MaxValue;
            int cmp = xPos.CompareTo(yPos);
            if (cmp != 0)
            {
                return cmp;
            }

            cmp = string.CompareOrdinal(x.Name ?? string.Empty, y.Name ?? string.Empty);
            if (cmp != 0)
            {
                return cmp;
            }

            // Final tiebreaker for distinct-but-otherwise-equal symbols (e.g.
            // synthesized partial-method shadows): fall back to a stable
            // signature string so equal-named overloads get a deterministic
            // order even when source positions and names coincide.
            return string.CompareOrdinal(FormatSignature(x), FormatSignature(y));
        }

        private static string FormatSignature(FunctionSymbol fn)
        {
            var sb = new System.Text.StringBuilder();
            sb.Append(fn.Type?.Name ?? "?");
            sb.Append('(');
            for (int i = 0; i < fn.Parameters.Length; i++)
            {
                if (i > 0)
                {
                    sb.Append(',');
                }

                sb.Append(fn.Parameters[i].Type?.Name ?? "?");
            }

            sb.Append(')');
            return sb.ToString();
        }
    }
}
