// <copyright file="SymbolDisplayImportedTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import System.Collections.Generic
import System.Diagnostics
import System.Threading.Tasks
import Xunit

/// Hover/type display for symbols typed as imported CLR types. A constructed
/// generic such as `Task[string]` must render with its friendly G# name
/// rather than the raw assembly-qualified (cref:System.Type.FullName)
/// that (cref:TypeSymbol.Name) carries for closed generics.
open class SymbolDisplayImportedTypeTests {
    @Fact
    func LocalVariable_OfConstructedGenericTask_RendersFriendlyName() {
        let type = ImportedTypeSymbol.Get(typeof(Task[string]))
        Assert.Equal("(local variable) v System.Threading.Tasks.Task[string]", Render(type))
    }

    @Fact
    func LocalVariable_OfNonGenericImportedType_RendersQualifiedName() {
        let type = ImportedTypeSymbol.Get(typeof(Process))
        Assert.Equal("(local variable) v System.Diagnostics.Process", Render(type))
    }

    @Fact
    func LocalVariable_OfNestedGeneric_RendersFriendlyArguments() {
        let type = ImportedTypeSymbol.Get(typeof(Dictionary[string, List[int32]]))
        Assert.Equal(
            "(local variable) v System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[int32]]",
            Render(type)
        )
    }

    @Fact
    func LocalVariable_OfNullableImportedGeneric_KeepsGSharpNullableSyntax() {
        let type = NullableTypeSymbol.Get(ImportedTypeSymbol.Get(typeof(Task[string])))
        Assert.Equal("(local variable) v System.Threading.Tasks.Task[string]?", Render(type))
    }

    @Fact
    func LocalVariable_OfSliceOfImportedGeneric_KeepsGSharpSliceSyntax() {
        let type = SliceTypeSymbol.Get(ImportedTypeSymbol.Get(typeof(Task[string])))
        Assert.Equal("(local variable) v []System.Threading.Tasks.Task[string]", Render(type))
    }

    @Fact
    func LocalVariable_OfPrimitive_RendersGSharpSpelling() {
        let type = ImportedTypeSymbol.Get(typeof(int32))
        Assert.Equal("(local variable) v int32", Render(type))
    }

    @Fact
    func LocalVariable_OfRank1ClrArray_RendersGSharpPrefixSyntax() {
        let type = ImportedTypeSymbol.Get(typeof([]int32))
        Assert.Equal("(local variable) v []int32", Render(type))
    }

    @Fact
    func LocalVariable_OfRank2ClrArray_RendersGSharpPrefixSyntax() {
        let type = ImportedTypeSymbol.Get(typeof([,]int32))
        Assert.Equal("(local variable) v [,]int32", Render(type))
    }

    shared {
        private func Render(type TypeSymbol) string {
            let local = LocalVariableSymbol("v", isReadOnly: true, type)
            return SymbolDisplay.ToDisplayString(local, SymbolDisplayFormat.Hover)
        }
    }
}
