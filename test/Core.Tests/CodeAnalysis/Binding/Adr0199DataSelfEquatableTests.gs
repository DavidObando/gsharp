// <copyright file="Adr0199DataSelfEquatableTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0199: every data type implements `IEquatable[Self]`, added once. A
/// declared `IEquatable[Self]` is the same interface; a closed
/// `IEquatable[Item[int32]]` on a generic type is a different one.
open class Adr0199DataSelfEquatableTests {
    @Fact
    func ImplicitSelfEquatable_IsAddedOnce_AndOnlyForTheTypesOwnConstruction() {
        let compilation = Compilation(SyntaxTree.Parse(`import System
data class Plain(X int32)
data class Declared(X int32) : IEquatable[Declared]
data class OpenGeneric[T](Value T) : IEquatable[OpenGeneric[T]]
data class ClosedGeneric[T](Value T) : IEquatable[ClosedGeneric[int32]]
data class Annotated(X int32) : IEquatable[Annotated?]
class Outer[T] {
    data class Nested(X int32) : IEquatable[Outer[int32].Nested]
    data class SelfNested(X int32) : IEquatable[Outer[T].SelfNested]
}`)){IsLibrary = true}
        let structs = compilation.GlobalScope.Structs
        let Count = func (name string) int32 {
            return structs.Single((s StructSymbol) -> s.Name == name).ImplementedClrInterfaces.Length
        }
        Assert.Equal(1, Count("Plain"))
        Assert.Equal(1, Count("Declared"))
        Assert.Equal(1, Count("OpenGeneric"))
        // Reference nullability is metadata only: IEquatable[Annotated?] is IEquatable[Annotated].
        Assert.Equal(1, Count("Annotated"))
        // The declared interface is closed over int32, so the type's own
        // IEquatable[ClosedGeneric[T]] is still implied next to it.
        Assert.Equal(2, Count("ClosedGeneric"))
        // The enclosing construction counts too: Outer[int32].Nested is not Outer[T].Nested.
        Assert.Equal(2, Count("Nested"))
        Assert.Equal(1, Count("SelfNested"))
    }
}
