// <copyright file="EventParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0052: parser tests for event declaration syntax.
open class EventParserTests {
    @Fact
    func ParsesFieldLikeEvent() {
        const source = `package P
import System
class Foo {
  event Click (Object, EventArgs) -> void
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesFieldLikeEvent_WithAccessibility() {
        const source = `package P
import System
class Foo {
  public event Click (Object, EventArgs) -> void
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesEvent_WithExplicitAccessors() {
        const source = `package P
import System
class Foo {
  event Changed () -> void {
    add { }
    remove { }
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesEvent_OnInterface() {
        const source = `package P
interface INotify {
  event Changed () -> void
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesEvent_WithOpenModifier() {
        const source = `package P
open class Base {
  public open event Notify () -> void
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesMultipleEvents() {
        const source = `package P
class Foo {
  event A () -> void
  event B (int32) -> void
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func EventDeclaration_HasCorrectSyntaxKind() {
        const source = `package P
class Foo {
  event Click () -> void
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.Single(structDecl.Events)
        Assert.Equal(SyntaxKind.EventDeclaration, structDecl.Events[0].Kind)
        Assert.Equal("Click", structDecl.Events[0].Identifier.Text)
    }

    @Fact
    func ParsesEvent_WithRaiseAccessor() {
        const source = `package P
class Foo {
  event Changed () -> void {
    add { }
    remove { }
    raise { }
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let ev = structDecl.Events[0]
        Assert.Equal(3, ev.Accessors.Length)
        Assert.True(ev.Accessors[2].IsRaise)
    }

    @Fact
    func ParsesEvent_RaiseAccessorOnly_WithAddRemove() {
        const source = `package P
class Foo {
  event Notify (int32) -> void {
    add { }
    remove { }
    raise { }
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let ev = structDecl.Events[0]
        Assert.Single(ev.Accessors.Where((a EventAccessorSyntax) -> a.IsAdd))
        Assert.Single(ev.Accessors.Where((a EventAccessorSyntax) -> a.IsRemove))
        Assert.Single(ev.Accessors.Where((a EventAccessorSyntax) -> a.IsRaise))
    }
}
