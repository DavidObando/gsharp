// <copyright file="InterfaceAdaptationFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Formatting.Tests;

public sealed class InterfaceAdaptationFormattingTests
{
    [Fact]
    public void AdaptAndCapturingRichObjectsRoundTripCanonically()
    {
        const string source = """
            interface Reader{func Read()int32;}
            func use(source Source,p managed[Source]){
            let direct=adapt[Reader](source)
            let retained=adapt[Reader](ref p)
            let rich=object:Reader{let Snapshot=source.Value
            func Read()int32->source.Value+Snapshot}
            }
            """;

        var first = GSharpFormatter.Format(SourceText.From(source));
        Assert.Empty(first.Diagnostics);
        Assert.NotNull(first.Text);
        var text = first.Text.ToString();
        Assert.Contains("adapt[Reader](source)", text);
        Assert.Contains("adapt[Reader](ref p)", text);
        Assert.Contains("let Snapshot = source.Value", text);

        var second = GSharpFormatter.Format(first.Text);
        Assert.Empty(second.Diagnostics);
        Assert.Equal(text, second.Text.ToString());
    }
}
