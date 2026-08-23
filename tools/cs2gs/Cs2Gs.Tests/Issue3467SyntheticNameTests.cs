// <copyright file="Issue3467SyntheticNameTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests
{
    // Issue #3467: synthesized control-flow labels and lifted local-function
    // names used to embed the syntax node's SpanStart (`__switchExit36386`,
    // `__local_ProjectRegions..._20145`), which reads as garbage and shifts on
    // any upstream edit; C# `_` lambda parameters became `__underscore`. Names
    // are now allocated per function body in first-use order, lifted helpers
    // suffix only on genuine collision, and unreferenced `_` parameters keep
    // the discard spelling.
    public sealed class Issue3467SyntheticNameTests
    {
        [Fact]
        public void SyntheticNames_DoNotEmbedSourcePositions()
        {
            string printed = Translate("""
                using System.Collections.Generic;

                public class C
                {
                    private bool stop;

                    public IEnumerable<int> Items()
                    {
                        if (stop)
                        {
                            yield break;
                        }

                        yield return 1;
                    }

                    public string Label(int value)
                    {
                        int ordinal = 0;
                        return NewLabel("end", ref ordinal) + value;

                        static string NewLabel(string prefix, ref int i)
                        {
                            i++;
                            return prefix + i;
                        }
                    }
                }
                """);

            Assert.Contains("__iteratorExit", printed, StringComparison.Ordinal);
            Assert.Contains("__local_Label_NewLabel", printed, StringComparison.Ordinal);
            Assert.DoesNotMatch(new Regex(@"__iteratorExit\d"), printed);
            Assert.DoesNotMatch(new Regex(@"__local_Label_NewLabel_?\d"), printed);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void SyntheticNames_AreStableUnderUpstreamEdits()
        {
            const string body = """
                using System.Collections.Generic;

                public class C
                {
                    private bool stop;

                    public IEnumerable<int> Items()
                    {
                        if (stop)
                        {
                            yield break;
                        }

                        yield return 1;
                    }

                    public string Label(int value)
                    {
                        int ordinal = 0;
                        return NewLabel("end", ref ordinal) + value;

                        static string NewLabel(string prefix, ref int i)
                        {
                            i++;
                            return prefix + i;
                        }
                    }
                }
                """;

            string original = Translate(body);
            string shifted = Translate(
                "// A long leading comment that shifts every span downstream." +
                Environment.NewLine + Environment.NewLine + body);

            Assert.Equal(original, shifted);
        }

        [Fact]
        public void GotoCaseLabels_UseOrdinalsPerMethod()
        {
            string printed = Translate("""
                public class C
                {
                    public static int Route(int value)
                    {
                        switch (value)
                        {
                            case 1:
                                return 10;
                            case 2:
                                goto case 1;
                            default:
                                goto case 2;
                        }
                    }
                }
                """);

            Assert.Contains("__gotoCase", printed, StringComparison.Ordinal);
            Assert.DoesNotMatch(new Regex(@"__gotoCase\d{3,}"), printed);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void LiftedLocalFunctions_SuffixOnlyOnCollision()
        {
            string printed = Translate("""
                public class C
                {
                    public string Run(int value)
                    {
                        int i = 0;
                        return Helper(ref i) + value;

                        static string Helper(ref int n)
                        {
                            n++;
                            return "a" + n;
                        }
                    }

                    public string Run(string value)
                    {
                        int i = 0;
                        return Helper(ref i) + value;

                        static string Helper(ref int n)
                        {
                            n++;
                            return "b" + n;
                        }
                    }
                }
                """);

            Assert.Contains("__local_Run_Helper", printed, StringComparison.Ordinal);
            Assert.Contains("__local_Run_Helper_2", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__local_Run_Helper_3", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void UnreferencedUnderscoreLambdaParameter_KeepsDiscardSpelling()
        {
            string printed = Translate("""
                using System;

                public class C
                {
                    public static int Apply(Func<string, int> f) => f("x");

                    public static int Run() => Apply(_ => 7);
                }
                """);

            Assert.Contains("(_ string)", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__underscore", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ReferencedUnderscoreLambdaParameter_StillRenames()
        {
            string printed = Translate("""
                using System;

                public class C
                {
                    public static int Apply(Func<int, int> f) => f(3);

                    public static int Run() => Apply(_ => _ + 1);
                }
                """);

            Assert.Contains("__underscore", printed, StringComparison.Ordinal);
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
            return GSharpPrinter.Print(unit);
        }
    }
}
