// <copyright file="Adr0174SuspendFuncParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0174 D4: `suspend` is a reserved keyword that takes the same
/// modifier slot as `async` before `func` — on top-level functions,
/// class and struct methods, `shared` methods, and receiver-clause
/// functions — and a declaration is exactly one of `async` or
/// `suspend`.
open class Adr0174SuspendFuncParserTests {
    @Fact
    func Suspend_IsAKeyword() {
        Assert.Equal(SyntaxKind.SuspendKeyword, SyntaxFacts.GetKeywordKind("suspend"))
        Assert.Equal("suspend", SyntaxFacts.GetText(SyntaxKind.SuspendKeyword))
    }

    @Fact
    func TopLevelFunction_ParsesWithSuspendModifier() {
        let tree = SyntaxTree.Parse(`package P
suspend func take(ch in chan[int32]) int32 {
    return <-ch
}`)
        Assert.Empty(tree.Diagnostics)
        let function = tree.Root.DescendantNodes().OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(function.IsSuspend)
        Assert.False(function.IsAsync)
        Assert.Equal(SyntaxKind.SuspendKeyword, function.AsyncModifier?.Kind)
    }

    @Fact
    func AccessibilityAndUnsafe_ComposeWithSuspend() {
        let tree = SyntaxTree.Parse(`package P
private suspend func a() {
}
unsafe suspend func b() {
}
public unsafe suspend func c() int32 {
    return 1
}`)
        Assert.Empty(tree.Diagnostics)
        let functions = tree.Root.DescendantNodes().OfType[FunctionDeclarationSyntax]().ToArray()
        Assert.Equal(3, functions.Length)
        Assert.All(functions, (f FunctionDeclarationSyntax) -> Assert.True(f.IsSuspend))
        Assert.True(functions[1].IsUnsafe)
        Assert.True(functions[2].IsUnsafe)
    }

    @Fact
    func ClassMethods_ParseWithSuspendModifier() {
        let tree = SyntaxTree.Parse(`package P
class Pump {
    var ch chan[int32]
    suspend func Take() int32 {
        return <-ch
    }
    public suspend func Put(v int32) {
        ch <- v
    }
    shared {
        suspend func Make() int32 {
            return 1
        }
    }
}`)
        Assert.Empty(tree.Diagnostics)
        let methods = tree.Root.DescendantNodes().OfType[FunctionDeclarationSyntax]().ToArray()
        Assert.Equal(3, methods.Length)
        Assert.All(methods, (m FunctionDeclarationSyntax) -> Assert.True(m.IsSuspend))
    }

    @Fact
    func ReceiverClauseFunction_ParsesWithSuspendModifier() {
        let tree = SyntaxTree.Parse(`package P
struct Box {
    var ch chan[int32]
}
suspend func (b Box) Take() int32 {
    return <-b.ch
}`)
        Assert.Empty(tree.Diagnostics)
        let function = tree
            .Root
            .DescendantNodes()
            .OfType[FunctionDeclarationSyntax]()
            .Single((f FunctionDeclarationSyntax) -> f.Receiver != nil)
        Assert.True(function.IsSuspend)
    }

    @Fact
    func AsyncSuspend_IsRejected() {
        let tree = SyntaxTree.Parse(`package P
async suspend func f() {
}`)
        Assert.NotEmpty(tree.Diagnostics)
    }

    @Fact
    func Suspend_IsNotAnIdentifier() {
        let tree = SyntaxTree.Parse("package P\nlet suspend = 1")
        Assert.NotEmpty(tree.Diagnostics)
    }
}
