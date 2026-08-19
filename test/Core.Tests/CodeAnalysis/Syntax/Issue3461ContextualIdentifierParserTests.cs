// <copyright file="Issue3461ContextualIdentifierParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>Issue #3461: contextual operators stay contextual only at grammar roots.</summary>
public sealed class Issue3461ContextualIdentifierParserTests
{
    [Theory]
    [InlineData("nameof")]
    [InlineData("checked")]
    [InlineData("unchecked")]
    [InlineData("typeof")]
    [InlineData("sizeof")]
    [InlineData("make")]
    [InlineData("init")]
    public void ContextualOperatorName_AfterMemberAccess_ParsesAsCall(string name)
    {
        SyntaxTree tree = SyntaxTree.Parse(SourceText.From(
            $$"""
            class C {
                func Run(c C) {
                    c.{{name}}()
                }
            }
            """));

        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void AllocatedParameterLambdaTypeParameterAndPatternNames_Parse()
    {
        SyntaxTree tree = SyntaxTree.Parse(SourceText.From(
            """
            class C[in_ any, out_ any] {
                func Run(params_ int32, scoped_ int32, ref_ int32, out_ int32, in_ int32) int32 {
                    let f (int32) -> int32 = (params_ int32) -> params_
                    if params_ is int32 when_ {
                        return f(when_)
                    }

                    return 0
                }
            }
            """));

        Assert.Empty(tree.Diagnostics);
    }
}
