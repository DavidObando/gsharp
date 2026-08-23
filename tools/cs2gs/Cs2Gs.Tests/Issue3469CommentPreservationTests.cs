// <copyright file="Issue3469CommentPreservationTests.cs" company="GSharp">
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
    // Issue #3469: author comments (`//`, `/* */`) and `///` doc comments were
    // dropped wholesale — ~70k comment lines in the self-migrated src/ became
    // 78. Leading trivia now rides on the first G# node each statement, type
    // member, and top-level type translates to, and the printer re-emits it
    // above that node; `///` doc lines keep the doc-comment marker
    // (ADR-0057), block comments normalize to `//` lines.
    public sealed class Issue3469CommentPreservationTests
    {
        [Fact]
        public void StatementComments_SurviveTranslation_AndBind()
        {
            string printed = Translate("""
                public static class C
                {
                    public static int Run()
                    {
                        // The seed is deliberately non-zero: zero would skip
                        // the calibration branch below.
                        var seed = 41;

                        /* block comment
                           second line */
                        seed = seed + 1;
                        return seed;
                    }
                }
                """);

            Assert.Contains("// The seed is deliberately non-zero: zero would skip", printed, StringComparison.Ordinal);
            Assert.Contains("// the calibration branch below.", printed, StringComparison.Ordinal);
            Assert.Contains("// block comment", printed, StringComparison.Ordinal);
            Assert.Contains("// second line", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void MemberDocComments_KeepDocMarker_AndBind()
        {
            string printed = Translate("""
                public class Widget
                {
                    /// <summary>
                    /// Computes the widget's mass in grams.
                    /// </summary>
                    /// <returns>The mass.</returns>
                    public int Mass() => 42;

                    // A plain member comment.
                    public int Tare() => 1;
                }
                """);

            Assert.Contains("/// <summary>", printed, StringComparison.Ordinal);
            Assert.Contains("/// Computes the widget's mass in grams.", printed, StringComparison.Ordinal);
            Assert.Contains("/// <returns>The mass.</returns>", printed, StringComparison.Ordinal);
            Assert.Contains("// A plain member comment.", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void TypeComments_AndCommentPlacement_AreAboveTheirNodes()
        {
            string printed = Translate("""
                // ADR-9999: this type is load-bearing.
                public class Anchor
                {
                    public int Value()
                    {
                        // above the return
                        return 3;
                    }
                }
                """);

            int typeComment = printed.IndexOf("// ADR-9999: this type is load-bearing.", StringComparison.Ordinal);
            int typeDecl = printed.IndexOf("class Anchor", StringComparison.Ordinal);
            int bodyComment = printed.IndexOf("// above the return", StringComparison.Ordinal);
            int returnStmt = printed.IndexOf("return 3", StringComparison.Ordinal);
            Assert.True(typeComment >= 0 && typeComment < typeDecl, printed);
            Assert.True(bodyComment > typeDecl && bodyComment < returnStmt, printed);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void CommentedCode_StillExecutes()
        {
            string printed = Translate("""
                public static class Obj
                {
                    /// <summary>Adds one, documented.</summary>
                    public static int Run()
                    {
                        // returns 42
                        return 41 + 1;
                    }
                }
                """);

            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()");
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(42, result.Value);
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
