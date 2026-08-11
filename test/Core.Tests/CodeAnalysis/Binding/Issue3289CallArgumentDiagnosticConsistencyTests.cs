// <copyright file="Issue3289CallArgumentDiagnosticConsistencyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issues #3289 and #3312: rejected call arguments use the same GS0154
/// contract across free, instance, extension, and shared calls.
/// </summary>
public sealed class Issue3289CallArgumentDiagnosticConsistencyTests
{
    public static TheoryData<string, string, int, int, int, int, string> RejectedCalls => new()
    {
        {
            "free explicit-generic control",
            """
            import System
            func Take(value ValueType) { }
            Take("wrong")
            """,
            2,
            5,
            2,
            12,
            "value"
        },
        {
            "free explicit generic",
            """
            import System
            func Take[T](value T) { }
            Take[ValueType]("wrong")
            """,
            2,
            16,
            2,
            23,
            "value"
        },
        {
            "instance explicit-generic control",
            """
            import System
            class Runner { func Take(value ValueType) { } }
            Runner().Take("wrong")
            """,
            2,
            14,
            2,
            21,
            "value"
        },
        {
            "instance explicit generic",
            """
            import System
            class Runner { func Take[T](value T) { } }
            Runner().Take[ValueType]("wrong")
            """,
            2,
            25,
            2,
            32,
            "value"
        },
        {
            "extension explicit-generic control",
            """
            import System
            func (self string) Take(value ValueType) { }
            "receiver".Take("wrong")
            """,
            2,
            16,
            2,
            23,
            "value"
        },
        {
            "extension explicit generic",
            """
            import System
            func (self string) Take[T](value T) { }
            "receiver".Take[ValueType]("wrong")
            """,
            2,
            27,
            2,
            34,
            "value"
        },
        {
            "shared explicit-generic control",
            """
            import System
            class Runner { shared { func Take(value ValueType) { } } }
            Runner.Take("wrong")
            """,
            2,
            12,
            2,
            19,
            "value"
        },
        {
            "shared explicit generic",
            """
            import System
            class Runner { shared { func Take[T](value T) { } } }
            Runner.Take[ValueType]("wrong")
            """,
            2,
            23,
            2,
            30,
            "value"
        },
        {
            "free inference control",
            """
            import System
            func Take(expected ValueType, actual ValueType) { }
            let expected ValueType = 42
            Take(expected, "wrong")
            """,
            3,
            15,
            3,
            22,
            "actual"
        },
        {
            "free inference",
            """
            import System
            func Take[T](expected T, actual T) { }
            let expected ValueType = 42
            Take(expected, "wrong")
            """,
            3,
            15,
            3,
            22,
            "actual"
        },
        {
            "instance inference control",
            """
            import System
            class Runner { func Take(expected ValueType, actual ValueType) { } }
            let expected ValueType = 42
            Runner().Take(expected, "wrong")
            """,
            3,
            24,
            3,
            31,
            "actual"
        },
        {
            "instance inference",
            """
            import System
            class Runner { func Take[T](expected T, actual T) { } }
            let expected ValueType = 42
            Runner().Take(expected, "wrong")
            """,
            3,
            24,
            3,
            31,
            "actual"
        },
        {
            "extension inference control",
            """
            import System
            func (self string) Take(expected ValueType, actual ValueType) { }
            let expected ValueType = 42
            "receiver".Take(expected, "wrong")
            """,
            3,
            26,
            3,
            33,
            "actual"
        },
        {
            "extension inference",
            """
            import System
            func (self string) Take[T](expected T, actual T) { }
            let expected ValueType = 42
            "receiver".Take(expected, "wrong")
            """,
            3,
            26,
            3,
            33,
            "actual"
        },
        {
            "shared inference control",
            """
            import System
            class Runner { shared { func Take(expected ValueType, actual ValueType) { } } }
            let expected ValueType = 42
            Runner.Take(expected, "wrong")
            """,
            3,
            22,
            3,
            29,
            "actual"
        },
        {
            "shared inference",
            """
            import System
            class Runner { shared { func Take[T](expected T, actual T) { } } }
            let expected ValueType = 42
            Runner.Take(expected, "wrong")
            """,
            3,
            22,
            3,
            29,
            "actual"
        },
    };

    public static TheoryData<string, string, int, int, int, int> ExplicitOnlyRejectedCalls => new()
    {
        {
            "free",
            """
            func Take(value int32) { }
            Take(3.14)
            """,
            1,
            5,
            1,
            9
        },
        {
            "instance",
            """
            class Runner { func Take(value int32) { } }
            Runner().Take(3.14)
            """,
            1,
            14,
            1,
            18
        },
        {
            "extension",
            """
            func (self string) Take(value int32) { }
            "receiver".Take(3.14)
            """,
            1,
            16,
            1,
            20
        },
        {
            "shared",
            """
            class Runner { shared { func Take(value int32) { } } }
            Runner.Take(3.14)
            """,
            1,
            12,
            1,
            16
        },
    };

    [Theory]
    [MemberData(nameof(RejectedCalls))]
    public void RejectedArgument_UsesGs0154AtExactArgumentSpan(
        string _,
        string source,
        int startLine,
        int startCharacter,
        int endLine,
        int endCharacter,
        string parameterName)
    {
        var diagnostic = Assert.Single(GetErrors(source));

        Assert.Equal("GS0154", diagnostic.Id);
        Assert.Equal(
            $"Parameter '{parameterName}' requires a value of type 'System.ValueType' but was given a value of type 'string'.",
            diagnostic.Message);
        Assert.Equal(startLine, diagnostic.Location.StartLine);
        Assert.Equal(startCharacter, diagnostic.Location.StartCharacter);
        Assert.Equal(endLine, diagnostic.Location.EndLine);
        Assert.Equal(endCharacter, diagnostic.Location.EndCharacter);
        Assert.Equal("\"wrong\"", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Theory]
    [MemberData(nameof(ExplicitOnlyRejectedCalls))]
    public void ExplicitOnlyArgumentConversion_UsesGs0154AtExactArgumentSpan(
        string _,
        string source,
        int startLine,
        int startCharacter,
        int endLine,
        int endCharacter)
    {
        var diagnostic = Assert.Single(GetErrors(source));

        Assert.Equal("GS0154", diagnostic.Id);
        Assert.Equal(
            "Parameter 'value' requires a value of type 'int32' but was given a value of type 'float64'.",
            diagnostic.Message);
        Assert.Equal(startLine, diagnostic.Location.StartLine);
        Assert.Equal(startCharacter, diagnostic.Location.StartCharacter);
        Assert.Equal(endLine, diagnostic.Location.EndLine);
        Assert.Equal(endCharacter, diagnostic.Location.EndCharacter);
        Assert.Equal("3.14", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    private static IReadOnlyList<Diagnostic> GetErrors(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source, "Issue3289.gs"));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream).Diagnostics
            .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
            .ToArray();
    }
}
