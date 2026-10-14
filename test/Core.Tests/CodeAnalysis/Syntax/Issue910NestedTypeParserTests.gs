// <copyright file="Issue910NestedTypeParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #910 / ADR-0110: parser-level tests for nested type declarations
/// (`class` / `struct` / `interface` / `enum`) declared
/// inside a `class` or `struct` body. Before this change the
/// aggregate-member grammar had no production for nested types, so each one
/// was misparsed as a malformed field and produced a misleading error cascade.
open class Issue910NestedTypeParserTests {
    @Fact
    func NestedClassInClass_ParsesWithoutDiagnostics() {
        const source = `package P
class Outer {
    class Inner {
        func Hello() string {
            return "hi"
        }
    }

    func Make() string {
        let i = Inner()
        return i.Hello()
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let nested = Assert.Single(outer.NestedTypes)
        let inner = Assert.IsType[StructDeclarationSyntax](nested)
        Assert.True(inner.IsClass)
        Assert.Equal("Inner", inner.Identifier.Text)
    }

    @Fact
    func NestedStructInStruct_ParsesWithoutDiagnostics() {
        const source = `package P
struct Outer {
    struct Inner {
        var X int32 = 0
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let nested = Assert.Single(outer.NestedTypes)
        let inner = Assert.IsType[StructDeclarationSyntax](nested)
        Assert.False(inner.IsClass)
        Assert.Equal("Inner", inner.Identifier.Text)
    }

    @Fact
    func NestedStructInClass_ParsesWithoutDiagnostics() {
        const source = `package P
class Outer {
    struct Inner {
        var X int32 = 0
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let inner = Assert.IsType[StructDeclarationSyntax](Assert.Single(outer.NestedTypes))
        Assert.False(inner.IsClass)
    }

    @Fact
    func NestedClassInStruct_ParsesWithoutDiagnostics() {
        const source = `package P
struct Outer {
    class Inner {
        func Hello() string {
            return "hi"
        }
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let inner = Assert.IsType[StructDeclarationSyntax](Assert.Single(outer.NestedTypes))
        Assert.True(inner.IsClass)
    }

    @Fact
    func NestedInterfaceInClass_ParsesWithoutDiagnostics() {
        const source = `package P
class Outer {
    interface IInner {
        func Hello() string;
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let inner = Assert.IsType[InterfaceDeclarationSyntax](Assert.Single(outer.NestedTypes))
        Assert.Equal("IInner", inner.Identifier.Text)
    }

    @Fact
    func NestedEnumInClass_ParsesWithoutDiagnostics() {
        const source = `package P
class Outer {
    enum Color {
        Red,
        Green,
        Blue,
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let inner = Assert.IsType[EnumDeclarationSyntax](Assert.Single(outer.NestedTypes))
        Assert.Equal("Color", inner.Identifier.Text)
    }

    @Fact
    func NestedEnumInStruct_ParsesWithoutDiagnostics() {
        const source = `package P
struct Outer {
    enum Color {
        Red,
        Green,
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.IsType[EnumDeclarationSyntax](Assert.Single(outer.NestedTypes))
    }

    @Fact
    func RecursivelyNestedTypes_Parse() {
        const source = `package P
class Outer {
    class Middle {
        class Inner {
            func N() int32 {
                return 7
            }
        }
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let middle = Assert.IsType[StructDeclarationSyntax](Assert.Single(outer.NestedTypes))
        let inner = Assert.IsType[StructDeclarationSyntax](Assert.Single(middle.NestedTypes))
        Assert.Equal("Inner", inner.Identifier.Text)
    }

    @Fact
    func NestedTypeWithAccessibilityModifier_Parses() {
        const source = `package P
class Outer {
    private class Inner {
        var X int32 = 0
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let inner = Assert.IsType[StructDeclarationSyntax](Assert.Single(outer.NestedTypes))
        Assert.NotNull(inner.AccessibilityModifier)
        Assert.Equal(SyntaxKind.PrivateKeyword, inner.AccessibilityModifier!!.Kind)
    }

    @Fact
    func EnclosingTypeMembersStillParse_AlongsideNestedType() {
        const source = `package P
class Outer {
    var Count int32 = 0

    class Inner {
        var X int32 = 0
    }

    func Bump() int32 {
        return Count
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.Single(outer.NestedTypes)
        Assert.Single(outer.Fields)
        Assert.Single(outer.Methods)
    }
}
