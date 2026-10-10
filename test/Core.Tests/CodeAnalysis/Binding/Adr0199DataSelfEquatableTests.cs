// <copyright file="Adr0199DataSelfEquatableTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0199: every data type implements <c>IEquatable[Self]</c>, added once. A
/// declared <c>IEquatable[Self]</c> is the same interface; a closed
/// <c>IEquatable[Item[int32]]</c> on a generic type is a different one.
/// </summary>
public class Adr0199DataSelfEquatableTests
{
    [Fact]
    public void ImplicitSelfEquatable_IsAddedOnce_AndOnlyForTheTypesOwnConstruction()
    {
        var compilation = new Compilation(SyntaxTree.Parse("""
            import System
            data class Plain(X int32)
            data class Declared(X int32) : IEquatable[Declared]
            data class OpenGeneric[T](Value T) : IEquatable[OpenGeneric[T]]
            data class ClosedGeneric[T](Value T) : IEquatable[ClosedGeneric[int32]]
            """)) { IsLibrary = true };
        var structs = compilation.GlobalScope.Structs;
        int Count(string name) => structs.Single(s => s.Name == name).ImplementedClrInterfaces.Length;

        Assert.Equal(1, Count("Plain"));
        Assert.Equal(1, Count("Declared"));
        Assert.Equal(1, Count("OpenGeneric"));

        // The declared interface is closed over int32, so the type's own
        // IEquatable[ClosedGeneric[T]] is still implied next to it.
        Assert.Equal(2, Count("ClosedGeneric"));
    }
}
