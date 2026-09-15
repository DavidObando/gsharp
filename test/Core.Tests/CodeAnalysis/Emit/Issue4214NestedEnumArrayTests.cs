// <copyright file="Issue4214NestedEnumArrayTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public class Issue4214NestedEnumArrayTests
{
    [Theory]
    [InlineData("[]Kind{Kind.First}")]
    [InlineData("[1]Kind{Kind.First}")]
    public void SymbolicArray_WidensToObjectWithoutChangingIdentity(string array)
    {
        var result = EmittedOracle.Evaluate($$"""
            enum Kind { First = 7 }
            func Forward(value object) object -> value
            let values = {{array}}
            let boxed object? = values
            let forwarded = Forward(values)
            "${boxed!!.GetType().Name}:${System.Object.ReferenceEquals(boxed, forwarded)}"
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal("Kind[]:True", result.Value);
    }

    [Fact]
    public void GenericArrayReturn_WidensToObjectWithoutChangingIdentity()
    {
        var result = EmittedOracle.Evaluate("""
            enum Kind { First = 7 }
            func Forward[T any](values []T) object -> values
            let values = []Kind{Kind.First}
            let forwarded = Forward(values)
            "${forwarded.GetType().Name}:${System.Object.ReferenceEquals(values, forwarded)}"
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal("Kind[]:True", result.Value);
    }

    [Theory]
    [InlineData("[]Kind{GetKind()}")]
    [InlineData("[1]Kind{GetKind()}")]
    [InlineData("[]string{GetText()}")]
    public void NestedAttributeArray_NonConstantElementRemainsRejected(string array)
    {
        var compilation = new Compilation(SyntaxTree.Parse($$"""
            import System
            enum Kind { First = 7 }
            func GetKind() Kind -> Kind.First
            func GetText() string -> "value"
            class ValueAttribute : Attribute {
                init(value object) {}
            }
            @Value([]object{ {{array}} })
            class Tagged {}
            """)) { IsLibrary = true };
        using var output = new MemoryStream();
        var result = compilation.Emit(output);
        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0202");
    }
}
