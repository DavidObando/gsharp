// <copyright file="Issue3501YieldBreakTranslationTests.cs" company="GSharp">
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
    // Issue #3501 Track A1: C# `yield break` now translates to G#'s native
    // `yield break` statement instead of a synthesized `goto __iteratorExit`
    // plus a trailing label.
    public sealed class Issue3501YieldBreakTranslationTests
    {
        [Fact]
        public void YieldBreak_TranslatesNativelyAndRuns()
        {
            string printed = Translate("""
                using System.Collections.Generic;

                public static class Obj
                {
                    public static IEnumerable<int> Items(int limit)
                    {
                        foreach (var i in new[] { 1, 2, 3, 4 })
                        {
                            if (i > limit)
                            {
                                yield break;
                            }

                            yield return i;
                        }

                        yield return 99;
                    }

                    public static int Run()
                    {
                        int total = 0;
                        foreach (var v in Items(2))
                        {
                            total += v;
                        }

                        return total;
                    }
                }
                """);

            Assert.Contains("yield break", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__iteratorExit", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("goto", printed, StringComparison.Ordinal);
            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()");
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(3, result.Value);
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
