// <copyright file="NativeSliceTypes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Emit;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Nominal recognition of ADR-0190 descriptors. They use the ordinary imported
/// generic representation, never the array-backed <see cref="SliceTypeSymbol"/>.
/// </summary>
internal static class NativeSliceTypes
{
    internal const string AssemblyName = "Gsharp.Runtime.Values";

    internal static bool IsDefinition([NotNullWhen(true)] Type? type, out bool readOnly)
    {
        readOnly = false;
        if (type == null || !type.IsGenericType || !type.IsValueType || type.IsByRefLike
            || type.Assembly.GetName().Name != AssemblyName)
        {
            return false;
        }

        var name = type.GetGenericTypeDefinition().FullName;
        readOnly = name == "Gsharp.Values.ReadOnlySlice`1";
        return readOnly || name == "Gsharp.Values.Slice`1";
    }

    internal static bool TryGetElement(TypeSymbol type, [NotNullWhen(true)] out TypeSymbol? element, out bool readOnly)
    {
        element = null;
        readOnly = false;
        var clrType = type.ClrType;
        if (type is NullableTypeSymbol || !IsDefinition(clrType, out readOnly))
        {
            return false;
        }

        if (type is NullabilityAnnotatedTypeSymbol annotated)
        {
            element = annotated.GetTypeArgumentSymbol(0);
            return true;
        }

        var arguments = type.ConstructedTypeArguments;
        element = arguments.Length == 1
            ? arguments[0]
            : TypeSymbol.FromClrType(clrType.GetGenericArguments()[0]);
        return true;
    }

    internal static bool TryResolveDefinition(ReferenceResolver references, bool readOnly, [NotNullWhen(true)] out Type? type)
    {
        type = null;
        if (references.GetCoreType("System.Object").Assembly.GetName().Version?.Major < 10)
        {
            return false;
        }

        if (references.TryResolveType(readOnly ? "Gsharp.Values.ReadOnlySlice`1" : "Gsharp.Values.Slice`1", out type)
            && IsDefinition(type, out _)
            && type.GetMethods().Any(m => m.Name == "Subslice" && m.GetParameters().Length == 4)
            && type.GetMethods().Any(m => m.Name == "FromArray" && m.GetParameters().Length == 1))
        {
            return true;
        }

        type = null;
        return false;
    }

    internal static bool HaveIncompatibleElements(TypeSymbol? source, TypeSymbol? target)
    {
        source = source is NullableTypeSymbol nullableSource ? nullableSource.UnderlyingType : source;
        target = target is NullableTypeSymbol nullableTarget ? nullableTarget.UnderlyingType : target;
        return source != null && target != null
            && TryGetElement(source, out var from, out _)
            && TryGetElement(target, out var to, out _)
            && (!Conversion.ClassifyNonStructural(from, to).IsIdentity
                || !NullableFlagsBuilder.Build(from).SequenceEqual(NullableFlagsBuilder.Build(to)));
    }
}
