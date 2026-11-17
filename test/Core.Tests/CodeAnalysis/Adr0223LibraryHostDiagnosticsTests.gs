// <copyright file="Adr0223LibraryHostDiagnosticsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Reflection
import Xunit

/// ADR-0223 D1: a library host gets GS0634 and GS9998 from public members,
/// as `gsc` does. The reflection checks fail while the members are internal.
open class Adr0223LibraryHostDiagnosticsTests {
    @Fact
    func MissingEntryPointDiagnostics_IsPublicAndReportsGs0634() {
        let method = typeof(Compilation).GetMethod(
            "GetMissingEntryPointDiagnostics",
            BindingFlags.Instance | BindingFlags.Public
        )
        Assert.NotNull(method)
        const source = `
package R

func main() {
}
`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        Assert.Empty(compilation.GetDiagnostics())
        let diagnostic = Assert.Single(compilation.GetMissingEntryPointDiagnostics())
        Assert.Equal("GS0634", diagnostic.Id)
        Assert.Equal(3, diagnostic.Location.StartLine)
        Assert.Equal(5, diagnostic.Location.StartCharacter)
    }

    @Fact
    func InternalErrorDiagnostic_IsPublicAndReportsGs9998() {
        let method = typeof(Compilation).GetMethod(
            "CreateInternalErrorDiagnostic",
            BindingFlags.Static | BindingFlags.Public
        )
        Assert.NotNull(method)
        let diagnostic = Compilation.CreateInternalErrorDiagnostic(InvalidOperationException("boom"))
        Assert.Equal("GS9998", diagnostic.Id)
        Assert.True(diagnostic.IsError)
    }
}
