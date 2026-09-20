// <copyright file="ManagedReferenceTypes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Emit;

namespace GSharp.Core.CodeAnalysis.Symbols;

internal static class ManagedReferenceTypes
{
    internal static bool IsDefinition([NotNullWhen(true)] Type? type, out bool readOnly)
    {
        readOnly = false;
        if (type == null || !type.IsGenericType)
        {
            return false;
        }

        var definition = type.GetGenericTypeDefinition();
        if (definition.Assembly.GetName().Name != NativeSliceTypes.AssemblyName)
        {
            return false;
        }

        readOnly = definition.FullName == "Gsharp.Values.ReadOnlyManagedRef`1";
        return (readOnly || definition.FullName == "Gsharp.Values.ManagedRef`1") && !definition.IsValueType;
    }

    internal static bool TryGetElement(TypeSymbol type, [NotNullWhen(true)] out TypeSymbol? element, out bool readOnly)
    {
        element = null;
        readOnly = false;
        if (type is NullableTypeSymbol || !IsDefinition(type.ClrType, out readOnly))
        {
            return false;
        }

        element = type is NullabilityAnnotatedTypeSymbol annotated
            ? annotated.GetTypeArgumentSymbol(0)
            : type.ConstructedTypeArguments is { Length: 1 } arguments
                ? arguments[0]
                : TypeSymbol.FromClrType(type.ClrType.GetGenericArguments()[0]);
        return true;
    }

    internal static bool TryResolveDefinition(ReferenceResolver references, bool readOnly, [NotNullWhen(true)] out Type? type)
    {
        type = null;
        return references.TryResolveType(readOnly ? "Gsharp.Values.ReadOnlyManagedRef`1" : "Gsharp.Values.ManagedRef`1", out type)
            && IsDefinition(type, out _);
    }

    internal static TypeSymbol Construct(Type definition, TypeSymbol element, ReferenceResolver references)
        => ImportedTypeSymbol.GetConstructed(
            definition.MakeGenericType(references.MapClrTypeToReferences(element.ClrType ?? typeof(object))),
            definition,
            ImmutableArray.Create(element));

    internal static BoundExpression Borrow(BoundExpression handle)
    {
        TryGetElement(handle.Type, out var element, out _);
        var pointee = Invariant.Required(element, "Borrow is only constructed for a recognized non-null managed handle");
        var method = Invariant.Required(handle.Type.ClrType, "managed handles have a runtime type").GetMethods()
            .Single(m => m.Name == "Borrow" && m.GetParameters().Length == 0);
        return new BoundImportedInstanceCallExpression(
            handle.Syntax, handle, method, ByRefTypeSymbol.Get(pointee), ImmutableArray<BoundExpression>.Empty);
    }

    internal static bool HaveIncompatibleElements(TypeSymbol from, TypeSymbol to)
    {
        from = from is NullableTypeSymbol nf ? nf.UnderlyingType : from;
        to = to is NullableTypeSymbol nt ? nt.UnderlyingType : to;
        return TryGetElement(from, out var left, out _) && TryGetElement(to, out var right, out _)
            && (!Conversion.ClassifyNonStructural(left, right).IsIdentity
                || !NullableFlagsBuilder.Build(left).SequenceEqual(NullableFlagsBuilder.Build(right)));
    }
}
