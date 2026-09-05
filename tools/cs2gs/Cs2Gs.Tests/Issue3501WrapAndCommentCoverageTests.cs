// <copyright file="Issue3501WrapAndCommentCoverageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Formatting;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests
{
    // Issue #3501 B2+B3 / ADR-0179: the canonical wrap pass extends to invocations whose
    // arguments are multi-line lambdas (first-line budget), long postfix
    // chains (leading-dot continuations), and long declaration signatures;
    // comment coverage extends to trailing same-line comments and comments
    // dangling before a block's closing brace.
    public sealed class Issue3501WrapAndCommentCoverageTests
    {
        [Fact]
        public void MultiLineLambdaArgument_StillWrapsLongHead()
        {
            string printed = Translate("""
                using System;

                public static class Obj
                {
                    private static int Configure(
                        string firstConfigurationComponentName,
                        string secondConfigurationComponentName,
                        string thirdConfigurationComponentName,
                        Func<int, int> transformCallback) => transformCallback(1);

                    public static int Run()
                    {
                        return Configure("first-component-value-with-length", "second-component-value-with-length", "third-component-value-with-length", value =>
                        {
                            int doubled = value * 2;
                            return doubled + 40;
                        });
                    }
                }
                """);

            Assert.Contains("Configure(\n", printed, StringComparison.Ordinal);
            Assert.All(
                printed.Split('\n').Where(line => !line.Contains("func ", StringComparison.Ordinal)),
                line => Assert.True(line.Length <= 160, $"line still too long: {line}"));
            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()");
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(42, result.Value);
        }

        [Fact]
        public void LongPostfixChain_BreaksBeforeDots_AndRuns()
        {
            string printed = Translate("""
                public static class Obj
                {
                    public static int Run(string candidateInputValueForProcessing)
                    {
                        return candidateInputValueForProcessing.Trim().Replace("aaaa", "bb").Replace("cccc", "dd").Replace("eeee", "ff").Replace("gggg", "hh").ToUpperInvariant().Length;
                    }
                }
                """);

            Assert.Contains(".Trim()\n", printed, StringComparison.Ordinal);
            Assert.Contains(".Replace(\"aaaa\", \"bb\")", printed, StringComparison.Ordinal);
            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run(\"  aaaacccceeeegggg  \")");
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(8, result.Value);
        }

        [Fact]
        public void LongDeclarationSignature_WrapsParameterList_AndBinds()
        {
            string printed = Translate("""
                public static class Obj
                {
                    public static string Combine(string firstComponentValueName, string secondComponentValueName, string thirdComponentValueName, string fourthComponentValueName, int repetitionCountValue)
                        => firstComponentValueName + secondComponentValueName + thirdComponentValueName + fourthComponentValueName + repetitionCountValue;
                }
                """);

            Assert.Contains("Combine(\n", printed, StringComparison.Ordinal);
            Assert.Contains("firstComponentValueName string,\n", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void TrailingAndDanglingComments_Survive()
        {
            string printed = Translate("""
                public static class Obj
                {
                    public static int Run()
                    {
                        var seed = 41; // seed chosen for the calibration branch
                        seed += 1;
                        return seed;
                        // dangling: kept for the audit trail
                    }
                }
                """);

            Assert.Contains("// seed chosen for the calibration branch", printed, StringComparison.Ordinal);
            Assert.Contains("// dangling: kept for the audit trail", printed, StringComparison.Ordinal);
            int trailing = printed.IndexOf("// seed chosen", StringComparison.Ordinal);
            int seedLine = printed.IndexOf("var seed", StringComparison.Ordinal);
            Assert.True(
                printed.Substring(seedLine, trailing - seedLine).IndexOf('\n') < 0,
                "trailing comment stays on the statement's line");
            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()");
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Equal(42, result.Value);
        }

        [Fact]
        public void ShortSignaturesAndChains_KeepOneLineForm()
        {
            string printed = Translate("""
                public static class Obj
                {
                    public static int Add(int x, int y) => x + y;

                    public static int Run(string s) => s.Trim().Length + Add(1, 2);
                }
                """);

            Assert.Contains("Add(x int32, y int32)", printed, StringComparison.Ordinal);
            Assert.Contains("s.Trim().Length", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
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
            FormatResult formatted = GSharpFormatter.Format(SourceText.From(GSharpPrinter.Print(unit)));
            Assert.Empty(formatted.Diagnostics);
            return formatted.Text!.ToString();
        }
    }
}
