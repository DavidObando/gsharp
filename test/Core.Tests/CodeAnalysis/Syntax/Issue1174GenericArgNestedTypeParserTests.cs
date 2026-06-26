// <copyright file="Issue1174GenericArgNestedTypeParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1174: a dotted nested-type name (<c>Container.Nested</c>, <c>A.B.C</c>,
/// <c>Outer.Generic[T]</c>) must scan as a single type clause inside a
/// generic-argument position so a generic call / composite literal such as
/// <c>List[C.E](...)</c> or <c>List[C.E]{...}</c> is recognised by the
/// generic-call-site lookahead rather than being mis-parsed as an indexer (which
/// previously surfaced GS0005). The indexer-then-member disambiguation from
/// issue #942 (a trailing <c>.</c> AFTER the <c>]</c>) must be preserved.
/// </summary>
public class Issue1174GenericArgNestedTypeParserTests
{
    [Fact]
    public void GenericCall_WithDottedTypeArgument_ParsesWithoutDiagnostics()
    {
        const string source = @"
package p
import System.Collections.Generic
class C { data struct E(X uint32) { } }
func F() {
    let xs = List[C.E]()
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void GenericCompositeLiteral_WithDottedTypeArgument_ParsesWithoutDiagnostics()
    {
        const string source = @"
package p
import System.Collections.Generic
class C { data struct E(X uint32) { } }
func F() {
    let xs = List[C.E]{}
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void GenericReturnType_WithDottedTypeArgument_ParsesWithoutDiagnostics()
    {
        const string source = @"
package p
import System.Collections.Generic
class C { data struct E(X uint32) { } }
func F() List[C.E] { return List[C.E]() }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void GenericCall_WithDeepDottedTypeArgument_Parses()
    {
        const string source = @"
package p
import System.Collections.Generic
class A { class B { data struct C(Z uint32) { } } }
func F() {
    let xs = List[A.B.C]()
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void GenericCall_WithNestedGenericTypeArgument_Parses()
    {
        const string source = @"
package p
import System.Collections.Generic
class Outer { data struct Box[T](V T) { } }
func F() {
    let xs = List[Outer.Box[int32]]()
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void IndexerThenMember_NotRegressed_ByDottedTailSupport()
    {
        // Issue #942 guard: `arr[i].ToString()` is an indexer-then-member access,
        // not a generic call, and must still parse without diagnostics.
        const string source = @"
package p
import System
import System.Collections.Generic
func F() {
    let arr = List[int32]()
    let s = arr[0].ToString()
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }
}
