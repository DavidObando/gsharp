// <copyright file="DelegateDeclarationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0059 / issue #255: parser tests for named delegate type declarations.
open class DelegateDeclarationParserTests {
    @Fact
    func ParsesVoidDelegate() {
        const source = `package P
delegate Greeter(name string);
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let decl = Assert.IsType[DelegateDeclarationSyntax](
            tree.Root.Members.First((m MemberSyntax) -> m is DelegateDeclarationSyntax)
        )
        Assert.Equal("Greeter", decl.Identifier.Text)
        Assert.Single(decl.Parameters)
        Assert.Null(decl.ReturnType)
    }

    @Fact
    func ParsesValueReturningDelegate() {
        const source = `package P
delegate Combine(a int32, b int32) int32;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let decl = Assert.IsType[DelegateDeclarationSyntax](
            tree.Root.Members.First((m MemberSyntax) -> m is DelegateDeclarationSyntax)
        )
        Assert.Equal("Combine", decl.Identifier.Text)
        Assert.Equal(2, decl.Parameters.Count)
        Assert.NotNull(decl.ReturnType)
    }

    @Fact
    func Reports_GS0233_WhenFuncKeywordMissing() {
        const source = `package P
type Bad = delegate int32
`
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0233")
    }
}
