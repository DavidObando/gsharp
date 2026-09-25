// <copyright file="ByRefOperandNullForgivenessTranslationTests.cs" company="GSharp">
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
/// A by-reference argument never carries a non-null assertion. C#'s <c>!</c>
/// is allowed on a variable passed <c>ref</c>/<c>out</c>/<c>in</c> and only
/// silences a warning; its
/// G# spelling <c>x!!</c> is a value, so <c>&amp;x!!</c> is rejected (GS9001,
/// "Cannot take address"). The Regex generator's backtracking code passes
/// <c>ref base.runstack!</c>, which gsgen back-translates (ADR-0192 follow-on 2).
/// </summary>
public class ByRefOperandNullForgivenessTranslationTests
{
    [Fact]
    public void RefArgument_OnInheritedField_DropsTheAssertion()
    {
        // The generator's shape: a protected nullable base field under `!`.
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Runner
    {
        protected int[]? runstack = new int[4];
    }

    public static class Stack
    {
        public static void Push(ref int[] stack, int value) => stack[0] = value;
    }

    public class Derived : Runner
    {
        public int Run()
        {
            Stack.Push(ref base.runstack!, 7);
            return base.runstack![0];
        }
    }
}");

        Assert.Contains("Stack.Push(&base.runstack, 7)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("&base.runstack!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void RefArgument_OnLocalAndParenthesized_DropsTheAssertion()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public static class C
    {
        private static void Fill(ref string text) => text = ""x"";

        public static string Run(string? input)
        {
            string? local = input;
            Fill(ref local!);
            Fill(ref (local!));
            return local;
        }
    }
}");

        Assert.DoesNotMatch(@"&\(?local!!", printed);
        Assert.Contains("Fill(&local)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void OutAndInArguments_DropTheAssertion()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Holder
    {
        public string? Text;
    }

    public static class C
    {
        private static void Produce(out string text) => text = ""x"";

        private static int Measure(in string text) => text.Length;

        public static int Run(Holder holder)
        {
            string? local = null;
            Produce(out local!);
            Produce(out holder.Text!);
            return Measure(in local!) + Measure(in holder.Text!);
        }
    }
}");

        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);
        Assert.Contains("Produce(out local)", printed, StringComparison.Ordinal);
        Assert.Contains("Produce(&holder.Text)", printed, StringComparison.Ordinal);
        Assert.Contains("Measure(in local)", printed, StringComparison.Ordinal);
        Assert.Contains("Measure(&holder.Text)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void RefConstructorInitializerArgument_DropsTheAssertion()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Base
    {
        public Base(ref string? text) => text = ""x"";
    }

    public class Derived : Base
    {
        private static string? s_text;

        public Derived()
            : base(ref s_text!)
        {
        }
    }
}");

        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);
        Assert.Contains(": base(&", printed, StringComparison.Ordinal);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        TranslationTestValidation.AssertBinds(printed);
        return printed;
    }
}
