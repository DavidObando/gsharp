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
PRAGMA_WARNING disable CS8601
        Strict(ref runstack);
PRAGMA_WARNING restore CS8601
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
PRAGMA_WARNING disable CS8601
    public void Go()
    {
        Push(ref runstack, 1);
    }
PRAGMA_WARNING restore CS8601
}
");

        Assert.Contains("@SuppressDiagnostic(\"GS0612\")", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("@SuppressDiagnostic(\"GS0612\") {", printed, StringComparison.Ordinal);
        AssertCompilesWithoutGS0612(printed);
    }

    [Theory]
    // `out var` in a condition: `v` is visible after the `if`.
    [InlineData(@"
    private static bool TryGet(ref int[] stack, out int v) { v = stack.Length; return true; }

    public int Go()
    {
        if (!TryGet(ref runstack!, out var v)) return 0;
        return v;
    }")]
    // `out var` in an expression statement: `n` is visible after it.
    [InlineData(@"
    private static void Fill(ref int[] stack, out int n) { n = stack.Length; }

    public int Go()
    {
        Fill(ref runstack!, out var n);
        return n;
    }")]
    // A pattern variable declared in a condition.
    [InlineData(@"
    public int Go()
    {
        if (Take(ref runstack!) is not int k) return 0;
        return k;
    }")]
    public void StatementDeclaringAVariableVisibleAfterIt_IsNotWrapped(string members)
    {
        // Review finding: a block around the statement hid the variable from
        // the statements after it. Such a statement is left unsuppressed (the
        // warning stays visible) rather than broken.
        string printed = Translate(Prelude + members + "\n}\n");

        Assert.DoesNotContain("@SuppressDiagnostic", printed, StringComparison.Ordinal);
        var diagnostics = Compile(printed);
        Assert.Contains(diagnostics, d => d.Id == "GS0612");
    }

    [Fact]
    public void UsingDeclaration_IsNotAnnotated()
    {
        // Review finding: `@SuppressDiagnostic(...) using let d` is rejected by
        // gsc, and a block would dispose `d` early. Left unsuppressed.
        string printed = Translate(Prelude + @"
    private static System.IO.MemoryStream Make(ref int[] stack) => new System.IO.MemoryStream(stack.Length);

    public long Go()
    {
        using var d = Make(ref runstack!);
        return d.Capacity;
    }
}
");

        Assert.DoesNotContain("@SuppressDiagnostic", printed, StringComparison.Ordinal);
        var diagnostics = Compile(printed);
        Assert.Contains(diagnostics, d => d.Id == "GS0612");
    }

    [Fact]
    public void MetadataCallee_GetsNoSuppression()
    {
        // Review finding: gsc never reports GS0612 at an imported callee, and
        // an unneeded block can hide a variable the statement declares.
        string printed = Translate(@"
#nullable enable
using System.Collections.Generic;
using System.Threading;

public class Cache
{
    private string? name;
    private Dictionary<string, int>? cache = new Dictionary<string, int>();

    public int Go(string k)
    {
        Interlocked.Exchange(ref name!, ""x"");
        if (!Volatile.Read(ref cache!).TryGetValue(k, out var v)) return 0;
        return v;
    }
}
");

        Assert.DoesNotContain("@SuppressDiagnostic", printed, StringComparison.Ordinal);
        AssertCompilesWithoutGS0612(printed);
    }

    [Fact]
    public void ThisInitializer_WrapsTheDelegationCall()
    {
        // Review finding: `: this(Take(ref x!))` was left unsuppressed. It
        // prints as the body's first statement `init(...)`, which gsc accepts
        // inside the block form, so the suppression covers just that call.
        string printed = Translate(@"
#nullable enable
public class Runner
{
    private static int[]? shared = new int[] { 1 };

    private static int Take(ref int[] stack) => stack.Length;

    public Runner(int n) { }

    public Runner() : this(Take(ref shared!)) { }
}
");

        Assert.Contains("@SuppressDiagnostic(\"GS0612\") {", printed, StringComparison.Ordinal);
        Assert.Matches(@"@SuppressDiagnostic\(""GS0612""\) \{\s*init\(Take\(&shared\)\)\s*\}", printed);
        AssertCompilesWithoutGS0612(printed);
    }

    [Fact]
    public void BaseInitializer_IsLeftUnsuppressed()
    {
        // `: base(...)` stays in the constructor header, where no block fits;
        // an annotation on the constructor would widen over its body.
        string printed = Translate(@"
#nullable enable
public class Base
{
    public Base(int n) { }
}

public class Runner : Base
{
    private static int[]? shared = new int[] { 1 };

    private static int Take(ref int[] stack) => stack.Length;

    public Runner() : base(Take(ref shared!)) { }
}
");

        Assert.DoesNotContain("@SuppressDiagnostic", printed, StringComparison.Ordinal);
        Assert.Contains(Compile(printed), d => d.Id == "GS0612");
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
        // The C# sources spell their pragma directives as PRAGMA_WARNING so this
        // file carries no literal nullability suppression (nullable_hygiene).
        source = source.Replace("PRAGMA_WARNING", "#" + "pragma warning", StringComparison.Ordinal);
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Program.cs", source) });

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
