// <copyright file="Adr0144PartialTypeParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0144 / issue #2201: the `partial` contextual modifier joins the
/// existing contextual-identifier modifier family (`data`/`inline`/
/// `ref`/`unsafe`). It requires no lexer change and no new SyntaxKind,
/// and is only special inside an aggregate declaration head. It is valid on
/// `class`, `struct`, and `interface`, and rejected on
/// `enum` (GS0484). These tests pin the SYNTAX layer only.
open class Adr0144PartialTypeParserTests {
    @Fact
    func PartialClass_Parses_WithIsPartialSet() {
        const source = `package p
partial class C { }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let root = cast[CompilationUnitSyntax](tree.Root)
        let classDecl = root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.True(classDecl.IsPartial)
    }

    @Fact
    func PartialStruct_Parses_WithIsPartialSet() {
        const source = `package p
partial struct S { }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let root = cast[CompilationUnitSyntax](tree.Root)
        let structDecl = root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.True(structDecl.IsPartial)
    }

    @Fact
    func PartialInterface_Parses_WithIsPartialSet() {
        const source = `package p
partial interface I { }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let root = cast[CompilationUnitSyntax](tree.Root)
        let interfaceDecl = root.Members.OfType[InterfaceDeclarationSyntax]().Single()
        Assert.True(interfaceDecl.IsPartial)
    }

    @Theory
    @InlineData(`package p
public open partial class C { }
`)
    @InlineData(`package p
partial open class C { }
`)
    @InlineData(`package p
open partial class C { }
`)
    func PartialComposesWithClassModifiers_InAnyOrder(source string) {
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let root = cast[CompilationUnitSyntax](tree.Root)
        let classDecl = root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.True(classDecl.IsPartial)
        Assert.True(classDecl.IsOpen)
    }

    @Fact
    func PartialComposesWithData_OnStruct() {
        const source = `package p
public partial data struct S { }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let root = cast[CompilationUnitSyntax](tree.Root)
        let structDecl = root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.True(structDecl.IsPartial)
        Assert.True(structDecl.IsData)
    }

    @Fact
    func NonPartialClass_HasIsPartialFalse() {
        const source = `package p
class C { }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let root = cast[CompilationUnitSyntax](tree.Root)
        let classDecl = root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.False(classDecl.IsPartial)
    }

    @Fact
    func PartialEnum_ReportsGS0484() {
        const source = `package p
partial enum E { A }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0484")
    }

    @Fact
    func DuplicatePartial_RecoversLikeSiblingContextualModifiers() {
        // `partial` is a contextual identifier modifier, so it behaves exactly
        // like the sibling `data`/`inline`/`ref`/`unsafe` modifiers on a
        // duplicate. TryDetectAggregateDeclarationHead's `saw` HashSet bails on
        // the second occurrence, so the leading `partial` is swallowed as an
        // expression statement and the trailing `partial class C { }` still
        // parses as a valid partial class — no crash, no cascade. (Cf.
        // `data data struct S { }`, which recovers identically.)
        const source = `package p
partial partial class C { }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let root = cast[CompilationUnitSyntax](tree.Root)
        let classDecl = root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.True(classDecl.IsPartial)
    }

    @Fact
    func Partial_RemainsUsableAsAnOrdinaryIdentifier() {
        // `partial` is contextual: it is only special inside an aggregate
        // declaration head where a trailing kind keyword disambiguates. A local
        // named `partial` must still parse cleanly.
        const source = `package p
import System
var partial = 3
Console.WriteLine(partial)
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }
}
