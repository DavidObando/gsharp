// <copyright file="Issue761PInvokeFunctionPointerParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Parser-level coverage for ADR-0095 / issue #761 — raw function-pointer
/// type clauses `unmanaged[CC] (T1, T2, ...) -> R`. The parser
/// commits to this shape only when an identifier `unmanaged` is
/// followed by `[` or `(` at the start of a type-clause slot,
/// which keeps the contextual keyword from breaking unrelated user code
/// that simply names a member `unmanaged`.
open class Issue761PInvokeFunctionPointerParserTests {
    @Fact
    func FunctionPointer_WithCdeclConvention_Parses() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "qsort")
func native_qsort(base nint, nmemb nint, size nint, cmp unmanaged[Cdecl] (nint, nint) -> int32) void;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let cmpParam = fn.Parameters[3]
        Assert.True(cmpParam.Type!!.IsFunctionPointer)
        Assert.NotNull(cmpParam.Type!!.UnmanagedKeyword)
        Assert.Equal("unmanaged", cmpParam.Type!!.UnmanagedKeyword!!.Text)
        Assert.NotNull(cmpParam.Type!!.CallingConventionIdentifierToken)
        Assert.Equal("Cdecl", cmpParam.Type!!.CallingConventionIdentifierToken!!.Text)
        Assert.Equal(2, cmpParam.Type!!.FunctionParameterTypes!!.Count)
        Assert.Equal("int32", cmpParam.Type!!.ReturnTypeClause!!.Identifier!!.Text)
    }

    @Theory
    @InlineData("Cdecl")
    @InlineData("Stdcall")
    @InlineData("Thiscall")
    @InlineData("Fastcall")
    func FunctionPointer_AllSupportedConventions_Parse(convention string) {
        let source = (`
package P

@DllImport("libc")
func native_call(cb unmanaged[` + "$convention" + `] () -> void) void;
`)
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(fn.Parameters[0].Type!!.IsFunctionPointer)
        Assert.Equal(convention, fn.Parameters[0].Type!!.CallingConventionIdentifierToken!!.Text)
    }

    @Fact
    func FunctionPointer_AsReturnType_Parses() {
        const source = `
package P
import System

@DllImport("libc", EntryPoint: "dlsym")
func native_dlsym(handle nint, name string) unmanaged[Cdecl] () -> void;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(fn.Type!!.IsFunctionPointer)
        Assert.Equal("Cdecl", fn.Type!!.CallingConventionIdentifierToken!!.Text)
    }

    @Fact
    func FunctionPointer_BareUnmanaged_ParsesClean() {
        // ADR-0095 v2 / issue #3611: the calling-convention slot is
        // optional — bare `unmanaged (T) -> R` is the platform-default
        // unmanaged convention (GS0356 is retired).
        const source = `
package P

@DllImport("libc")
func bare(cb unmanaged () -> void) void;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let cb TypeClauseSyntax? = fn.Parameters.Single().Type
        Assert.True(cb!!.IsFunctionPointer)
        Assert.Null(cb!!.CallingConventionIdentifierToken)
        Assert.Null(cb!!.CallingConventionOpenBracketToken)
    }

    @Fact
    func FunctionPointer_CombinedConventionList_ParsesInSourceOrder() {
        // ADR-0095 v2 / issue #3611: the slot accepts a comma-separated
        // convention list; the first identifier stays on the dedicated
        // token and the `, identifier` tail rides CallingConventionRestTokens.
        const source = `
package P

@DllImport("libc")
func combined(cb unmanaged[Cdecl, SuppressGCTransition] (int32) -> int32) void;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let cb TypeClauseSyntax? = fn.Parameters.Single().Type
        Assert.True(cb!!.IsFunctionPointer)
        Assert.Equal("Cdecl", cb!!.CallingConventionIdentifierToken!!.Text)
        let rest = cb!!.CallingConventionRestTokens.OfType[SyntaxToken]().ToArray()
        Assert.Equal(2, rest.Length)
        Assert.Equal(SyntaxKind.CommaToken, rest[0].Kind)
        Assert.Equal("SuppressGCTransition", rest[1].Text)
    }

    @Fact
    func Identifier_NamedUnmanaged_NotFollowedByBracketOrParen_RemainsTypeName() {
        // An identifier named `unmanaged` in a type-clause slot that is
        // NOT followed by `[` or `(` falls through to the regular
        // identifier-as-type path. The binder will then report an
        // undefined-type diagnostic (GS0009), proving the parser did not
        // mistakenly commit to the function-pointer shape.
        const source = `
package P

func host(x unmanaged) void {}
`
        let tree = SyntaxTree.Parse(source)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.False(fn.Parameters[0].Type!!.IsFunctionPointer)
        Assert.Equal("unmanaged", fn.Parameters[0].Type!!.Identifier!!.Text)
    }
}
