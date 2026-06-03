// <copyright file="DocumentationValidatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Documentation;

/// <summary>
/// Tests the post-binding documentation validation pass and its emit wiring.
/// </summary>
public class DocumentationValidatorTests
{
    [Fact]
    public void FloatingDocComment_ProducesGS0227()
    {
        var result = Compile(
            """
            package Lib

            /// Floating.

            func Foo() {}
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0227");
    }

    [Fact]
    public void ParamMismatch_ProducesGS0229()
    {
        var result = Compile(
            """
            package Lib

            /// Adds one number.
            /// @param b wrong parameter
            func Add(a int32) int32 {
                return a
            }
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0229" && d.Message.Contains("'b'") && d.Message.Contains("'Add'"));
    }

    [Fact]
    public void ValidParamNames_DoNotProduceGS0229()
    {
        var result = Compile(
            """
            package Lib

            /// Adds one number.
            /// @param a value
            func Add(a int32) int32 {
                return a
            }
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0229");
    }

    [Fact]
    public void MissingDocs_WhenOptedIn_ProduceGS0228()
    {
        var result = Compile(
            """
            package Lib

            func Foo() {}
            """,
            warnOnMissingDocs: true);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0228" && d.Message.Contains("'Foo'"));
    }

    [Fact]
    public void UnknownDocTag_ProducesGS0231()
    {
        var result = Compile(
            """
            package Lib

            /// Gets a value.
            /// @return the value
            func Get() int32 {
                return 0
            }
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0231" && d.Message.Contains("'@return'"));
    }

    [Fact]
    public void KnownDocTag_DoesNotProduceGS0231()
    {
        var result = Compile(
            """
            package Lib

            /// Gets a value.
            /// @returns the value
            func Get() int32 {
                return 0
            }
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0231");
    }

    private static EmitResult Compile(string source, bool warnOnMissingDocs = false)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree)
        {
            WarnOnMissingDocumentation = warnOnMissingDocs,
        };

        using var peStream = new MemoryStream();
        return compilation.Emit(peStream);
    }
}
