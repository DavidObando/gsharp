// <copyright file="Issue4962IfInitializerFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import Xunit

/// Issue #4962: the `;` after an `if init; cond` initializer separates the
/// header's clauses, like the `;` of a for-clause header. The formatter keeps
/// the header on one line in both the statement and the expression form and
/// is idempotent.
class Issue4962IfInitializerFormattingTests {
    @Fact
    func IfInitializerHeader_StaysOnOneLine_InBothForms() {
        const source = `func g() int32 {
    return 5
}
let s = if   var   v=g() ;v>3{ v }else if var w=v*2;w>1 { w } else { 0 }
let act = () -> {
    if var v = g();v > 3 { Console.WriteLine(v) } else { Console.WriteLine(0) }
}
if   var v=g() ;v>3{ Console.WriteLine(v) }`
        const expected = `func g() int32 {
    return 5
}
let s = if var v = g(); v > 3 {
    v
} else if var w = v * 2; w > 1 {
    w
} else {
    0
}
let act = () -> {
    if var v = g(); v > 3 {
        Console.WriteLine(v)
    } else {
        Console.WriteLine(0)
    }
}
if var v = g(); v > 3 {
    Console.WriteLine(v)
}
`
        let result = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(result.Diagnostics)
        let text = result.Text!!.ToString()
        Assert.Equal(expected, text)
        Assert.Equal(text, GSharpFormatter.Format(result.Text!!).Text!!.ToString())
    }
}
