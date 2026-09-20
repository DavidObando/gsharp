// <copyright file="ManagedReferenceFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Formatting.Tests;

public sealed class ManagedReferenceFormattingTests
{
    [Fact]
    public void HandlesKeepPermissionsNullabilityAndOrdinaryEscapes()
    {
        var result = GSharpFormatter.Format(SourceText.From(
            "func use(p managed[string?]?,q readonly managed[int32]){let r=readonly managed(*q)}\nclass $managed[T]{}\n"));
        Assert.Empty(result.Diagnostics);
        Assert.NotNull(result.Text);
        var text = result.Text.ToString();
        Assert.Contains("managed[string?]?", text);
        Assert.Contains("readonly managed[int32]", text);
        Assert.Contains("readonly managed(*q)", text);
        Assert.Contains("$managed[T]", text);
        Assert.Equal(text, GSharpFormatter.Format(result.Text).Text.ToString());
    }

    [Fact]
    public void NestedTypesBorrowModifiersAndStaticReceiversRoundTrip()
    {
        const string source = """
            func use(p List[readonly managed[string?]?],q (readonly managed[int32],managed[int32]?)){
            let array=[]readonly managed[int32]{q.Item1}
            let grouped (readonly managed[int32])?=q.Item1
            let native=readonly managed[int32].FromArray([]int32{1},0)
            let $readonly=readonlyManaged(2)
            }
            func borrow(p readonly managed[int32]) ref readonly readonly managed[int32]{return ref p}
            """;
        var result = GSharpFormatter.Format(SourceText.From(source));
        Assert.Empty(result.Diagnostics);
        Assert.NotNull(result.Text);
        var text = result.Text.ToString();
        Assert.Contains("List[readonly managed[string?]?]", text);
        Assert.Contains("(readonly managed[int32], managed[int32]?)", text);
        Assert.Contains("ref readonly readonly managed[int32]", text);
        Assert.Contains("[]readonly managed[int32]", text);
        Assert.Contains("(readonly managed[int32])?", text);
        Assert.Contains("readonly managed[int32].FromArray", text);
        Assert.Contains("$readonly = readonlyManaged(2)", text);
        Assert.Equal(text, GSharpFormatter.Format(result.Text).Text.ToString());
    }
}
