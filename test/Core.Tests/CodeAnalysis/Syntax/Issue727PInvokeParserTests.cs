// <copyright file="Issue727PInvokeParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Parser-level coverage for ADR-0086 / issue #727 P/Invoke surface syntax:
/// a function whose body is a single <c>;</c> token (no managed body) is
/// accepted by the parser without diagnostics, and its
/// <see cref="FunctionDeclarationSyntax.HasSemicolonBody"/> flag is set.
/// Validation of the matching <c>@DllImport</c> annotation happens in the
/// binder; the parser intentionally stays permissive so the binder can
/// produce more specific diagnostics.
/// </summary>
public class Issue727PInvokeParserTests
{
    [Fact]
    public void Function_With_Semicolon_Body_Parses_Without_Diagnostics()
    {
        const string source = @"
package P

@DllImport(""libc"")
func getpid() int32;
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.True(fn.HasSemicolonBody);
        Assert.Null(fn.Body);
        Assert.NotNull(fn.SemicolonBodyToken);
        Assert.Equal(SyntaxKind.SemicolonToken, fn.SemicolonBodyToken.Kind);
    }

    [Fact]
    public void Function_With_Block_Body_Has_No_Semicolon_Body_Token()
    {
        const string source = @"
package P

func foo() int32 {
    return 0
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.False(fn.HasSemicolonBody);
        Assert.NotNull(fn.Body);
        Assert.Null(fn.SemicolonBodyToken);
    }

    [Fact]
    public void DllImport_Annotation_With_Named_Arguments_Parses()
    {
        const string source = @"
package P

@DllImport(""libc"", EntryPoint: ""strlen"", CharSet: CharSet.Ansi, SetLastError: false)
func MyStrLen(text string) nint;
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var annotation = Assert.Single(fn.Annotations);
        Assert.Equal("DllImport", annotation.GetNameText());
        Assert.True(annotation.HasArgumentList);
        Assert.True(fn.HasSemicolonBody);
        Assert.Equal(4, annotation.Arguments.Count);
    }
}
