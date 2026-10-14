// <copyright file="Issue758LibraryImportParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Parser-level coverage for ADR-0092 / issue #758 P/Invoke surface syntax:
/// a function annotated with `@LibraryImport` uses the same
/// semicolon-bodied `func` shape that ADR-0086 introduced for
/// `@DllImport`. The parser stays permissive and only checks the
/// shape; semantic validation (mutual exclusion, marshalling-table
/// membership, required arguments) is reported by the binder.
open class Issue758LibraryImportParserTests {
    @Fact
    func LibraryImport_With_Semicolon_Body_Parses_Without_Diagnostics() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc")
func getpid_native() int32;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let annotation = Assert.Single(fn.Annotations)
        Assert.Equal("LibraryImport", annotation.GetNameText())
        Assert.True(annotation.HasArgumentList)
        Assert.True(fn.HasSemicolonBody)
        Assert.Null(fn.Body)
    }

    @Fact
    func LibraryImport_With_StringMarshalling_And_EntryPoint_Parses() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8, SetLastError: true)
func strlen_native(text string) nint;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let annotation = Assert.Single(fn.Annotations)
        Assert.Equal("LibraryImport", annotation.GetNameText())
        Assert.True(fn.HasSemicolonBody)
        Assert.Equal(4, annotation.Arguments.Count)
    }

    @Fact
    func LibraryImport_With_Utf16_StringMarshalling_Parses() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", StringMarshalling: StringMarshalling.Utf16)
func wcslen_native(text string) nint;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }
}
