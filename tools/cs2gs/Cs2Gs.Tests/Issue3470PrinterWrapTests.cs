// <copyright file="Issue3470PrinterWrapTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests
{
    // Issue #3470: the printer rendered every statement on one line, turning
    // deliberately wrapped boolean chains and argument lists into 300+
    // character lines. Statement-level value positions now wrap `&&`/`||`
    // chains after each operator and long argument lists after `(` and each
    // comma once the one-line form exceeds the column budget; short
    // statements keep the one-line form.
    public sealed class Issue3470PrinterWrapTests
    {
        [Fact]
        public void LongBooleanChain_WrapsAfterOperators_AndRuns()
        {
            string printed = Translate("""
                public static class Obj
                {
                    private static bool EqualHandles(string leftCollection, string rightCollection) =>
                        leftCollection == rightCollection;

                    public static bool Compare(string first, string second)
                    {
                        return !EqualHandles(first + ".fields.expanded", second + ".fields.expanded") ||
                            !EqualHandles(first + ".methods.expanded", second + ".methods.expanded") ||
                            !EqualHandles(first + ".properties.expanded", second + ".properties.expanded") ||
                            !EqualHandles(first + ".events.expanded", second + ".events.expanded");
                    }

                    public static int Run() => Compare("a", "a") ? 1 : 0;
                }
                """);

            Assert.Contains("||\n", printed, StringComparison.Ordinal);
            Assert.All(
                printed.Split('\n'),
                line => Assert.True(line.Length <= 160, $"line still too long: {line}"));
            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()");
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(0, result.Value);
        }

        [Fact]
        public void LongArgumentList_WrapsAfterCommas_AndBinds()
        {
            string printed = Translate("""
                public static class Obj
                {
                    private static string Combine(
                        string firstComponentValue,
                        string secondComponentValue,
                        string thirdComponentValue,
                        string fourthComponentValue) =>
                        firstComponentValue + secondComponentValue + thirdComponentValue + fourthComponentValue;

                    public static string Run(string prefix)
                    {
                        return Combine(
                            prefix + ".first-component-value-with-some-length",
                            prefix + ".second-component-value-with-some-length",
                            prefix + ".third-component-value-with-some-length",
                            prefix + ".fourth-component-value-with-some-length");
                    }
                }
                """);

            Assert.Contains("Combine(\n", printed, StringComparison.Ordinal);

            // Declaration signatures are outside issue #3470's statement-level
            // scope; every statement line must fit the budget.
            Assert.All(
                printed.Split('\n').Where(line => !line.Contains("func ", StringComparison.Ordinal)),
                line => Assert.True(line.Length <= 160, $"line still too long: {line}"));
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ShortStatements_KeepOneLineForm()
        {
            string printed = Translate("""
                public static class Obj
                {
                    public static bool Both(bool a, bool b) => a && b;

                    public static int Add(int x, int y) => x + y;

                    public static int Run() => Both(true, false) ? Add(1, 2) : 0;
                }
                """);

            Assert.Contains("a && b", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("&&\n", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("(\n", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void WrappedIfCondition_KeepsBlockBraceOnLastLine_AndRuns()
        {
            string printed = Translate("""
                public static class Obj
                {
                    private static bool LongCheckNumberOne(string candidateInputValue) => candidateInputValue.Length > 1;

                    private static bool LongCheckNumberTwo(string candidateInputValue) => candidateInputValue.Length > 2;

                    private static bool LongCheckNumberThree(string candidateInputValue) => candidateInputValue.Length > 3;

                    public static int Run()
                    {
                        var candidate = "abcdef";
                        if (LongCheckNumberOne(candidate + ".suffix-one-for-length") && LongCheckNumberTwo(candidate + ".suffix-two-for-length") && LongCheckNumberThree(candidate + ".suffix-three-for-length"))
                        {
                            return 7;
                        }

                        return 0;
                    }
                }
                """);

            Assert.Contains("&&\n", printed, StringComparison.Ordinal);
            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()");
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(7, result.Value);
        }

        private static string Translate(
            string source,
            params MetadataReference[] additionalReferences)
        {
            IReadOnlyList<MetadataReference> references = additionalReferences.Length == 0
                ? null
                : CSharpProjectLoader.RuntimeReferences()
                    .Concat(additionalReferences)
                    .GroupBy(reference => reference.Display, StringComparer.Ordinal)
                    .Select(group => group.First())
                    .ToList();
            LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
                new[] { ("Snippet.cs", source) },
                references);
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: "
                    + string.Join(Environment.NewLine, project.ErrorDiagnostics));

            LoadedDocument document = Assert.Single(project.Documents);
            var context = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);
            CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
            return GSharpPrinter.Print(unit);
        }
    }
}
