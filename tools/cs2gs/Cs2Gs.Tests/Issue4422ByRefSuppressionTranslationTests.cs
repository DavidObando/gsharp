// <copyright file="Issue4422ByRefSuppressionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;
using GCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4422: a C# by-reference argument written with <c>!</c>
/// (<c>StackPush(ref base.runstack!, …)</c>, the <c>[GeneratedRegex]</c>
/// runner's shape) silences a nullability warning. G# cannot spell <c>!</c> on
/// a variable, so cs2gs drops it and gsc reports GS0612 there instead. cs2gs
/// carries the C# author's suppression across with ADR-0175, scoped to the one
/// statement the <c>!</c> covered: the block form around an ordinary
/// statement, the annotation on a local declaration (a block would hide the
/// local), and the member annotation for an expression-bodied member, whose
/// body is that one expression. Each translation is compiled, and a
/// suppressed GS0612 must not reach the result even though it would otherwise.
/// </summary>
public class Issue4422ByRefSuppressionTranslationTests
{
    private const string Prelude = @"
#nullable enable
public class Runner
{
    protected int[]? runstack = new int[] { 0, 0 };

    private static void Push(ref int[] stack, int value) { stack[0] = value; }

    private static int Take(ref int[] stack) => stack.Length;
";

    [Fact]
    public void Statement_IsWrappedInTheBlockForm_AndCompilesWithoutGS0612()
    {
        string printed = Translate(Prelude + @"
    public void Go()
    {
        Push(ref runstack!, 1);
        Push(ref runstack!, 2);
    }
}
");

        Assert.Equal(2, CountOccurrences(printed, "@SuppressDiagnostic(\"GS0612\") {"));
        AssertCompilesWithoutGS0612(printed);
    }

    [Fact]
    public void LocalDeclaration_CarriesTheAnnotation_AndStaysVisible()
    {
        string printed = Translate(Prelude + @"
    public int Go()
    {
        var length = Take(ref runstack!);
        return length + 1;
    }
}
");

        Assert.Matches("@SuppressDiagnostic\\(\"GS0612\"\\) (let|var) length", printed);
        Assert.DoesNotContain("@SuppressDiagnostic(\"GS0612\") {", printed, StringComparison.Ordinal);
        AssertCompilesWithoutGS0612(printed);
    }

    [Fact]
    public void ExpressionBodiedMember_CarriesTheAnnotation()
    {
        string printed = Translate(Prelude + @"
    public int Go() => Take(ref runstack!);
}
");

        Assert.Equal(1, CountOccurrences(printed, "@SuppressDiagnostic(\"GS0612\")"));
        Assert.DoesNotContain("@SuppressDiagnostic(\"GS0612\") {", printed, StringComparison.Ordinal);
        AssertCompilesWithoutGS0612(printed);
    }

    [Fact]
    public void LambdaBody_IsCoveredByItsEnclosingStatementOnly()
    {
        string printed = Translate(Prelude + @"
    public void Go()
    {
        System.Action push = () => Push(ref runstack!, 3);
        push();
        Push(ref runstack!, 4);
    }
}
");

        Assert.Contains("@SuppressDiagnostic(\"GS0612\") let push", printed, StringComparison.Ordinal);
        Assert.Equal(2, CountOccurrences(printed, "@SuppressDiagnostic(\"GS0612\")"));
        AssertCompilesWithoutGS0612(printed);
    }

    [Fact]
    public void WithoutTheBang_NoSuppressionIsEmitted_AndGS0612Surfaces()
    {
        // Anti-vacuity: the suppression is the C# author's, not cs2gs's. An
        // argument the C# did not silence keeps its warning.
        string printed = Translate(@"
#nullable enable
public class Runner
{
    protected int[]? runstack = new int[] { 0, 0 };

    private static void Push(ref int[]? stack, int value) { }

    private static void Strict(ref int[] stack) { }

    public void Go()
    {
#pragma warning disable CS8601
        Strict(ref runstack);
#pragma warning restore CS8601
        Push(ref runstack!, 1);
    }
}
");

        Assert.DoesNotContain("@SuppressDiagnostic", printed, StringComparison.Ordinal);
        var diagnostics = Compile(printed);
        Assert.Single(diagnostics, d => d.Id == "GS0612");
    }

    [Fact]
    public void CSharpNullabilityPragmaRegion_BecomesGS0612OnTheMethod()
    {
        string printed = Translate(Prelude + @"
#pragma warning disable CS8601
    public void Go()
    {
        Push(ref runstack, 1);
    }
#pragma warning restore CS8601
}
");

        Assert.Contains("@SuppressDiagnostic(\"GS0612\")", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("@SuppressDiagnostic(\"GS0612\") {", printed, StringComparison.Ordinal);
        AssertCompilesWithoutGS0612(printed);
    }

    private static void AssertCompilesWithoutGS0612(string printed)
    {
        var diagnostics = Compile(printed);
        Assert.DoesNotContain(diagnostics, d => d.IsError);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0612");
    }

    private static System.Collections.Immutable.ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Compile(string printed)
    {
        var compilation = new GCompilation(SyntaxTree.Parse(SourceText.From(printed))) { IsLibrary = true };
        using var stream = new MemoryStream();
        var result = compilation.Emit(stream);
        Assert.True(
            result.Success,
            "Translated G# must compile:\n" + string.Join("\n", result.Diagnostics.Select(d => d.ToString())) + "\n\nPrinted:\n" + printed);
        return result.Diagnostics;
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        var count = 0;
        var index = 0;
        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Program.cs", source) });

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
