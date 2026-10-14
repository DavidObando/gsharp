// <copyright file="Issue2160NullableFunctionTypeDisplayTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import System.Collections.Immutable
import Xunit

/// Issue #2160: a nullable function type must render with the `?` wrapping
/// the whole arrow shape (`((int32) -> void)?`), not bound to the return
/// type (`(int32) -> void?`). Covers both the hover formatter
/// ((cref:SymbolDisplay)) and the raw (cref:TypeSymbol.Name) used
/// by diagnostics (e.g. GS0155).
open class Issue2160NullableFunctionTypeDisplayTests {
    @Fact
    func NullableVoidReturningFunction_ParenthesizesWholeFunctionType() {
        let type = NullableTypeSymbol.Get(Func(TypeSymbol.Void, TypeSymbol.Int32))
        Assert.Equal("(local variable) v ((int32) -> void)?", Render(type))
        Assert.Equal("((int32) -> void)?", type.Name)
    }

    @Fact
    func NullableStringReturningFunction_ParenthesizesWholeFunctionType() {
        let type = NullableTypeSymbol.Get(Func(TypeSymbol.String, TypeSymbol.Int32))
        Assert.Equal("(local variable) v ((int32) -> string)?", Render(type))
        Assert.Equal("((int32) -> string)?", type.Name)
    }

    @Fact
    func NonNullableFunction_RendersWithoutExtraParentheses() {
        let type = Func(TypeSymbol.Void, TypeSymbol.Int32)
        Assert.Equal("(local variable) v (int32) -> void", Render(type))
    }

    @Fact
    func PlainNullablePrimitive_IsUnchanged() {
        Assert.Equal("(local variable) v string?", Render(NullableTypeSymbol.Get(TypeSymbol.String)))
        Assert.Equal("(local variable) v int32?", Render(NullableTypeSymbol.Get(TypeSymbol.Int32)))
    }

    @Fact
    func SliceOfNullableFunction_ParenthesizesNestedFunctionType() {
        let type = SliceTypeSymbol.Get(NullableTypeSymbol.Get(Func(TypeSymbol.Void, TypeSymbol.Int32)))
        Assert.Equal("(local variable) v []((int32) -> void)?", Render(type))
    }

    shared {
        private func Func(
            returnType TypeSymbol,
            parameterTypes ...TypeSymbol
        ) FunctionTypeSymbol -> FunctionTypeSymbol.Get(ImmutableArray.Create(parameterTypes), returnType)

        private func Render(type TypeSymbol) string {
            let local = LocalVariableSymbol("v", isReadOnly: true, type)
            return SymbolDisplay.ToDisplayString(local, SymbolDisplayFormat.Hover)
        }
    }
}
