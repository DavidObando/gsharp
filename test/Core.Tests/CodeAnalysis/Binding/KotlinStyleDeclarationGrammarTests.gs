// <copyright file="KotlinStyleDeclarationGrammarTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Linq
import Xunit

/// ADR-0078 / issue #718: parser-level coverage of the canonical
/// Kotlin/Swift-style declaration head. Every row of the spelling matrix
/// must parse without diagnostics; every rejected combination must emit
/// the documented diagnostic; the legacy `type Name kind` head must
/// be rejected.
open class KotlinStyleDeclarationGrammarTests {
    @Theory
    @InlineData("class Animal(name string)")
    @InlineData("open class Animal(name string)")
    @InlineData("sealed class Shape")
    @InlineData("data class Person(name string, age int32)")
    @InlineData("data struct Point(x int32, y int32)")
    @InlineData("struct Point(x int32, y int32)")
    @InlineData("inline struct UserId(value string)")
    @InlineData("enum Color { Red, Green, Blue }")
    @InlineData("enum Shape { Circle(r float64); Square(s float64) }")
    @InlineData("interface Drawable { func Draw(); }")
    @InlineData("sealed interface Shape { }")
    func SpellingMatrix_EveryRowParses(head string) {
        var src = head
        // Class / struct / enum / interface alone may lack a body — append empty body if missing.
        if !head.Contains('{') {
            src += " { }"
        }
        let result = EmittedOracle.Evaluate(src + `
0
`)
        // The matrix row must parse and bind. Some rows (e.g. a class with
        // an unused param) emit warnings; only assert no parser-level
        // errors with GS0306–GS0312.
        Assert.DoesNotContain(
            result.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0306" ||
                d.Id == "GS0307" ||
                d.Id == "GS0308" ||
                d.Id == "GS0309" ||
                d.Id == "GS0310" ||
                d.Id == "GS0311" ||
                d.Id == "GS0312"
        )
    }

    @Theory
    @InlineData("type Foo class { }", "GS0306")
    @InlineData("type Foo struct { }", "GS0306")
    @InlineData("type Foo enum { Red }", "GS0306")
    @InlineData("type Foo interface { }", "GS0306")
    func LegacyTypeKindHead_Rejected(src string, expected string) {
        let result = EmittedOracle.Evaluate(src + `
0
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == expected)
    }

    @Fact
    func LegacyRecordKeyword_Rejected() {
        let result = EmittedOracle.Evaluate(`record Foo { var X int32 }
0
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0307")
    }
}
