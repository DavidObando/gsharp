// <copyright file="Issue1007GenericInterfaceMethodParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #1007: a generic method declared inside an interface body — e.g.
/// `func IsPrim[T]() bool;` — failed to parse with GS0005 ("unexpected
/// token `[`, expected `(`"), even though generic methods parse fine
/// on classes and as free functions. The interface-member method parser now
/// reuses the same optional type-parameter-list parsing the class / free
/// function path uses. These tests pin the parser-level shape: the
/// type-parameter list is captured on
/// (cref:FunctionDeclarationSyntax.TypeParameterList) with no
/// diagnostics.
open class Issue1007GenericInterfaceMethodParserTests {
    @Fact
    func GenericInterfaceMethod_SingleTypeParameter_ParsesWithoutDiagnostics() {
        const source = "package t\ninterface A { func IsPrim[T]() bool; }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let method = tree.Root.Members.OfType[InterfaceDeclarationSyntax]().Single().Methods.Single()
        Assert.True(method.IsGeneric)
        Assert.NotNull(method.TypeParameterList)
        Assert.Equal(1, method.TypeParameterList!!.Parameters.Count)
        Assert.Equal("T", method.TypeParameterList!!.Parameters[0].Identifier.Text)
    }

    @Fact
    func GenericInterfaceMethod_MultipleTypeParameters_ParsesWithoutDiagnostics() {
        const source = "package t\ninterface A { func Pair[T, U](a T, b U) U; }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let method = tree.Root.Members.OfType[InterfaceDeclarationSyntax]().Single().Methods.Single()
        Assert.True(method.IsGeneric)
        Assert.Equal(2, method.TypeParameterList!!.Parameters.Count)
        Assert.Equal("T", method.TypeParameterList!!.Parameters[0].Identifier.Text)
        Assert.Equal("U", method.TypeParameterList!!.Parameters[1].Identifier.Text)
    }

    @Fact
    func NonGenericInterfaceMethod_HasNoTypeParameterList() {
        const source = "package t\ninterface A { func F() int32; }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let method = tree.Root.Members.OfType[InterfaceDeclarationSyntax]().Single().Methods.Single()
        Assert.False(method.IsGeneric)
        Assert.Null(method.TypeParameterList)
    }
}
