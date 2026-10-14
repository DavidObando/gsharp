// <copyright file="ParserTopLevelOrderingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Linq
import Xunit

/// ADR-0066 deferred decision D5: within a single `.gs` file, top-level
/// statements must form a single contiguous block — they may all sit at the
/// top of the file (the C#-style idiom), all sit at the bottom (the Go-style
/// idiom most G# samples follow), or be the only members, but they cannot
/// be interleaved with type / function declarations. Interleaved layouts
/// are reported by the parser as `GS0286`.
open class ParserTopLevelOrderingTests {
    @Fact
    func All_TopLevel_Statements_No_Declarations_Reports_Nothing() {
        let tree = SyntaxTree.Parse(SourceText.From(`package P
var x = 1
var y = 2
`))
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.Id == Gs0286)
    }

    @Fact
    func TopLevel_Block_Then_Declarations_Reports_Nothing() {
        // C#-style: all TLS first, then declarations.
        let tree = SyntaxTree.Parse(SourceText.From(`package P
var x = 1
func Helper() {
}
`))
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.Id == Gs0286)
    }

    @Fact
    func Declarations_Then_TopLevel_Block_Reports_Nothing() {
        // Go-style: all declarations first, trailing TLS block. This is the
        // prevailing G# idiom across ~488 samples + test fixtures, so the
        // contiguous rule must allow it.
        let tree = SyntaxTree.Parse(SourceText.From(`package P
func Helper() {
}
var x = 1
var y = 2
`))
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.Id == Gs0286)
    }

    @Fact
    func TopLevel_Then_Declaration_Then_TopLevel_Reports_GS0286_On_Second_Block() {
        // TLS interleaved with a declaration — the truly confusing layout
        // that the contiguous rule exists to catch.
        let tree = SyntaxTree.Parse(SourceText.From(`package P
var x = 1
func Helper() {
}
var y = 2
`))
        let diagnostic = Assert.Single(tree.Diagnostics, (d Diagnostic) -> d.Id == Gs0286)
        Assert.Contains("var y = 2", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func Two_Trailing_TopLevel_Statements_After_Multiple_Declarations_Are_Treated_As_One_Block() {
        // Companion to Declarations_Then_TopLevel_Block_Reports_Nothing —
        // the trailing TLS block can have any number of statements; only
        // *interleaving* triggers GS0286.
        let tree = SyntaxTree.Parse(SourceText.From(`package P
func A() {
}
func B() {
}
var x = 1
var y = 2
`))
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.Id == Gs0286)
    }

    @Fact
    func Multiple_Interleaved_TopLevel_Statements_Each_Report_GS0286() {
        // TLS, decl, TLS, decl, TLS — three TLS, two interleaving decls.
        // The first TLS is allowed (no prior decl-after-TLS), the second
        // and third each violate contiguity.
        let tree = SyntaxTree.Parse(SourceText.From(`package P
var a = 1
func F() {
}
var b = 2
func G() {
}
var c = 3
`))
        Assert.Equal(2, tree.Diagnostics.Count((d Diagnostic) -> d.Id == Gs0286))
    }

    shared {
        private const Gs0286 string = "GS0286"
    }
}
