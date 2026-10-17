// <copyright file="Adr0200BlockTailFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import Xunit

/// ADR-0200 / issues #4963, #4965, #4966: the formatter keeps the meaning of
/// the forms the block-tail rule now accepts and formats them stably.
class Adr0200BlockTailFormattingTests {
    @Fact
    func BlockTailFormsFormatStably() {
        const source = `func f(x int32) int32 -> {
if x > 0 { return 1 }
let y = switch x {
case 1, 2: 10
default: { return 0 }
}
y
}
func g(c bool) -> if c { log() }
func h(x int32) {
switch x {
case 1: log()
default: log()
}
}
let v = {
let a = 1
{ a + 1 }
}
let w = if true { 1 } else { throw System.Exception("x") }`
        let result = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(result.Diagnostics)
        let text = result.Text!!.ToString()
        let normalized = text.Replace("\r\n", "\n")
        Assert.Contains("func f(x int32) int32 -> {\n    if x > 0 {\n        return 1\n    }", normalized)
        Assert.Contains("        case 1, 2: 10\n        default: {\n            return 0\n        }", normalized)
        Assert.Contains("func g(c bool) -> if c {\n    log()\n}", normalized)
        Assert.Contains("    switch x {\n        case 1: log()\n        default: log()\n    }", normalized)
        Assert.Contains("} else {\n    throw System.Exception(\"x\")\n}", normalized)
        Assert.Equal(text, GSharpFormatter.Format(result.Text!!).Text!!.ToString())
    }
}
