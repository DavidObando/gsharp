// <copyright file="EnumDeclarationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Linq
import Xunit

/// Phase 6.8 parser coverage for `enum Name { ... }` declarations.
open class EnumDeclarationParserTests {
    @Fact
    func EnumDeclaration_ParsesMembers() {
        let tree = SyntaxTree.Parse("enum Color { Red, Green, Blue }")
        Assert.Empty(tree.Diagnostics)
        let declaration = tree.Root.Members.OfType[EnumDeclarationSyntax]().Single()
        Assert.Equal("Color", declaration.Identifier.Text)
        Assert.Equal(3, declaration.Members.Count)
        Assert.Equal("Red", declaration.Members[0].Identifier.Text)
        Assert.Equal("Green", declaration.Members[1].Identifier.Text)
        Assert.Equal("Blue", declaration.Members[2].Identifier.Text)
    }

    @Fact
    func EnumDeclaration_AllowsTrailingComma() {
        let tree = SyntaxTree.Parse("enum Color { Red, Green, Blue, }")
        Assert.Empty(tree.Diagnostics)
        let declaration = tree.Root.Members.OfType[EnumDeclarationSyntax]().Single()
        Assert.Equal(3, declaration.Members.Count)
    }

    @Fact
    func EnumDeclaration_EmptyBody_Diagnoses() {
        let tree = SyntaxTree.Parse("enum Color { }")
        Assert.Contains(
            tree.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("must declare at least one member", StringComparison.Ordinal)
        )
    }

    @Theory
    @InlineData("data")
    @InlineData("open")
    @InlineData("sealed")
    func EnumDeclaration_IllegalModifiers_Diagnose(modifier string) {
        let tree = SyntaxTree.Parse("type Color $modifier enum { Red }")
        Assert.NotEmpty(tree.Diagnostics)
    }
}
