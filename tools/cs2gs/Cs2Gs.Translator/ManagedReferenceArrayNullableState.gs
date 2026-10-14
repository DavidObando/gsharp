// <copyright file="ManagedReferenceArrayNullableState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic

internal class ManagedReferenceArrayNullableState {
    init() {
        ManagedReferenceArrayProjectedCompositeType = Dictionary[ExpressionSyntax, ITypeSymbol?](
            ReferenceEqualityComparer.Instance
        )
        MappedArrayElementByElementType = Dictionary[ITypeSymbol, GTypeReference?](
            SymbolEqualityComparer.IncludeNullability
        )
        ManagedReferenceArrayProjectedMethodByCall = Dictionary[ExpressionSyntax, IMethodSymbol?](
            ReferenceEqualityComparer.Instance
        )
        ManagedReferenceArrayProjectedLocalType = Dictionary[ILocalSymbol, ITypeSymbol?](SymbolEqualityComparer.Default)
    }

    // Effective type of conditional/switch expressions whose arms carry
    // managed-reference projection. Null values cache no common safe type.
    prop ManagedReferenceArrayProjectedCompositeType Dictionary[ExpressionSyntax, ITypeSymbol?] {
        get;
    }

    // Keyed by the Roslyn element type; outer array nullability does not affect
    // CSharpTypeMapper's recursively projected element shape.
    prop MappedArrayElementByElementType Dictionary[ITypeSymbol, GTypeReference?] {
        get;
    }

    // Per-call effective method after managed-array projection. A null value
    // caches that the invocation or construction needs no substitution.
    prop ManagedReferenceArrayProjectedMethodByCall Dictionary[ExpressionSyntax, IMethodSymbol?] {
        get;
    }

    // Effective emitted type of a local whose initializer, assignments, or
    // active foreach binding agree on managed-reference projection.
    prop ManagedReferenceArrayProjectedLocalType Dictionary[ILocalSymbol, ITypeSymbol?] {
        get;
    }
}

internal class NullableTypeSymbolSlots {
    private let values[]NullableTypeSymbolSlot = System.Array.Empty[NullableTypeSymbolSlot]()

    init(length int32) {
        this.values = [length]NullableTypeSymbolSlot
    }

    prop Length int32 -> this.values.Length

    prop HasAnyValue bool {
        get {
            for slot in this.values {
                if slot != nil {
                    return true
                }
            }
            return false
        }
    }

    func HasValue(index int32) bool -> this.values[index] != nil

    func GetValue(index int32) ITypeSymbol {
        let slot NullableTypeSymbolSlot? = this.values[index]
        if slot == nil {
            throw InvalidOperationException("The nullable type-symbol slot is empty.")
        }
        return slot.Value
    }

    func SetValue(index int32, value ITypeSymbol) -> this.values[index] = NullableTypeSymbolSlot(value)

    private class NullableTypeSymbolSlot {
        init(value ITypeSymbol) {
            this.Value = value
        }

        prop Value ITypeSymbol {
            get;
        }
    }
}
