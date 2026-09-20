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
            "func use(p managed[string?]?,q readonlyManaged[int32]){let r=readonlyManaged(*q)}\nclass $managed[T]{}\n"));
        Assert.Empty(result.Diagnostics);
        Assert.NotNull(result.Text);
        var text = result.Text.ToString();
        Assert.Contains("managed[string?]?", text);
        Assert.Contains("readonlyManaged[int32]", text);
        Assert.Contains("$managed[T]", text);
        Assert.Equal(text, GSharpFormatter.Format(result.Text).Text.ToString());
    }
}
