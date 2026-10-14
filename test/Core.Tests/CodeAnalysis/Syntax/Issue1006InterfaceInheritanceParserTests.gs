// <copyright file="Issue1006InterfaceInheritanceParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #1006: an `interface` may declare one or more base interfaces via
/// a `: A, B` clause directly after the identifier, mirroring
/// `interface B : A` in C#. Before this change the parser rejected the
/// colon with GS0005 (unexpected token, expected `{`). These tests pin the
/// parser-level shape: the base-interface clause is captured on
/// (cref:InterfaceDeclarationSyntax.BaseTypeClauses) with no diagnostics.
open class Issue1006InterfaceInheritanceParserTests {
    @Fact
    func InterfaceSingleBase_ParsesWithoutDiagnostics() {
        const source = `package t
interface A { func F() int32; }
interface B : A { func G() int32; }`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let b = tree
            .Root
            .Members
            .OfType[InterfaceDeclarationSyntax]()
            .Single((i InterfaceDeclarationSyntax) -> i.Identifier.Text == "B")
        Assert.True(b.HasBaseInterfaces)
        Assert.Equal(1, b.BaseTypeClauses.Count)
        Assert.Equal("A", b.BaseTypeClauses[0].Identifier!!.Text)
    }

    @Fact
    func InterfaceMultipleBases_ParsesWithoutDiagnostics() {
        const source = `package t
interface A { func F() int32; }
interface C { func H() int32; }
interface B : A, C { func G() int32; }`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let b = tree
            .Root
            .Members
            .OfType[InterfaceDeclarationSyntax]()
            .Single((i InterfaceDeclarationSyntax) -> i.Identifier.Text == "B")
        Assert.True(b.HasBaseInterfaces)
        Assert.Equal(2, b.BaseTypeClauses.Count)
        Assert.Equal("A", b.BaseTypeClauses[0].Identifier!!.Text)
        Assert.Equal("C", b.BaseTypeClauses[1].Identifier!!.Text)
    }

    @Fact
    func InterfaceWithoutBase_HasNoBaseClause() {
        const source = "package t\ninterface A { func F() int32; }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let a = tree.Root.Members.OfType[InterfaceDeclarationSyntax]().Single()
        Assert.False(a.HasBaseInterfaces)
        Assert.Equal(0, a.BaseTypeClauses.Count)
    }
}
