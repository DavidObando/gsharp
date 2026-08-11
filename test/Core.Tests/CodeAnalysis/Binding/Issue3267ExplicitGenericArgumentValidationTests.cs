// <copyright file="Issue3267ExplicitGenericArgumentValidationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3267: explicitly substituted generic parameter types must be
/// validated like their non-generic equivalents before invalid IL is emitted.
/// </summary>
public class Issue3267ExplicitGenericArgumentValidationTests
{
    public static TheoryData<string, string, string> InvalidCalls => new()
    {
        {
            """
            func Id[T](value T) T -> value
            Id[int32]("wrong")
            """,
            "GS0154",
            "\"wrong\""
        },
        {
            """
            class Box {
                func Id[T](value T) T -> value
            }
            Box().Id[int32]("wrong")
            """,
            "GS0154",
            "\"wrong\""
        },
        {
            """
            func (self string) IdExt[T](value T) T -> value
            "receiver".IdExt[int32]("wrong")
            """,
            "GS0154",
            "\"wrong\""
        },
        {
            """
            class Box[T](value T) {
                prop Value T { get -> value }
            }
            Box[int32]("wrong").Value
            """,
            "GS0154",
            "\"wrong\""
        },
        {
            """
            func First[T](first T, second T) T -> first
            First[int32](1, "wrong")
            """,
            "GS0154",
            "\"wrong\""
        },
        {
            """
            func Take[T](values []T) { }
            Take[int32]([]string{"wrong"})
            """,
            "GS0154",
            "[]string{\"wrong\"}"
        },
        {
            """
            func (self string) TakeExt[T](values []T) { }
            "receiver".TakeExt[int32]([]string{"wrong"})
            """,
            "GS0154",
            "[]string{\"wrong\"}"
        },
    };

    public static TheoryData<string, object> ValidCalls => new()
    {
        {
            """
            func Id[T](value T) T -> value
            Id[int32](41)
            """,
            41
        },
        {
            """
            func Id[T](value T) T -> value
            Id[object]("explicit-object")
            """,
            "explicit-object"
        },
        {
            """
            func Id[T](value T) T -> value
            Id[object](41)
            """,
            41
        },
        {
            """
            func Id[T](value T) T -> value
            Id[int64](42)
            """,
            42L
        },
        {
            """
            func Id[T](value T) T -> value
            Id("inferred-string")
            """,
            "inferred-string"
        },
        {
            """
            func Keep[T class](value T) T -> value
            Keep[string]("constrained")
            """,
            "constrained"
        },
        {
            """
            func First[T](first T, second T) T -> first
            First[int64](43, 44)
            """,
            43L
        },
        {
            """
            class Box {
                func Id[T](value T) T -> value
            }
            Box().Id[int64](45)
            """,
            45L
        },
        {
            """
            func (self string) IdExt[T](value T) T -> value
            "receiver".IdExt[int64](46)
            """,
            46L
        },
        {
            """
            class Box[T](value T) {
                prop Value T { get -> value }
            }
            Box[int64](47).Value
            """,
            47L
        },
    };

    [Theory]
    [MemberData(nameof(InvalidCalls))]
    public void ExplicitGenericArgumentMismatch_ReportsAtArgument(string source, string expectedId, string expectedSpan)
    {
        var diagnostic = Assert.Single(GetErrors(source));
        var expectedStart = source.IndexOf(expectedSpan, StringComparison.Ordinal);

        Assert.Equal(expectedId, diagnostic.Id);
        Assert.Equal(expectedStart, diagnostic.Location.Span.Start);
        Assert.Equal(expectedSpan.Length, diagnostic.Location.Span.Length);
        Assert.Equal(expectedSpan, diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void ExplicitGenericInstanceArgumentMismatch_UsesCallArgumentContract()
    {
        const string source = """
            class Box {
                func Id[T](value T) T -> value
            }
            Box().Id[int32]("wrong")
            """;

        var diagnostic = Assert.Single(GetErrors(source));

        Assert.Equal(
            "Parameter 'value' requires a value of type 'int32' but was given a value of type 'string'.",
            diagnostic.Message);
    }

    [Theory]
    [MemberData(nameof(ValidCalls))]
    public void CompatibleGenericArguments_CompileAndRun(string source, object expected)
    {
        var result = EmittedOracle.Evaluate(source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Value);
    }

    private static IReadOnlyList<Diagnostic> GetErrors(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream).Diagnostics
            .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
            .ToArray();
    }
}
