// <copyright file="Issue1603UsingDeconstructionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import Xunit

/// Issue #1603: `using let (a, b) = …` (tuple deconstruction) and
/// `using let { … } = …` (named deconstruction) are not a single
/// variable declaration, so `using` cannot wrap them. Parsing must
/// report `GS0418` and recover instead of throwing an
/// (cref:System.InvalidCastException) from the previous unconditional
/// cast to (cref:VariableDeclarationSyntax). Same for
/// `await using`.
open class Issue1603UsingDeconstructionParserTests {
    @Fact
    func Using_TupleDeconstruction_Reports_GS0418_Instead_Of_Throwing() {
        const source = `
package p
class C { func F() { using let (a, b) = G() } func G() (int32, int32) { return (1, 2) } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0418")
    }

    @Fact
    func AwaitUsing_TupleDeconstruction_Reports_GS0418_Instead_Of_Throwing() {
        const source = `
package p
class C { async func F() { await using let (a, b) = G() } func G() (int32, int32) { return (1, 2) } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0418")
    }

    @Fact
    func Using_NamedDeconstruction_Reports_GS0418_Instead_Of_Throwing() {
        const source = `
package p
data struct Pt { let X int32 let Y int32 }
class C { func F(p Pt) { using let { X, Y } = p } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0418")
    }

    @Fact
    func Using_SingleVariableDeclaration_Still_Parses_Without_GS0418() {
        const source = `
package p
class C { func F() { using let a = G() } func G() int32 { return 1 } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0418")
    }
}
