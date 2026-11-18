// <copyright file="CatchClauseUnresolvedTypeTests.cs" company="GSharp">
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

/// ADR-0177 D: GS0573 compares each clause type with the types of earlier
/// unfiltered clauses. A clause type that does not resolve reports GS0113.
/// That clause must not take part in the GS0573 check in either position.
open class CatchClauseUnresolvedTypeTests {
    /// The repro from the Oats compiler-as-library notes: the unresolved clause
    /// comes first. It must not cover the later clause as `System.Exception`.
    @Fact
    func UnresolvedClauseBeforeKnownClause_ReportsOnlyGs0113() {
        const source = `
package R
import System

try {
    Console.WriteLine("x")
} catch (TaskCanceledException) {
    Console.WriteLine("t")
} catch (OperationCanceledException) {
    Console.WriteLine("o")
}
`
        let diagnostic = Assert.Single(GetDiagnostics(source))
        Assert.Equal("GS0113", diagnostic.Id)
        Assert.Equal(6, diagnostic.Location.StartLine)
        Assert.Equal(9, diagnostic.Location.StartCharacter)
    }

    /// The unresolved clause comes after `catch (Exception)`. It must not be
    /// reported as unreachable, because its type is not known.
    @Fact
    func UnresolvedClauseAfterExceptionClause_ReportsOnlyGs0113() {
        const source = `
package R
import System

try {
    Console.WriteLine("x")
} catch (Exception) {
    Console.WriteLine("e")
} catch (TaskCanceledException) {
    Console.WriteLine("t")
}
`
        let diagnostic = Assert.Single(GetDiagnostics(source))
        Assert.Equal("GS0113", diagnostic.Id)
        Assert.Equal(8, diagnostic.Location.StartLine)
        Assert.Equal(9, diagnostic.Location.StartCharacter)
    }

    /// Regression guard: a resolved clause after `catch (Exception)` still
    /// reports GS0573 at the later clause type.
    @Fact
    func KnownClauseAfterExceptionClause_StillReportsGs0573() {
        const source = `
package R
import System

try {
    Console.WriteLine("x")
} catch (Exception) {
    Console.WriteLine("e")
} catch (OperationCanceledException) {
    Console.WriteLine("o")
}
`
        let diagnostic = Assert.Single(GetDiagnostics(source))
        Assert.Equal("GS0573", diagnostic.Id)
        Assert.Equal(8, diagnostic.Location.StartLine)
        Assert.Equal(9, diagnostic.Location.StartCharacter)
    }

    shared {
        private func GetDiagnostics(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.GetDiagnostics()
        }
    }
}
