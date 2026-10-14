// <copyright file="Issue1202UnsafeClassModifierParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0122 / issue #1202: the `unsafe` class modifier must compose with
/// the other aggregate modifiers (`open`/`sealed`/visibility) in any
/// order. Previously only a SOLE leading `unsafe class` parsed; combining
/// it with `open` tripped the statement parser (GS0285/GS0125) and
/// aborted the declaration. These tests pin that `unsafe` is a first-class
/// member of the class modifier set.
open class Issue1202UnsafeClassModifierParserTests {
    @Fact
    func UnsafeOpenClass_Parses_WithoutDiagnostics() {
        const source = `package p
unsafe open class C { private var pBuffer *void }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func OpenUnsafeClass_Parses_WithoutDiagnostics() {
        const source = `package p
open unsafe class C { private var pBuffer *void }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func UnsafeClass_SoleModifier_StillParses() {
        const source = `package p
unsafe class C { private var pBuffer *void }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Theory
    @InlineData(`package p
unsafe open class C { }
`)
    @InlineData(`package p
open unsafe class C { }
`)
    @InlineData(`package p
public unsafe open class C { }
`)
    @InlineData(`package p
unsafe sealed class C { }
`)
    @InlineData(`package p
sealed unsafe class C { }
`)
    func UnsafeComposesWithClassModifiers_MarksNodeUnsafe(source string) {
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let root = cast[CompilationUnitSyntax](tree.Root)
        let classDecl = root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.True(classDecl.IsUnsafe)
    }

    @Fact
    func UnsafeOnInterface_ReportsDiagnostic() {
        // `unsafe` is only valid on a class/struct head, not an interface.
        const source = `package p
unsafe interface I { }
`
        let tree = SyntaxTree.Parse(source)
        Assert.NotEmpty(tree.Diagnostics)
    }
}
