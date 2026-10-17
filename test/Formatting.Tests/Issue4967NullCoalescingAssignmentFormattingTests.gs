// <copyright file="Issue4967NullCoalescingAssignmentFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import Xunit

/// Issue #4967: the formatter spaces `??=` in value positions the same as in
/// statement position, and the output is idempotent.
class Issue4967NullCoalescingAssignmentFormattingTests {
    @Fact
    func ValuePositionCoalescingAssignmentsFormatStably() {
        const source = `var t string?=nil
t??="stmt"
let r=(t??="expr")
let c=a??=b??="c"
Console.WriteLine(t??="arg")
let f=()->t??="lambda"
func F(x string?) string {
var y=x
return y??="v"
}`
        let result = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(result.Diagnostics)
        let text = result.Text!!.ToString()
        Assert.Contains("t ??= \"stmt\"", text)
        Assert.Contains("let r = (t ??= \"expr\")", text)
        Assert.Contains("let c = a ??= b ??= \"c\"", text)
        Assert.Contains("Console.WriteLine(t ??= \"arg\")", text)
        Assert.Contains("let f = () -> t ??= \"lambda\"", text)
        Assert.Contains("return y ??= \"v\"", text)
        Assert.Equal(text, GSharpFormatter.Format(result.Text!!).Text!!.ToString())
    }
}
