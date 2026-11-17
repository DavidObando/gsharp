// <copyright file="OutDeclarationRedeclarationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0060: an inline `out let name` that redeclares a name in the same scope
/// reports GS0102 only. The rejected declaration binds to an error expression.
/// The imported-call by-reference check must not report GS9002 for it, because
/// the argument is an `out` argument.
open class OutDeclarationRedeclarationTests {
    /// The repro from the Oats compiler-as-library notes. The second `out let _`
    /// is a redeclaration of the local `_`, because only `out _` is a discard.
    @Fact
    func RedeclaredOutLetAtImportedCall_ReportsOnlyGs0102() {
        const source = `
package R
import System
import System.Collections.Generic

let d = Dictionary[string, int32]()
let a = d.TryGetValue("x", out let _)
let b = d.TryGetValue("y", out let _)
Console.WriteLine(a || b)
`
        let diagnostic = Assert.Single(GetDiagnostics(source))
        Assert.Equal("GS0102", diagnostic.Id)
        Assert.Equal(7, diagnostic.Location.StartLine)
        Assert.Equal(35, diagnostic.Location.StartCharacter)
    }

    /// The same redeclaration with a named `out var` local.
    @Fact
    func RedeclaredOutVarAtImportedCall_ReportsOnlyGs0102() {
        const source = `
package R
import System
import System.Collections.Generic

let d = Dictionary[string, int32]()
let a = d.TryGetValue("x", out var v)
let b = d.TryGetValue("y", out var v)
Console.WriteLine(a || b)
`
        let diagnostic = Assert.Single(GetDiagnostics(source))
        Assert.Equal("GS0102", diagnostic.Id)
        Assert.Equal(7, diagnostic.Location.StartLine)
        Assert.Equal(35, diagnostic.Location.StartCharacter)
    }

    /// Regression guard: two `out _` discards in one scope stay legal (ADR-0060).
    @Fact
    func RepeatedOutDiscardAtImportedCall_HasNoDiagnostics() {
        const source = `
package R
import System
import System.Collections.Generic

let d = Dictionary[string, int32]()
let a = d.TryGetValue("x", out _)
let b = d.TryGetValue("y", out _)
Console.WriteLine(a || b)
`
        Assert.Empty(GetDiagnostics(source))
    }

    shared {
        private func GetDiagnostics(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.GetDiagnostics()
        }
    }
}
