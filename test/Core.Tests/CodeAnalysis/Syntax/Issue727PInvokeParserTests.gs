// <copyright file="Issue727PInvokeParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Parser-level coverage for ADR-0086 / issue #727 P/Invoke surface syntax:
/// a function whose body is a single `;` token (no managed body) is
/// accepted by the parser without diagnostics, and its
/// (cref:FunctionDeclarationSyntax.HasSemicolonBody) flag is set.
/// Validation of the matching `@DllImport` annotation happens in the
/// binder; the parser intentionally stays permissive so the binder can
/// produce more specific diagnostics.
open class Issue727PInvokeParserTests {
    @Fact
    func Function_With_Semicolon_Body_Parses_Without_Diagnostics() {
        const source = `
package P

@DllImport("libc")
func getpid() int32;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(fn.HasSemicolonBody)
        Assert.Null(fn.Body)
        Assert.NotNull(fn.SemicolonBodyToken)
        Assert.Equal(SyntaxKind.SemicolonToken, fn.SemicolonBodyToken!!.Kind)
    }

    @Fact
    func Function_With_Block_Body_Has_No_Semicolon_Body_Token() {
        const source = `
package P

func foo() int32 {
    return 0
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.False(fn.HasSemicolonBody)
        Assert.NotNull(fn.Body)
        Assert.Null(fn.SemicolonBodyToken)
    }

    @Fact
    func DllImport_Annotation_With_Named_Arguments_Parses() {
        const source = `
package P

@DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi, SetLastError: false)
func MyStrLen(text string) nint;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let annotation = Assert.Single(fn.Annotations)
        Assert.Equal("DllImport", annotation.GetNameText())
        Assert.True(annotation.HasArgumentList)
        Assert.True(fn.HasSemicolonBody)
        Assert.Equal(4, annotation.Arguments.Count)
    }
}
