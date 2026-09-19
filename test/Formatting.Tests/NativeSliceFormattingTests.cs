// <copyright file="NativeSliceFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Formatting.Tests;

public sealed class NativeSliceFormattingTests
{
    [Fact]
    public void OrdinaryNameEscapesAreNotRemoved()
    {
        const string source = "let a=$slice[int32]{Value:1}\nvar b $array[int32]\nlet $readonly=3\n";
        var result = GSharpFormatter.Format(SourceText.From(source));
        Assert.Empty(result.Diagnostics);
        Assert.Contains("$slice[int32]", result.Text!.ToString());
        Assert.Contains("$array[int32]", result.Text!.ToString());
        Assert.Contains("$readonly", result.Text!.ToString());
    }

    [Fact]
    public void NativeTypesAndLiteralsKeepModifierAndNullableBinding()
    {
        const string source = """
            func use(xs readonly slice[string?]?,ys List[readonly slice[int32]],z (readonly slice[int32])?){
            let a=readonly slice[int32]{1,2}
            let b=slice[int32]{3,4}
            let c=array[int32]{5,6}
            }
            """;
        var result = GSharpFormatter.Format(SourceText.From(source));
        Assert.Empty(result.Diagnostics);
        var text = result.Text!.ToString();
        Assert.Contains("readonly slice[string?]?", text);
        Assert.Contains("List[readonly slice[int32]]", text);
        Assert.Contains("readonly slice[int32]{1, 2}", text);
        Assert.Contains("slice[int32]{3, 4}", text);
        Assert.Contains("array[int32]{5, 6}", text);
        Assert.Equal(text, GSharpFormatter.Format(result.Text!).Text!.ToString());
    }
}
