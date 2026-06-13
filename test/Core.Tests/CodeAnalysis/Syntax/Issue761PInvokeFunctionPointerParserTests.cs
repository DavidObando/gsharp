// <copyright file="Issue761PInvokeFunctionPointerParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Parser-level coverage for ADR-0095 / issue #761 — raw function-pointer
/// type clauses <c>unmanaged[CC] (T1, T2, ...) -&gt; R</c>. The parser
/// commits to this shape only when an identifier <c>unmanaged</c> is
/// followed by <c>[</c> or <c>(</c> at the start of a type-clause slot,
/// which keeps the contextual keyword from breaking unrelated user code
/// that simply names a member <c>unmanaged</c>.
/// </summary>
public class Issue761PInvokeFunctionPointerParserTests
{
    [Fact]
    public void FunctionPointer_WithCdeclConvention_Parses()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"", EntryPoint: ""qsort"")
func native_qsort(base nint, nmemb nint, size nint, cmp unmanaged[Cdecl] (nint, nint) -> int32) void;
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var cmpParam = fn.Parameters[3];
        Assert.True(cmpParam.Type.IsFunctionPointer);
        Assert.NotNull(cmpParam.Type.UnmanagedKeyword);
        Assert.Equal("unmanaged", cmpParam.Type.UnmanagedKeyword.Text);
        Assert.NotNull(cmpParam.Type.CallingConventionIdentifierToken);
        Assert.Equal("Cdecl", cmpParam.Type.CallingConventionIdentifierToken.Text);
        Assert.Equal(2, cmpParam.Type.FunctionParameterTypes.Count);
        Assert.Equal("int32", cmpParam.Type.ReturnTypeClause.Identifier.Text);
    }

    [Theory]
    [InlineData("Cdecl")]
    [InlineData("Stdcall")]
    [InlineData("Thiscall")]
    [InlineData("Fastcall")]
    public void FunctionPointer_AllSupportedConventions_Parse(string convention)
    {
        var source = $@"
package P

@DllImport(""libc"")
func native_call(cb unmanaged[{convention}] () -> void) void;
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.True(fn.Parameters[0].Type.IsFunctionPointer);
        Assert.Equal(convention, fn.Parameters[0].Type.CallingConventionIdentifierToken.Text);
    }

    [Fact]
    public void FunctionPointer_AsReturnType_Parses()
    {
        const string source = @"
package P
import System

@DllImport(""libc"", EntryPoint: ""dlsym"")
func native_dlsym(handle nint, name string) unmanaged[Cdecl] () -> void;
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.True(fn.Type.IsFunctionPointer);
        Assert.Equal("Cdecl", fn.Type.CallingConventionIdentifierToken.Text);
    }

    [Fact]
    public void FunctionPointer_MissingCallingConvention_ReportsGS0356()
    {
        const string source = @"
package P

@DllImport(""libc"")
func bad(cb unmanaged () -> void) void;
";
        var tree = SyntaxTree.Parse(source);
        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0356");
    }

    [Fact]
    public void Identifier_NamedUnmanaged_NotFollowedByBracketOrParen_RemainsTypeName()
    {
        // An identifier named `unmanaged` in a type-clause slot that is
        // NOT followed by `[` or `(` falls through to the regular
        // identifier-as-type path. The binder will then report an
        // undefined-type diagnostic (GS0009), proving the parser did not
        // mistakenly commit to the function-pointer shape.
        const string source = @"
package P

func host(x unmanaged) void {}
";
        var tree = SyntaxTree.Parse(source);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.False(fn.Parameters[0].Type.IsFunctionPointer);
        Assert.Equal("unmanaged", fn.Parameters[0].Type.Identifier.Text);
    }
}
