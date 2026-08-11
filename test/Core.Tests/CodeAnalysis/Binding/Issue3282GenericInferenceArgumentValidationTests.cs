// <copyright file="Issue3282GenericInferenceArgumentValidationTests.cs" company="GSharp">
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
/// Issue #3282: arguments must be checked against the type inferred from
/// earlier arguments before a generic call is emitted.
/// </summary>
public class Issue3282GenericInferenceArgumentValidationTests
{
    public static TheoryData<string, string, string, string> InvalidCalls => new()
    {
        {
            """
            func Show[T](a T, b T) { }
            Show(131, "str")
            """,
            """
            func Show(a int32, b int32) { }
            Show(131, "str")
            """,
            "GS0154",
            "\"str\""
        },
        {
            """
            func Show[T](a T, b T) { }
            Show("str", 131)
            """,
            """
            func Show(a string, b string) { }
            Show("str", 131)
            """,
            "GS0154",
            "131"
        },
        {
            """
            func Show[T](a T, b T, c T) { }
            Show(131, 132, "str")
            """,
            """
            func Show(a int32, b int32, c int32) { }
            Show(131, 132, "str")
            """,
            "GS0154",
            "\"str\""
        },
        {
            """
            func Show[T](source T, later []T) { }
            Show(131, []string{"str"})
            """,
            """
            func Show(source int32, later []int32) { }
            Show(131, []string{"str"})
            """,
            "GS0154",
            "[]string{\"str\"}"
        },
        {
            """
            func Show[T](source T, later T?) { }
            Show(131, "str")
            """,
            """
            func Show(source int32, later int32?) { }
            Show(131, "str")
            """,
            "GS0154",
            "\"str\""
        },
        {
            """
            func Show[T](source T, later (T, T)) { }
            Show(131, ("str", "other"))
            """,
            """
            func Show(source int32, later (int32, int32)) { }
            Show(131, ("str", "other"))
            """,
            "GS0154",
            "(\"str\", \"other\")"
        },
        {
            """
            struct Mark { var V int32 }
            struct Other { }
            func Show[T](a T, b T) { }
            Show(Mark{V: 1}, Other{})
            """,
            """
            struct Mark { var V int32 }
            struct Other { }
            func Show(a Mark, b Mark) { }
            Show(Mark{V: 1}, Other{})
            """,
            "GS0154",
            "Other{}"
        },
        {
            """
            class Box {
                func Show[T](a T, b T) { }
            }
            Box().Show(131, "str")
            """,
            """
            class Box {
                func Show(a int32, b int32) { }
            }
            Box().Show(131, "str")
            """,
            "GS0155",
            "\"str\""
        },
        {
            """
            func (self string) Show[T](a T, b T) { }
            "receiver".Show(131, "str")
            """,
            """
            func (self string) Show(a int32, b int32) { }
            "receiver".Show(131, "str")
            """,
            "GS0155",
            "\"str\""
        },
    };

    public static TheoryData<string, string> ValidCalls => new()
    {
        {
            """
            import System
            func Show[T](a T, b T) {
                Console.WriteLine([]T{a}.GetType())
                Console.WriteLine(a)
                Console.WriteLine(b)
            }
            Show(131, 132)
            """,
            "System.Int32[]\n131\n132\n"
        },
        {
            """
            import System
            func Show[T](a T, b T) {
                Console.WriteLine([]T{a}.GetType())
                Console.WriteLine(a)
                Console.WriteLine(b)
            }
            Show("str", "other")
            """,
            "System.String[]\nstr\nother\n"
        },
        {
            """
            import System
            func Show[T](source T, slice []T) {
                Console.WriteLine([]T{source}.GetType())
                Console.WriteLine(source)
                Console.WriteLine(slice[0])
            }
            Show(131, []int32{132})
            """,
            "System.Int32[]\n131\n132\n"
        },
        {
            """
            import System
            func Show[T](a T, b T) {
                Console.WriteLine([]T{a}.GetType())
                Console.WriteLine(a)
                Console.WriteLine(b)
            }
            Show[object](131, "str")
            """,
            "System.Object[]\n131\nstr\n"
        },
        {
            """
            import System
            func Plain(v object) {
                Console.WriteLine(v.GetType())
                Console.WriteLine(v)
            }
            Plain(131)
            Plain("str")
            """,
            "System.Int32\n131\nSystem.String\nstr\n"
        },
    };

    [Theory]
    [MemberData(nameof(InvalidCalls))]
    public void ConflictingInferredArgument_MatchesNonGenericDiagnostic(
        string genericSource,
        string nonGenericSource,
        string expectedId,
        string expectedSpan)
    {
        AssertDiagnostic(genericSource, expectedId, expectedSpan);
        AssertDiagnostic(nonGenericSource, expectedId, expectedSpan);
    }

    [Theory]
    [MemberData(nameof(ValidCalls))]
    public void CompatibleInferredArguments_CompileAndRun(string source, string expectedOutput)
    {
        var result = EmittedOracle.Evaluate(source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.ExitCode);
        Assert.Null(result.UnhandledException);
        Assert.Equal(expectedOutput, result.Output);
    }

    [Fact]
    public void ConflictingInstanceInference_ReportsNoConversion()
    {
        const string source = """
            class Box {
                func Show[T](a T, b T) { }
            }
            Box().Show(131, "str")
            """;

        var diagnostic = Assert.Single(GetErrors(source));

        Assert.Equal(
            "Cannot convert type 'string' to 'int32'.",
            diagnostic.Message);
    }

    private static void AssertDiagnostic(string source, string expectedId, string expectedSpan)
    {
        var diagnostic = Assert.Single(GetErrors(source));
        var expectedStart = source.LastIndexOf(expectedSpan, StringComparison.Ordinal);

        Assert.Equal(expectedId, diagnostic.Id);
        Assert.Equal(expectedStart, diagnostic.Location.Span.Start);
        Assert.Equal(expectedSpan.Length, diagnostic.Location.Span.Length);
        Assert.Equal(expectedSpan, diagnostic.Location.Text.ToString(diagnostic.Location.Span));
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
