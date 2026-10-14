// <copyright file="FieldDeclarationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0067 / issue #694: parser tests for the `var`/`let` requirement on
/// field declarations inside type bodies.
open class FieldDeclarationParserTests {
    @Fact
    func ParsesVarField() {
        const source = `package P
class Counter {
  var Value int32
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let field = Assert.Single(structDecl.Fields)
        Assert.Equal("Value", field.Identifier.Text)
        Assert.False(field.IsReadOnly)
        Assert.NotNull(field.VarOrLetKeyword)
        Assert.Equal(SyntaxKind.VarKeyword, field.VarOrLetKeyword!!.Kind)
    }

    @Fact
    func ParsesVarField_WithInitializer() {
        const source = `package P
class Counter {
  var Value int32 = 0
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let field = Assert.Single(structDecl.Fields)
        Assert.False(field.IsReadOnly)
        Assert.NotNull(field.Initializer)
    }

    @Fact
    func ParsesLetField() {
        const source = `package P
class Counter {
  let Name string
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let field = Assert.Single(structDecl.Fields)
        Assert.Equal("Name", field.Identifier.Text)
        Assert.True(field.IsReadOnly)
        Assert.Equal(SyntaxKind.LetKeyword, field.VarOrLetKeyword!!.Kind)
    }

    @Fact
    func ParsesLetField_WithInitializer() {
        const source = `package P
class Counter {
  let Name string = "x"
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let field = Assert.Single(structDecl.Fields)
        Assert.True(field.IsReadOnly)
        Assert.NotNull(field.Initializer)
    }

    @Fact
    func ParsesVarField_WithAccessibility() {
        const source = `package P
class Counter {
  public var Value int32
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let field = Assert.Single(structDecl.Fields)
        Assert.NotNull(field.AccessibilityModifier)
        Assert.Equal("public", field.AccessibilityModifier!!.Text)
        Assert.False(field.IsReadOnly)
    }

    @Fact
    func BareField_ReportsGS0288() {
        const source = `package P
class Counter {
  Value int32
}
`
        let tree = SyntaxTree.Parse(source)
        let diagnostic = Assert.Single(tree.Diagnostics)
        Assert.Equal("GS0288", diagnostic.Id)
        Assert.Contains("var", diagnostic.Message)
        Assert.Contains("let", diagnostic.Message)
    }

    @Fact
    func BareField_WithAccessibility_ReportsGS0288() {
        const source = `package P
class Counter {
  public Value int32
}
`
        let tree = SyntaxTree.Parse(source)
        let diagnostic = Assert.Single(tree.Diagnostics)
        Assert.Equal("GS0288", diagnostic.Id)
    }

    @Fact
    func ParsesMixedVarAndLetFields() {
        const source = `package P
class Counter {
  var Mutable int32
  let Constant string = "x"
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.Equal(2, structDecl.Fields.Length)
        Assert.False(structDecl.Fields[0].IsReadOnly)
        Assert.True(structDecl.Fields[1].IsReadOnly)
    }

    @Fact
    func ParsesVarField_InStruct() {
        const source = `package P
struct Point {
  var X int32
  var Y int32
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.Equal(2, structDecl.Fields.Length)
    }

    @Fact
    func ParsesVarField_InSharedBlock() {
        const source = `package P
class Counter {
  shared {
    var Instances int32 = 0
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesConstField_WithInitializer() {
        // Issue #948: `const` fields are accepted in a type body and carry an
        // initializer; they are implicitly read-only.
        const source = `package P
class Counter {
  const Max int32 = 10
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let field = Assert.Single(structDecl.Fields)
        Assert.Equal("Max", field.Identifier.Text)
        Assert.True(field.IsConst)
        Assert.True(field.IsReadOnly)
        Assert.NotNull(field.Initializer)
        Assert.Equal(SyntaxKind.ConstKeyword, field.VarOrLetKeyword!!.Kind)
    }

    @Fact
    func ParsesConstField_InSharedBlock() {
        const source = `package P
class Counter {
  shared {
    const Max int32 = 10
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func BareField_GS0288_MentionsConst() {
        // Issue #948: the GS0288 guidance now also mentions `const`.
        const source = `package P
class Counter {
  Value int32
}
`
        let tree = SyntaxTree.Parse(source)
        let diagnostic = Assert.Single(tree.Diagnostics)
        Assert.Equal("GS0288", diagnostic.Id)
        Assert.Contains("const", diagnostic.Message)
    }
}
