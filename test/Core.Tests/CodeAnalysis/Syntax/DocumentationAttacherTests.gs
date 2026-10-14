// <copyright file="DocumentationAttacherTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import Xunit

/// ADR-0057 §7: Tests the position-based attachment of doc blocks to declarations.
open class DocumentationAttacherTests {
    @Fact
    func DocAttaches_ToImmediatelyFollowingFunction() {
        let source = "/// Adds two numbers.\nfunc Add(a int32, b int32) int32 { return a + b }"
        let tree = SyntaxTree.Parse(source)
        let funcDecl = tree.Root.Members[0]
        let doc string? = tree.GetDocumentation(funcDecl)
        Assert.Equal("Adds two numbers.", doc)
    }

    @Fact
    func MultiLineDoc_ConcatenatesLines() {
        let source = `/// Line one.
/// Line two.
func Foo() {}`
        let tree = SyntaxTree.Parse(source)
        let funcDecl = tree.Root.Members[0]
        let doc string? = tree.GetDocumentation(funcDecl)
        Assert.Contains("Line one.", doc)
        Assert.Contains("Line two.", doc)
    }

    @Fact
    func GapBetweenDocAndDeclaration_NoAttachment() {
        // A blank line between doc and declaration breaks attachment
        let source = `/// Orphan doc.

func Foo() {}`
        let tree = SyntaxTree.Parse(source)
        let funcDecl = tree.Root.Members[0]
        let doc string? = tree.GetDocumentation(funcDecl)
        Assert.Null(doc)
    }

    @Fact
    func NoDocComment_ReturnsNull() {
        let source = "func Bar() {}"
        let tree = SyntaxTree.Parse(source)
        let funcDecl = tree.Root.Members[0]
        let doc string? = tree.GetDocumentation(funcDecl)
        Assert.Null(doc)
    }

    @Fact
    func RegularComment_DoesNotAttach() {
        let source = "// Not a doc comment\nfunc Baz() {}"
        let tree = SyntaxTree.Parse(source)
        let funcDecl = tree.Root.Members[0]
        let doc string? = tree.GetDocumentation(funcDecl)
        Assert.Null(doc)
    }

    @Fact
    func MultipleFunctions_EachGetsOwnDoc() {
        let source = `/// Doc for A.
func A() {}
/// Doc for B.
func B() {}`
        let tree = SyntaxTree.Parse(source)
        let a = tree.Root.Members[0]
        let b = tree.Root.Members[1]
        Assert.Equal("Doc for A.", tree.GetDocumentation(a))
        Assert.Equal("Doc for B.", tree.GetDocumentation(b))
    }

    @Fact
    func DocOnEnum_Attaches() {
        let source = "/// My enum.\nenum Color { Red, Green, Blue }"
        let tree = SyntaxTree.Parse(source)
        let enumDecl = tree.Root.Members[0]
        let doc string? = tree.GetDocumentation(enumDecl)
        Assert.Equal("My enum.", doc)
    }
}
