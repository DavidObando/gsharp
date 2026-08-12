// <copyright file="Issue3355NullSeamBlockExpressionLoweringTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3355 replaces issue #1849's synthesized <c>__initN(__pN)</c>
/// helpers and issue #1731's double-evaluation fallback with native G# block
/// expressions at field/property and constructor-initializer seams.
/// </summary>
public class Issue3355NullSeamBlockExpressionLoweringTests
{
    [Fact]
    public void FieldInitializer_PatternScrutinee_UsesNativeBlock()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext("""
            namespace Demo
            {
                public sealed class A
                {
                    public int X;
                    public int Y;
                }

                public sealed class C
                {
                    private static A GetA() => new A { X = 1, Y = 2 };

                    private bool flag = GetA() is { X: 1, Y: 2 };
                }
            }
            """);

        Assert.Equal(2, CountOccurrences(printed, "GetA()"));
        Assert.Contains("private var flag bool = {", printed, StringComparison.Ordinal);
        Assert.Contains("let __spill", printed, StringComparison.Ordinal);
        AssertNoHelperOrGap(printed, context);
    }

    [Fact]
    public void GetOnlyPropertyInitializer_PatternScrutinee_UsesNativeBlock()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext("""
            namespace Demo
            {
                public sealed class A
                {
                    public int X;
                }

                public sealed class C
                {
                    private static int calls;

                    private static A GetA()
                    {
                        calls++;
                        return new A { X = 1 };
                    }

                    public bool P { get; } = GetA() is { X: > 0 };

                    public int Run() => (P ? 100 : 0) + calls;
                }
            }
            """);

        Assert.Equal(2, CountOccurrences(printed, "GetA()"));
        Assert.Contains("P = {", printed, StringComparison.Ordinal);
        Assert.Contains("let __spill", printed, StringComparison.Ordinal);
        AssertNoHelperOrGap(printed, context);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "C().Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(101, result.Value);
    }

    [Fact]
    public void StaticFieldAndPropertyInitializers_KeepStaticContext()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext("""
            namespace Demo
            {
                public sealed class A
                {
                    public int X;
                }

                public sealed class C
                {
                    private static int calls;

                    private static A GetA()
                    {
                        calls++;
                        return new A { X = 1 };
                    }

                    private static bool flag = GetA() is { X: 1 };
                    public static bool P { get; } = GetA() is { X: > 0 };

                    public static int Run() =>
                        (flag ? 100 : 0) + (P ? 100 : 0) + calls;
                }
            }
            """);

        Assert.Equal(3, CountOccurrences(printed, "GetA()"));
        Assert.True(CountOccurrences(printed, "let __spill") >= 2, printed);
        AssertNoHelperOrGap(printed, context);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "C.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(202, result.Value);
    }

    [Fact]
    public void BaseConstructorNamedArgument_UsesNativeBlock()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext("""
            namespace Demo
            {
                public sealed class A
                {
                    public int X;
                    public int Y;
                }

                public class Base
                {
                    public Base(bool flag) { }
                }

                public sealed class Derived : Base
                {
                    private static A GetA() => new A { X = 1, Y = 2 };

                    public Derived() : base(flag: GetA() is { X: 1, Y: 2 }) { }
                }
            }
            """);

        Assert.Equal(2, CountOccurrences(printed, "GetA()"));
        Assert.Contains(": base(flag: {", printed, StringComparison.Ordinal);
        Assert.Contains("let __spill", printed, StringComparison.Ordinal);
        AssertNoHelperOrGap(printed, context);
    }

    [Fact]
    public void ThisConstructorArgument_UsesNativeBlockAndKeepsParametersInScope()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext("""
            namespace Demo
            {
                public sealed class A
                {
                    public int X;
                    public int Y;
                }

                public sealed class C
                {
                    public C(bool flag) { }

                    private static A GetA() => new A { X = 1, Y = 2 };

                    public C(int expected)
                        : this(GetA() is { X: > 0, Y: var y } && y == expected)
                    {
                    }
                }
            }
            """);

        Assert.Contains("init({", printed, StringComparison.Ordinal);
        Assert.Contains("let __spill", printed, StringComparison.Ordinal);
        Assert.Contains("expected", printed, StringComparison.Ordinal);
        AssertNoHelperOrGap(printed, context);
    }

    [Fact]
    public void RefConstructorArgument_KeepsAddressOutsideNativeBlock()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext("""
            namespace Demo
            {
                public sealed class A
                {
                    public int X;
                    public int Y;
                }

                public class Base
                {
                    public Base(ref bool value)
                    {
                        value = true;
                    }
                }

                public sealed class Derived : Base
                {
                    private static int calls;
                    private static bool whenTrue;
                    private static bool whenFalse;

                    private static A GetA()
                    {
                        calls++;
                        return new A { X = 1, Y = 2 };
                    }

                    public Derived()
                        : base(ref (GetA() is { X: 1, Y: 2 } ? ref whenTrue : ref whenFalse))
                    {
                    }

                    public int Run() =>
                        calls * 100 + (whenTrue ? 10 : 0) + (whenFalse ? 1 : 0);
                }
            }
            """);

        Assert.Equal(2, CountOccurrences(printed, "GetA()"));
        Assert.Contains(": base(&{", printed, StringComparison.Ordinal);
        Assert.Contains("let __spill", printed, StringComparison.Ordinal);
        AssertNoHelperOrGap(printed, context);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Derived().Run()");
        Assert.False(
            result.Diagnostics.Any(diagnostic => diagnostic.IsError),
            string.Join(Environment.NewLine, result.Diagnostics) + Environment.NewLine + printed);
        Assert.Null(result.UnhandledException);
        Assert.Equal(110, result.Value);
    }

    [Fact]
    public void NestedNullSeamOperand_UsesOnlyInScopeSpillLocals()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext("""
            namespace Demo
            {
                public sealed class C
                {
                    private static int[] Y = new int[] { 1, 2, 3, 4, 5 };
                    private static int Z() => 1;
                    private const int a = 3;

                    private bool flag = Y[Z()..a] is [1, 2];
                }
            }
            """);

        Assert.Contains("let __spill", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__p", printed, StringComparison.Ordinal);
        AssertNoHelperOrGap(printed, context);
    }

    [Fact]
    public void TranslatedFieldInitializer_BindsEmitsAndRunsOnce()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext("""
            namespace Demo
            {
                public sealed class A
                {
                    public int X;
                    public int Y;
                }

                public sealed class C
                {
                    private static int calls;

                    private static A GetA()
                    {
                        calls++;
                        return new A { X = 1, Y = 2 };
                    }

                    private bool flag = GetA() is { X: 1, Y: 2 };

                    public int Run() => (flag ? 100 : 0) + calls;
                }
            }
            """);

        AssertNoHelperOrGap(printed, context);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "C().Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(101, result.Value);
    }

    private static void AssertNoHelperOrGap(string printed, TranslationContext context)
    {
        Assert.DoesNotContain("__init", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__p", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        var count = 0;
        for (var index = haystack.IndexOf(needle, StringComparison.Ordinal);
            index >= 0;
            index = haystack.IndexOf(needle, index + needle.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }

    private static (string Printed, TranslationContext Context) TranslateUnitWithContext(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return (printed, context);
    }
}
