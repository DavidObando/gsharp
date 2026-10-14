// <copyright file="PropertyParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0051 Phase 8: parser tests for property declaration syntax.
/// Validates that various property forms are accepted without diagnostics.
open class PropertyParserTests {
    @Theory
    @InlineData("abstract", false)
    @InlineData("abstract override", true)
    @InlineData("override abstract", true)
    func ExplicitAbstractProperty_PreservesModifierChildrenAndAccessorShape(modifiers string, overrides bool) {
        let tree = SyntaxTree.Parse((`package P
abstract class Owner { public ` + "$modifiers" + ` prop $package int32 { get; protected init; } }`))
        Assert.Empty(tree.Diagnostics)
        let property = Assert.Single(Assert.Single(tree.Root.Members.OfType[StructDeclarationSyntax]()).Properties)
        Assert.Equal("abstract", property.AbstractModifier?.Text)
        Assert.Equal(overrides, property.OverrideModifier != nil)
        Assert.Null(property.OpenModifier)
        Assert.Equal("package", property.Identifier.ValueText)
        Assert.Equal(2, property.Accessors.Length)
        Assert.Contains(property.AbstractModifier!!, property.GetChildren())
        Assert.All(property.Accessors, (accessor PropertyAccessorSyntax) -> Assert.Null(accessor.Body))
        Assert.True(property.Accessors[1].IsInit)
        Assert.Equal(SyntaxKind.ProtectedKeyword, property.Accessors[1].AccessibilityModifier?.Kind)
    }

