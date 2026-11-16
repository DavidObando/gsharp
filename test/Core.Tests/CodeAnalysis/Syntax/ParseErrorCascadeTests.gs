// <copyright file="ParseErrorCascadeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// A parse error gives one diagnostic at its token. Two rules prevent cascades:
/// the parser reports GS0005 once while it stays at one token, and the binder
/// does not report GS0113 for a type name token that the parser synthesized.
open class ParseErrorCascadeTests {
    /// The repro from the Oats compiler-as-library notes. Before the change it
    /// gave GS0113 "Type ''" and two GS0005 diagnostics at the `{` token.
    @Fact
    func MissingParameterTypeAndCloseParen_ReportsOneGs0005() {
        const source = `
package R
func f( int32 {
}
`
        let diagnostics = GetDiagnostics(source)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0005", diagnostic.Id)
        Assert.Equal(2, diagnostic.Location.StartLine)
        Assert.Equal(14, diagnostic.Location.StartCharacter)
    }

    /// The missing type token alone: the parser reports GS0005 and the binder
    /// adds no GS0113 for the synthesized empty type name.
    @Fact
    func MissingParameterType_ReportsNoEmptyTypeName() {
        const source = `
package R
func f(x) {
}
`
        let diagnostics = GetDiagnostics(source)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0005", diagnostic.Id)
        Assert.Equal(2, diagnostic.Location.StartLine)
        Assert.Equal(8, diagnostic.Location.StartCharacter)
    }

    /// Regression guard: separate errors at different tokens are all reported.
    @Fact
    func ErrorsAtDifferentTokens_AreEachReported() {
        const source = `
package R
func f(a int32 b int32) {
}
func g( {
}
`
        let diagnostics = GetDiagnostics(source).Where((d Diagnostic) -> d.Id == "GS0005").ToArray()
        Assert.True(diagnostics.Length >= 2, "expected one GS0005 per failing token")
        Assert.Equal(diagnostics.Length, diagnostics.Select((d Diagnostic) -> d.Location.Span.Start).Distinct().Count())
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Location.StartLine == 2)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Location.StartLine == 4)
    }

    shared {
        private func GetDiagnostics(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree).GetDiagnostics()
        }
    }
}
