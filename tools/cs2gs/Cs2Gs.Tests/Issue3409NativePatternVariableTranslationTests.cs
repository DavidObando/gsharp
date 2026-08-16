// <copyright file="Issue3409NativePatternVariableTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0166 / issue #3409: C# <c>is</c> patterns with designations translate to
/// native G# pattern variables — same syntax, same names, no <c>__spillN</c>.
/// </summary>
public class Issue3409NativePatternVariableTranslationTests
{
    private const string Symbols = """
        namespace Demo
        {
            public class TypeSymbol { }
            public sealed class StructSymbol : TypeSymbol
            {
                public bool IsClass { get; init; }
            }
            public sealed class Receiver
            {
                public TypeSymbol? Type { get; init; }
            }
            public sealed class FieldAccess
            {
                public Receiver? Receiver { get; init; }
            }
        """;

    [Fact]
    public void IssueExample_NestedPropertyDesignationAndContinuation_TranslatesVerbatim()
    {
        string printed = Translate(Symbols + """
                public static class C
                {
                    public static bool HasHeapReceiver(FieldAccess fa)
                    {
                        if (fa.Receiver is { Type: StructSymbol s } && s.IsClass)
                        {
                            return false;
                        }

                        return true;
                    }
                }
            }
            """);

        Assert.Contains("if fa.Receiver is { Type: StructSymbol s } && s.IsClass {", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("as StructSymbol", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void DeclarationPattern_KeepsNameThroughConjunctsAndBody()
    {
        string printed = Translate("""
            namespace Demo
            {
                public class Base { }
                public sealed class Candidate : Base
                {
                    public int Value;
                }

                public static class C
                {
                    private static Base Get(Base value) => value;

                    public static int Read(Base value)
                    {
                        if (Get(value) is Candidate candidate && candidate.Value > 0)
                        {
                            return candidate.Value;
                        }

                        return 0;
                    }
                }
            }
            """);

        Assert.Contains("if C.Get(value) is Candidate candidate && candidate.Value > 0 {", printed, StringComparison.Ordinal);
        Assert.Contains("return candidate.Value", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NegatedGuard_LowersToBangIsAndLeaksTheVariable()
    {
        string printed = Translate("""
            namespace Demo
            {
                public static class C
                {
                    public static int Length(object value)
                    {
                        if (value is not string text)
                        {
                            return -1;
                        }

                        return text.Length;
                    }

                    public static int Length2(object value)
                    {
                        if (!(value is string text) || text.Length == 0)
                        {
                            return -1;
                        }

                        return text.Length;
                    }
                }
            }
            """);

        Assert.Contains("if !(value is string text) {", printed, StringComparison.Ordinal);
        Assert.Contains("if !(value is string text) || text.Length == 0 {", printed, StringComparison.Ordinal);
        Assert.Contains("return text.Length", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("as string", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("== nil", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ValueTypeAndEmptyPropertyPatterns_TranslateNatively()
    {
        string printed = Translate("""
            namespace Demo
            {
                public static class C
                {
                    public static int Sum(object a, int? b, string? c)
                    {
                        int total = 0;
                        if (a is int n)
                        {
                            total += n;
                        }

                        if (b is { } bound)
                        {
                            total += bound;
                        }

                        if (c is { Length: > 0 } text)
                        {
                            total += text.Length;
                        }

                        return total;
                    }
                }
            }
            """);

        Assert.Contains("if a is int32 n {", printed, StringComparison.Ordinal);
        Assert.Contains("if b is { } bound {", printed, StringComparison.Ordinal);
        Assert.Contains("if c is { Length: > 0 } text {", printed, StringComparison.Ordinal);
        Assert.Contains("total += n", printed, StringComparison.Ordinal);
        Assert.Contains("total += bound", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ConditionalAndBooleanExpressions_ScopeVariablesNatively()
    {
        string printed = Translate("""
            namespace Demo
            {
                public static class C
                {
                    public static string Label(object value) =>
                        value is string s && s.Length > 0 ? s : "none";

                    public static bool Long(object value) => value is string s && s.Length > 3;

                    public static int Count(System.Collections.Generic.Queue<object> queue)
                    {
                        int total = 0;
                        while (queue.Count > 0 && queue.Dequeue() is int n)
                        {
                            total += n;
                        }

                        return total;
                    }
                }
            }
            """);

        Assert.Contains("if value is string s && s.Length > 0 { s } else { \"none\" }", printed, StringComparison.Ordinal);
        Assert.Contains("bool -> value is string s && s.Length > 3", printed, StringComparison.Ordinal);
        Assert.Contains("while queue.Count > 0 && queue.Dequeue() is int32 n {", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("while let", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__scrutinee", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ReassignedBinder_KeepsTheMutableFallback()
    {
        string printed = Translate("""
            namespace Demo
            {
                public static class C
                {
                    public static int Read(object value)
                    {
                        if (value is int n)
                        {
                            n += 1;
                            return n;
                        }

                        return 0;
                    }
                }
            }
            """);

        Assert.DoesNotContain("if value is int32 n {", printed, StringComparison.Ordinal);
        Assert.Contains("var n int32", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void CapturedPatternVariable_TranslatesNatively()
    {
        // C# definitely assigns `t` after `if (!(x is string t)) { t = ...; }`
        // hmm — but that reassigns. The one valid C# shape G#'s structural
        // regions do not cover is a variable read after an `if` whose exiting
        // branch is chosen by an `else if` chain: the outer condition's other
        // path reaches the read too, so C# rejects it as well. The remaining
        // divergence is a `when` guard variable read from a later switch
        // section via `goto case`, which is out of scope. Instead, verify the
        // guard: a lambda captures the variable inside the region (native
        // stays valid), and a mutable binder falls back (covered above).
        string printed = Translate("""
            namespace Demo
            {
                public static class C
                {
                    public static System.Func<string> Read(object value)
                    {
                        if (value is string t)
                        {
                            return () => t + "!";
                        }

                        return () => "";
                    }
                }
            }
            """);

        Assert.Contains("if value is string t {", printed, StringComparison.Ordinal);
        Assert.Contains("t + \"!\"", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void VarDesignation_KeepsTheSubstitutionLowering()
    {
        string printed = Translate("""
            namespace Demo
            {
                public sealed class Point
                {
                    public int X { get; init; }
                }

                public static class C
                {
                    public static int Read(object value)
                    {
                        if (value is Point { X: var x })
                        {
                            return x;
                        }

                        return 0;
                    }
                }
            }
            """);

        Assert.DoesNotContain("var x }", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity != TranslationSeverity.Info);
        TranslationTestValidation.AssertBinds(rendered);
        return rendered;
    }
}
