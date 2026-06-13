// <copyright file="Issue758LibraryImportParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Parser-level coverage for ADR-0092 / issue #758 P/Invoke surface syntax:
/// a function annotated with <c>@LibraryImport</c> uses the same
/// semicolon-bodied <c>func</c> shape that ADR-0086 introduced for
/// <c>@DllImport</c>. The parser stays permissive and only checks the
/// shape; semantic validation (mutual exclusion, marshalling-table
/// membership, required arguments) is reported by the binder.
/// </summary>
public class Issue758LibraryImportParserTests
{
    [Fact]
    public void LibraryImport_With_Semicolon_Body_Parses_Without_Diagnostics()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libc"")
func getpid_native() int32;
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var annotation = Assert.Single(fn.Annotations);
        Assert.Equal("LibraryImport", annotation.GetNameText());
        Assert.True(annotation.HasArgumentList);
        Assert.True(fn.HasSemicolonBody);
        Assert.Null(fn.Body);
    }

    [Fact]
    public void LibraryImport_With_StringMarshalling_And_EntryPoint_Parses()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libc"", EntryPoint: ""strlen"", StringMarshalling: StringMarshalling.Utf8, SetLastError: true)
func strlen_native(text string) nint;
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var annotation = Assert.Single(fn.Annotations);
        Assert.Equal("LibraryImport", annotation.GetNameText());
        Assert.True(fn.HasSemicolonBody);
        Assert.Equal(4, annotation.Arguments.Count);
    }

    [Fact]
    public void LibraryImport_With_Utf16_StringMarshalling_Parses()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libc"", StringMarshalling: StringMarshalling.Utf16)
func wcslen_native(text string) nint;
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }
}