    @Fact
    func ParsesAutoProperty() {
        const source = `package P
class Foo {
  prop Name string
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesReadOnlyAutoProperty() {
        const source = `package P
class Foo {
  prop X int32 { get }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesFullProperty_WithGetAndSetBodies() {
        const source = `package P
class Foo {
  prop X int32 { get { return 0 } set(v) { } }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesInterfaceProperty() {
        const source = `package P
interface Named {
  prop Name string { get }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesPropertyWithPrivateAccessibility() {
        const source = `package P
class Foo {
  private prop secret int32
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesOpenProperty() {
        const source = `package P
open class Foo {
  open prop X int32
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesOverrideProperty() {
        const source = `package P
open class Base {
  open prop X int32
}
class D : Base {
  override prop X int32
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesMultipleProperties() {
        const source = `package P
class Person {
  prop Name string
  prop Age int32
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesPropertyWithGetAndSet_NoBody() {
        const source = `package P
class Foo {
  prop X int32 { get; set; }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesPropertyOnInterface_GetAndSet() {
        const source = `package P
interface Mutable {
  prop Value int32 { get set }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func AutoPropertyInDataStruct_Parses() {
        const source = `package P
data struct P {
  var X int32
  prop Y int32
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func PropertyDeclaration_HasCorrectSyntaxKind() {
        const source = `package P
class Foo {
  prop Name string
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.Single(structDecl.Properties)
        Assert.Equal(SyntaxKind.PropertyDeclaration, structDecl.Properties[0].Kind)
        Assert.Equal("Name", structDecl.Properties[0].Identifier.Text)
    }

    @Fact
    func ReadOnlyProperty_HasGetAccessor() {
        const source = `package P
class Foo {
  prop X int32 { get }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let propDecl = structDecl.Properties.Single()
        Assert.Single(propDecl.Accessors)
        Assert.True(propDecl.Accessors[0].IsGetter)
    }

    @Fact
    func ParsesGetOnlyIndexerDeclaration() {
        // ADR-0118 / issue #944: `prop this[i int32] T { get {...} }`.
        const source = `package P
class Repo {
  prop this[index int32] int32 { get { return 0 } }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ParsesGetSetIndexerDeclaration() {
        const source = `package P
class Repo {
  prop this[index int32] int32 { get { return 0 } set { } }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func IndexerDeclaration_IsMarkedAsIndexer() {
        const source = `package P
class Repo {
  prop this[index int32] int32 { get { return 0 } }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let propDecl = structDecl.Properties.Single()
        Assert.True(propDecl.IsIndexer)
        Assert.Single(propDecl.Parameters)
        Assert.Equal("index", propDecl.Parameters[0].Identifier!!.Text)
    }

    @Fact
    func IndexerDeclaration_OnGenericClass_Parses() {
        const source = `package P
class Repo[T] {
  prop this[index int32] T { get { return _items[index] } }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.True(structDecl.Properties.Single().IsIndexer)
    }

    @Fact
    func NonIndexerProperty_IsNotMarkedAsIndexer() {
        const source = `package P
class Foo {
  prop Name string
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let propDecl = structDecl.Properties.Single()
        Assert.False(propDecl.IsIndexer)
        Assert.Empty(propDecl.Parameters)
    }

    @Fact
    func ParsesAutoInitProperty() {
        // Issue #946: `{ get; init; }` bodyless init accessor.
        const source = `package P
class Foo {
  prop Name string { get; init; }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let propDecl = structDecl.Properties.Single()
        Assert.Equal(2, propDecl.Accessors.Length)
        Assert.True(propDecl.Accessors[0].IsGetter)
        Assert.True(propDecl.Accessors[1].IsInit)
        Assert.True(propDecl.Accessors[1].IsSetterOrInit)
        Assert.False(propDecl.Accessors[1].IsSetter)
    }

    @Fact
    func ParsesInitProperty_WithBody() {
        // Issue #946: `init { ... }` accessor with a block body.
        const source = `package P
class Foo {
  var raw int32
  prop X int32 { get { return raw } init { raw = value } }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let propDecl = structDecl.Properties.Single()
        let initAccessor = propDecl.Accessors.Single((a PropertyAccessorSyntax) -> a.IsInit)
        Assert.NotNull(initAccessor.Body)
    }

    @Fact
    func ParsesInitProperty_WithExplicitParameterName() {
        // Issue #946: `init(v) { ... }` mirrors `set(v) { ... }`.
        const source = `package P
class Foo {
  var raw int32
  prop X int32 { get { return raw } init(v) { raw = v } }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let propDecl = structDecl.Properties.Single()
        let initAccessor = propDecl.Accessors.Single((a PropertyAccessorSyntax) -> a.IsInit)
        Assert.Equal("v", initAccessor.ParameterIdentifier!!.Text)
    }

    @Fact
    func InitConstructor_NotConfusedWithInitAccessor() {
        // Issue #946: `init(...)` at member level is still a constructor, not a
        // property accessor; both coexist in one class.
        const source = `package P
class Foo {
  prop Name string { get; init; }
  init(name string) {
    this.Name = name
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.Single(structDecl.Constructors)
        let propDecl = structDecl.Properties.Single()
        Assert.True(propDecl.Accessors.Single((a PropertyAccessorSyntax) -> a.IsInit).IsInit)
    }

    @Fact
    func FatArrowGetter_ReportsDiagnostic() {
        // Issue #1273: G# has no fat-arrow `=>` expression-bodied accessor (that
        // is C# syntax). `get => e` must be a syntax error, not silently
        // accepted or desugared.
        const source = `package P
class Foo {
  prop X int32 { get => 5 }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0005")
    }

    @Fact
    func ArrowGetter_ParsesCleanly() {
        // Issue #1278 / ADR-0131: the G# lambda arrow `->` is now a valid
        // accessor expression-body form: `get -> e` desugars to `{ return e }`.
        const source = `package P
class Foo {
  prop X int32 { get -> 5 }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ArrowGetterAndSetter_ParseCleanly() {
        // Issue #1278 / ADR-0131: `get -> e` and `set -> e` are expression-bodied
        // accessors; a setter body may use the implicit `value` parameter.
        const source = `package P
class Foo {
  var n int32
  prop X int32 { get -> this.n set -> this.n = value }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func PropertyLevelArrow_ParsesCleanly() {
        // Issue #1278 / ADR-0131: `prop Name T -> expr` is an expression-bodied
        // read-only property that desugars to a single get-only accessor.
        const source = `package P
class Foo {
  var n int32
  prop Doubled int32 -> this.n * 2
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let propDecl = structDecl.Properties.Single()
        let accessor = Assert.Single(propDecl.Accessors)
        Assert.True(accessor.IsGetter)
        Assert.NotNull(accessor.Body)
    }

    @Fact
    func IndexerLevelArrow_ParsesCleanly() {
        // Issue #1278 / ADR-0131: `prop this[i T] U -> expr` is an
        // expression-bodied read-only indexer.
        const source = `package P
class Repo {
  var data []int32
  prop this[i int32] int32 -> this.data[i]
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func FatArrowSetter_ReportsDiagnostic() {
        // Issue #1273: `set => e` is rejected just like the fat-arrow getter.
        const source = `package P
class Foo {
  var n int32
  prop X int32 { get { return this.n } set => this.n = value }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0005")
    }

    @Fact
    func FatArrowGetterOnInterface_ReportsDiagnostic() {
        // Issue #1273: the rejection applies on interfaces too.
        const source = `package P
interface I {
  prop X int32 { get => 5 }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0005")
    }

    @Fact
    func BlockBodiedAndBareAccessors_ParseCleanly() {
        // Issue #1273: a block body and a bare (auto) accessor remain the only
        // valid accessor forms and parse without diagnostics.
        const source = `package P
class Foo {
  var n int32
  prop X int32 { get { return this.n } set(v) { this.n = v } }
  prop Y int32 { get; set; }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }
}
