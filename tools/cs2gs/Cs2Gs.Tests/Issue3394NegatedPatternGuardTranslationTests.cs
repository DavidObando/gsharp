// <copyright file="Issue3394NegatedPatternGuardTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3394: a negated pattern binder behind an earlier short-circuit guard
/// must keep evaluation order and remain in scope after an exiting guard.
/// </summary>
public class Issue3394NegatedPatternGuardTranslationTests
{
    [Fact]
    public void PriorOrGuard_RunsBeforePatternReceiver_AndBinderSurvives()
    {
        const string source = @"
namespace Demo
{
    public sealed class Candidate
    {
        public bool IsGeneric;
        public int Value;
    }

    public static class C
    {
        public static bool TryRead(Candidate[] candidates, out int value)
        {
            value = 0;
            if (candidates.Length != 1
                || candidates[0] is not { IsGeneric: false } candidate)
            {
                return false;
            }

            value = candidate.Value;
            return true;
        }
    }
}
";

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string rendered = GSharpPrinter.Print(unit);

        int prefixGuard = rendered.IndexOf("if candidates.Length != 1", StringComparison.Ordinal);
        int candidateHoist = rendered.IndexOf("let candidate", StringComparison.Ordinal);
        Assert.True(prefixGuard >= 0 && candidateHoist > prefixGuard, rendered);
        Assert.DoesNotContain("let __spill", rendered, StringComparison.Ordinal);
        Assert.Contains("candidate.Value", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void LogicalNotAroundDeclarationPattern_HoistsSurvivingBinder()
    {
        const string source = @"
namespace Demo
{
    public class Base { }
    public sealed class Candidate : Base
    {
        public int Value;
    }

    public static class C
    {
        public static int Read(Base value)
        {
            if (!(value is Candidate candidate))
            {
                return 0;
            }

            return candidate.Value;
        }
    }
}
";

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string rendered = GSharpPrinter.Print(unit);

        Assert.Contains("let candidate Candidate?", rendered, StringComparison.Ordinal);
        Assert.Contains("return candidate.Value", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void MultipleNegatedPatterns_HoistEverySurvivingBinder()
    {
        const string source = @"
namespace Demo
{
    public class Base { }
    public sealed class Left : Base { public int Value; }
    public sealed class Right : Base { public int Value; }

    public static class C
    {
        public static int Read(Base left, Base right)
        {
            if (left is not Left typedLeft || right is not Right typedRight)
            {
                return 0;
            }

            return typedLeft.Value + typedRight.Value;
        }
    }
}
";

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

        Assert.Contains("let typedLeft Left?", rendered, StringComparison.Ordinal);
        Assert.Contains("let typedRight Right?", rendered, StringComparison.Ordinal);
        Assert.Contains("typedLeft.Value + typedRight.Value", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void ReassignedNegatedPatternBinder_IsMutable()
    {
        const string source = @"
namespace Demo
{
    public class Base { }
    public sealed class Candidate : Base { public int Value; }

    public static class C
    {
        private static Candidate Normalize(Candidate value) => value;

        public static int Read(Base value)
        {
            if (value is not Candidate candidate)
            {
                return 0;
            }

            candidate = Normalize(candidate);
            return candidate.Value;
        }
    }
}
";

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

        Assert.Contains("var candidate Candidate?", rendered, StringComparison.Ordinal);
        Assert.Contains("candidate = C.Normalize(candidate)", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void NullableValueNegatedPattern_HoistsSurvivingBinder()
    {
        const string source = @"
namespace Demo
{
    public static class C
    {
        public static int Read(int? value)
        {
            if (value is not int present)
            {
                return 0;
            }

            return present;
        }
    }
}
";

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

        Assert.Contains("let present int32? = value", rendered, StringComparison.Ordinal);
        Assert.Contains("return present", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }
}
