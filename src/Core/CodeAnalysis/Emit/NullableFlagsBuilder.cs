// <copyright file="NullableFlagsBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Issue #834: computes the C#-compatible
/// <c>[System.Runtime.CompilerServices.NullableAttribute]</c> byte array
/// (DFS pre-order) for a GSharp <see cref="TypeSymbol"/>. The bytes use the
/// well-known encoding:
/// <list type="bullet">
/// <item><c>0</c> — oblivious (no nullability information; we never emit this byte
/// ourselves but pass it through when present on an imported
/// <see cref="NullabilityAnnotatedTypeSymbol"/>).</item>
/// <item><c>1</c> — not-annotated (non-nullable reference / open type parameter).</item>
/// <item><c>2</c> — annotated (nullable reference / nullable open type parameter).</item>
/// </list>
/// <para>
/// Layout mirrors the C# compiler: byte 0 belongs to the outer type when that
/// type occupies a reference-type position; value-type positions contribute no
/// byte, but the walker still recurses into their generic-type arguments so
/// inner reference-type positions are surfaced (matches
/// <see cref="ClrNullability.CountNullabilityBytes(System.Type)"/>).
/// </para>
/// <para>
/// Per-position attributes are intentionally narrow — they only describe what
/// C#'s nullable flow analysis needs to see at a parameter / return slot. They
/// do not depend on whether the receiver, declaring type, or assembly has its
/// own <c>NullableContextAttribute</c>; the per-slot byte array overrides any
/// surrounding context.
/// </para>
/// </summary>
internal static class NullableFlagsBuilder
{
    /// <summary>The byte the C# compiler uses for non-nullable reference positions.</summary>
    internal const byte NotAnnotated = 1;

    /// <summary>The byte the C# compiler uses for nullable reference positions.</summary>
    internal const byte Annotated = 2;

    /// <summary>
    /// Computes the DFS pre-order nullable byte array for the supplied
    /// <see cref="TypeSymbol"/>. Returns an empty array when the type
    /// contributes no reference-type positions (e.g. a pure value type with no
    /// reference-typed generic arguments) — in which case no
    /// <c>NullableAttribute</c> need be emitted.
    /// </summary>
    /// <param name="type">The parameter / return / field / property type to inspect.</param>
    /// <returns>The flags array — possibly empty; never <see langword="default"/>.</returns>
    internal static ImmutableArray<byte> Build(TypeSymbol type)
    {
        var builder = ImmutableArray.CreateBuilder<byte>();
        Append(type, builder);
        return builder.ToImmutable();
    }

    private static void Append(TypeSymbol type, ImmutableArray<byte>.Builder builder)
    {
        if (type == null)
        {
            return;
        }

        // Imported wrapper that already carries the C# DFS byte array — pass
        // it through verbatim. This is the shape C# emits for generic types
        // with inner-position nullability (e.g. `IEnumerable<string?>`).
        if (type is NullabilityAnnotatedTypeSymbol annotated && !annotated.NullableFlags.IsDefaultOrEmpty)
        {
            builder.AddRange(annotated.NullableFlags);
            return;
        }

        if (type is NullableTypeSymbol nullable)
        {
            var inner = nullable.UnderlyingType;

            // `T?` over a struct-constrained type parameter lowers to
            // `Nullable<T>` at the signature level — that's a value type, so
            // the outer position contributes no byte and the inner type
            // parameter contributes none either. Result: empty.
            if (IsValueTypeNullableLowering(inner))
            {
                return;
            }

            // Reference-position annotated as nullable.
            builder.Add(Annotated);
            AppendGenericArguments(inner, builder);
            return;
        }

        if (type is TypeParameterSymbol tp)
        {
            if (tp.HasValueTypeConstraint)
            {
                // `struct`-constrained TPs occupy value-type positions — no byte.
                return;
            }

            builder.Add(NotAnnotated);
            return;
        }

        if (type is ByRefTypeSymbol byRef)
        {
            // A `ref T` parameter shape is encoded at the parent (parameter)
            // encoder level via `isByRef: true`; the nullability byte set is
            // that of the pointee T.
            Append(byRef.PointeeType, builder);
            return;
        }

        if (type is ArrayTypeSymbol arr)
        {
            builder.Add(NotAnnotated);
            Append(arr.ElementType, builder);
            return;
        }

        if (type is SliceTypeSymbol slice)
        {
            builder.Add(NotAnnotated);
            Append(slice.ElementType, builder);
            return;
        }

        if (type is TupleTypeSymbol tup)
        {
            // ValueTuple<...> is a value type — outer position contributes
            // no byte, but element positions are visited in declaration order.
            foreach (var elem in tup.ElementTypes)
            {
                Append(elem, builder);
            }

            return;
        }

        if (type is EnumSymbol)
        {
            // User-defined enums are CLR value types.
            return;
        }

        if (type is StructSymbol structSym)
        {
            if (structSym.IsClass)
            {
                builder.Add(NotAnnotated);
            }

            if (!structSym.TypeArguments.IsDefaultOrEmpty)
            {
                foreach (var arg in structSym.TypeArguments)
                {
                    Append(arg, builder);
                }
            }
            else if (!structSym.TypeParameters.IsDefaultOrEmpty)
            {
                // Open self-reference (the struct's own type parameters) —
                // each is a reference-typed open TP slot unless `struct`-constrained.
                foreach (var defTp in structSym.TypeParameters)
                {
                    Append(defTp, builder);
                }
            }

            return;
        }

        if (type is InterfaceSymbol ifaceSym)
        {
            builder.Add(NotAnnotated);
            if (!ifaceSym.TypeArguments.IsDefaultOrEmpty)
            {
                foreach (var arg in ifaceSym.TypeArguments)
                {
                    Append(arg, builder);
                }
            }
            else if (!ifaceSym.TypeParameters.IsDefaultOrEmpty)
            {
                foreach (var defTp in ifaceSym.TypeParameters)
                {
                    Append(defTp, builder);
                }
            }

            return;
        }

        if (type is ImportedTypeSymbol imported)
        {
            var clr = imported.ClrType;
            var isValueType = clr != null && clr.IsValueType;
            if (!isValueType)
            {
                builder.Add(NotAnnotated);
            }

            // Prefer the symbolic TypeArguments — they preserve in-scope
            // type-parameter identity so nullability for `IEnumerable[T]`
            // is captured as the TP's byte (or skipped for `struct` Ts).
            if (!imported.TypeArguments.IsDefaultOrEmpty)
            {
                foreach (var arg in imported.TypeArguments)
                {
                    Append(arg, builder);
                }
            }
            else if (clr != null && clr.IsGenericType && !clr.IsGenericTypeDefinition)
            {
                foreach (var clrArg in clr.GetGenericArguments())
                {
                    AppendClrType(clrArg, builder);
                }
            }

            return;
        }

        // Fallback: dispatch via the CLR type when present.
        var clrFallback = type.ClrType;
        if (clrFallback != null)
        {
            AppendClrType(clrFallback, builder);
            return;
        }

        // Last-resort: a symbolic reference type with no other information.
        builder.Add(NotAnnotated);
    }

