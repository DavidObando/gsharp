// <copyright file="Issue698DeinitParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #698 / ADR-0068: parser-level tests for the Swift-style
/// `deinit { … }` destructor declaration.
open class Issue698DeinitParserTests {
    @Fact
    func ParsesBareDeinit_OnClass() {
        const source = `package P
class Resource {
    var Handle int32 = 0
    deinit {
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.NotNull(structDecl.Deinitializer)
        Assert.Equal(SyntaxKind.DeinitDeclaration, structDecl.Deinitializer!!.Kind)
        Assert.NotNull(structDecl.Deinitializer!!.Body)
        Assert.Empty(structDecl.Deinitializer!!.Body.Statements)
    }

    @Fact
    func DeinitBody_ContainsStatements() {
        const source = `package P
import System
class Resource {
    var Tag string = ""
    deinit {
        Console.WriteLine(Tag)
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.NotNull(structDecl.Deinitializer)
        Assert.Single(structDecl.Deinitializer!!.Body.Statements)
    }

    @Fact
    func DeinitOnStruct_ProducesGS0289() {
        const source = `package P
struct Point {
    var X int32 = 0
    deinit {
    }
}`
        let tree = SyntaxTree.Parse(source)
        let diags = tree.Diagnostics
        Assert.NotEmpty(diags)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0289")
    }

    @Fact
    func DuplicateDeinit_ProducesGS0290() {
        const source = `package P
class Resource {
    var Handle int32 = 0
    deinit {
    }
    deinit {
    }
}`
        let tree = SyntaxTree.Parse(source)
        let diags = tree.Diagnostics
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0290")
    }

    @Fact
    func DeinitWithParameters_ProducesGS0291() {
        const source = `package P
class Resource {
    var Handle int32 = 0
    deinit(x int32) {
    }
}`
        let tree = SyntaxTree.Parse(source)
        let diags = tree.Diagnostics
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0291")
    }

    @Fact
    func DeinitWithReturnType_ProducesGS0292() {
        const source = `package P
class Resource {
    var Handle int32 = 0
    deinit int32 {
    }
}`
        let tree = SyntaxTree.Parse(source)
        let diags = tree.Diagnostics
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0292")
    }
}
