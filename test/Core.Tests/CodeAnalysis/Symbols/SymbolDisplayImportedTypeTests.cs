// <copyright file="SymbolDisplayImportedTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Hover/type display for symbols typed as imported CLR types. A constructed
/// generic such as <c>Task[string]</c> must render with its friendly G# name
/// rather than the raw assembly-qualified <see cref="System.Type.FullName"/>
/// that <see cref="TypeSymbol.Name"/> carries for closed generics.
/// </summary>
public class SymbolDisplayImportedTypeTests
{
    private static string Render(TypeSymbol type)
    {
        var local = new LocalVariableSymbol("v", isReadOnly: true, type);
        return SymbolDisplay.ToDisplayString(local, SymbolDisplayFormat.Hover);
    }

    [Fact]
    public void LocalVariable_OfConstructedGenericTask_RendersFriendlyName()
    {
        var type = ImportedTypeSymbol.Get(typeof(Task<string>));

        Assert.Equal("(local variable) v System.Threading.Tasks.Task[string]", Render(type));
    }

    [Fact]
    public void LocalVariable_OfNonGenericImportedType_RendersQualifiedName()
    {
        var type = ImportedTypeSymbol.Get(typeof(System.Diagnostics.Process));

        Assert.Equal("(local variable) v System.Diagnostics.Process", Render(type));
    }

    [Fact]
    public void LocalVariable_OfNestedGeneric_RendersFriendlyArguments()
    {
        var type = ImportedTypeSymbol.Get(typeof(Dictionary<string, List<int>>));

        Assert.Equal(
            "(local variable) v System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[int32]]",
            Render(type));
    }

    [Fact]
    public void LocalVariable_OfNullableImportedGeneric_KeepsGSharpNullableSyntax()
    {
        var type = NullableTypeSymbol.Get(ImportedTypeSymbol.Get(typeof(Task<string>)));

        Assert.Equal("(local variable) v System.Threading.Tasks.Task[string]?", Render(type));
    }

    [Fact]
    public void LocalVariable_OfSliceOfImportedGeneric_KeepsGSharpSliceSyntax()
    {
        var type = SliceTypeSymbol.Get(ImportedTypeSymbol.Get(typeof(Task<string>)));

        Assert.Equal("(local variable) v []System.Threading.Tasks.Task[string]", Render(type));
    }

    [Fact]
    public void LocalVariable_OfPrimitive_RendersGSharpSpelling()
    {
        var type = ImportedTypeSymbol.Get(typeof(int));

        Assert.Equal("(local variable) v int32", Render(type));
    }
}