    private static void AppendGenericArguments(TypeSymbol type, ImmutableArray<byte>.Builder builder)
    {
        if (type == null)
        {
            return;
        }

        if (type is StructSymbol s && !s.TypeArguments.IsDefaultOrEmpty)
        {
            foreach (var arg in s.TypeArguments)
            {
                Append(arg, builder);
            }

            return;
        }

        if (type is InterfaceSymbol iface && !iface.TypeArguments.IsDefaultOrEmpty)
        {
            foreach (var arg in iface.TypeArguments)
            {
                Append(arg, builder);
            }

            return;
        }

        if (type is TupleTypeSymbol tup)
        {
            foreach (var elem in tup.ElementTypes)
            {
                Append(elem, builder);
            }

            return;
        }

        if (type is ImportedTypeSymbol imported)
        {
            if (!imported.TypeArguments.IsDefaultOrEmpty)
            {
                foreach (var arg in imported.TypeArguments)
                {
                    Append(arg, builder);
                }

                return;
            }

            var clr = imported.ClrType;
            if (clr != null && clr.IsGenericType && !clr.IsGenericTypeDefinition)
            {
                foreach (var clrArg in clr.GetGenericArguments())
                {
                    AppendClrType(clrArg, builder);
                }
            }

            return;
        }

        var fallbackClr = type.ClrType;
        if (fallbackClr != null && fallbackClr.IsGenericType && !fallbackClr.IsGenericTypeDefinition)
        {
            foreach (var clrArg in fallbackClr.GetGenericArguments())
            {
                AppendClrType(clrArg, builder);
            }
        }
    }

    private static void AppendClrType(Type clrType, ImmutableArray<byte>.Builder builder)
    {
        if (clrType == null)
        {
            return;
        }

        if (clrType.IsGenericParameter)
        {
            // Open CLR generic parameter (e.g. encountered when walking the
            // CLR generic-argument list of an imported type). Treat as a
            // reference-position slot: matches Roslyn's behaviour for an
            // unconstrained or class-constrained type parameter.
            builder.Add(NotAnnotated);
            return;
        }

        if (clrType.IsByRef)
        {
            AppendClrType(clrType.GetElementType(), builder);
            return;
        }

        if (clrType.IsArray)
        {
            builder.Add(NotAnnotated);
            AppendClrType(clrType.GetElementType(), builder);
            return;
        }

        var isValueType = clrType.IsValueType;
        if (!isValueType)
        {
            builder.Add(NotAnnotated);
        }

        if (clrType.IsGenericType && !clrType.IsGenericTypeDefinition)
        {
            foreach (var arg in clrType.GetGenericArguments())
            {
                AppendClrType(arg, builder);
            }
        }
    }

    private static bool IsValueTypeNullableLowering(TypeSymbol inner)
    {
        if (inner is TypeParameterSymbol tp && tp.HasValueTypeConstraint)
        {
            return true;
        }

        if (inner?.ClrType is { IsValueType: true })
        {
            return true;
        }

        if (inner is StructSymbol s && !s.IsClass)
        {
            return true;
        }

        if (inner is EnumSymbol)
        {
            return true;
        }

        return false;
    }
}
