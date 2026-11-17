// <copyright file="PropertyInitializerDiagnosticTests.cs" company="GSharp">
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

/// The `PropertyDecl` grammar has no initializer. `prop X T = value` reports
/// GS0640 once at the `=` token. The parser consumes the initializer, so the
/// `=` does not start a field declaration and cause GS0113, GS0288, and GS0005.
open class PropertyInitializerDiagnosticTests {
    /// The repro from the Oats compiler-as-library notes.
    @Fact
    func BareAutoPropertyInitializer_ReportsOnlyGs0640() {
        const source = `
package R
import System

class C {
    prop X int32 = 1
}
Console.WriteLine(C().X)
`
        AssertSingleGs0640(source, line: 5, character: 17)
    }

    /// The initializer after an accessor list gets the same single diagnostic.
    @Fact
    func AccessorListPropertyInitializer_ReportsOnlyGs0640() {
        const source = `
package R
import System

class C {
    prop X int32 { get; set; } = 1
}
Console.WriteLine(C().X)
`
        AssertSingleGs0640(source, line: 5, character: 31)
    }

    /// The parser continues after the initializer, so a later member binds.
    @Fact
    func PropertyInitializer_LaterMembersStillParse() {
        const source = `
package R
import System

class C {
    prop X int32 = 1 + 2
    var Y int32 = 3
}
Console.WriteLine(C().Y)
`
        AssertSingleGs0640(source, line: 5, character: 17)
    }

    shared {
        private func AssertSingleGs0640(source string, line int32, character int32) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let diagnostics = Compilation(tree).GetDiagnostics()
            let diagnostic = Assert.Single(diagnostics)
            Assert.Equal("GS0640", diagnostic.Id)
            Assert.Equal(line, diagnostic.Location.StartLine)
            Assert.Equal(character, diagnostic.Location.StartCharacter)
        }
    }
}
