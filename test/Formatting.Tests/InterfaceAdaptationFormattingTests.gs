// <copyright file="InterfaceAdaptationFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import Xunit

class InterfaceAdaptationFormattingTests {
    @Fact
    func AdaptAndCapturingRichObjectsRoundTripCanonically() {
        const source = `interface Reader{func Read()int32;}
func use(source Source,p managed[Source]){
let direct=adapt[Reader](source)
let retained=adapt[Reader](ref p)
let rich=object:Reader{let Snapshot=source.Value
func Read()int32->source.Value+Snapshot}
}`
        let first = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(first.Diagnostics)
        Assert.NotNull(first.Text)
        let text = first.Text!!.ToString()
        Assert.Contains("adapt[Reader](source)", text)
        Assert.Contains("adapt[Reader](ref p)", text)
        Assert.Contains("let Snapshot = source.Value", text)
        let second = GSharpFormatter.Format(first.Text!!)
        Assert.Empty(second.Diagnostics)
        Assert.Equal(text, second.Text!!.ToString())
    }
}
