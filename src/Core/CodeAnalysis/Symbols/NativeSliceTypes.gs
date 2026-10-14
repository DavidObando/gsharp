// <copyright file="NativeSliceTypes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Emit
import System
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection

/// Nominal recognition of ADR-0190 descriptors. They use the ordinary imported
/// generic representation, never the array-backed (cref:SliceTypeSymbol).
internal shared class NativeSliceTypes {
    internal const AssemblyName string = "Gsharp.Runtime.Values"

    internal func IsDefinition(@NotNullWhen(true) type Type?, out readOnly bool) bool {
        readOnly = false
        if type == nil || !type.IsGenericType {
            return false
        }
        // Symbolic constructed types need not implement IsByRefLike. Identify
        // the SDK declaration first, then inspect traits on that definition.
        let definition = type.GetGenericTypeDefinition()
        if definition.Assembly.GetName().Name != NativeSliceTypes.AssemblyName {
            return false
        }
        let name = definition.FullName
        readOnly = name == "Gsharp.Values.ReadOnlySlice`1"
        return (readOnly || name == "Gsharp.Values.Slice`1") && definition.IsValueType && !definition.IsByRefLike
    }

    internal func TryGetElement(type TypeSymbol, @NotNullWhen(true) out element TypeSymbol?, out readOnly bool) bool {
        element = nil
        readOnly = false
        let clrType = type.ClrType
        if type is NullableTypeSymbol || !IsDefinition(clrType, out readOnly) {
            return false
        }
        if type is NullabilityAnnotatedTypeSymbol annotated {
            element = annotated.GetTypeArgumentSymbol(0)
            return true
        }
        let arguments = type.ConstructedTypeArguments
        element = if arguments.Length == 1 {
            arguments[0]
        } else {
            TypeSymbol.FromClrTypeWithoutNullability(
                clrType!!.GetGenericArguments()[0],
                NullabilityFreeReason.TypeStructure
            )
        }
        return true
    }

    internal func TryResolveDefinition(
        references ReferenceResolver,
        readOnly bool,
        @NotNullWhen(true) out type Type?
    ) bool {
        type = nil
        if references.GetCoreType("System.Object").Assembly.GetName().Version?.Major < 10 {
            return false
        }
        if references.TryResolveType(
            if readOnly {
                "Gsharp.Values.ReadOnlySlice`1"
            } else {
                "Gsharp.Values.Slice`1"
            },
            out type
        ) &&
            IsDefinition(type, out _) &&
            type!!
            .GetMethods().Any((m MethodInfo) -> m.Name == "Subslice" && m.GetParameters().Length == 4) &&
            type!!
            .GetMethods().Any((m MethodInfo) -> m.Name == "FromArray" && m.GetParameters().Length == 1) {
            return true
        }
        type = nil
        return false
    }

    internal func HaveIncompatibleElements(source TypeSymbol?, target TypeSymbol?) bool {
        var source = source
        var target = target
        source = if source is NullableTypeSymbol nullableSource {
            nullableSource.UnderlyingType
        } else {
            source
        }
        target = if target is NullableTypeSymbol nullableTarget {
            nullableTarget.UnderlyingType
        } else {
            target
        }
        return source != nil &&
            target != nil &&
            TryGetElement(source, out var from, out _) &&
            TryGetElement(target, out var to, out _) &&
            (
            !Conversion.ClassifyNonStructural(from!!, to!!).IsIdentity || !NullableFlagsBuilder.Build(from!!)
                .SequenceEqual(NullableFlagsBuilder.Build(to!!))
        )
    }
}
