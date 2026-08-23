// <copyright file="Issue3468MethodGroupWrapperTests.cs" company="GSharp">
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
    // Issue #3468: a method group whose signature already matches the target
    // delegate passes through as a direct method reference; a wrapper that IS
    // required renders as the concise arrow form with parameter names derived
    // from the target method (`(value string) -> Stringify(value)`), keeping
    // the block-bodied explicit-return-type function literal only where the
    // delegate's result type must be pinned (return covariance) or parameters
    // pass by reference.
    public sealed class Issue3468MethodGroupWrapperTests
    {
        [Fact]
        public void MatchingMethodGroups_PassThroughDirect()
        {
            string printed = Translate("""
                using System.Collections.Generic;
                using System.IO;
                using System.Linq;

                public class W
                {
                    public List<string> Full(List<string> paths)
                        => paths.Select(Path.GetFullPath).ToList();

                    public List<int> Lens(List<string> paths)
                        => paths.Select(Len).ToList();

                    private static int Len(string s) => s.Length;
                }
                """);

            Assert.Contains("paths.Select(Path.GetFullPath)", printed, StringComparison.Ordinal);
            Assert.Contains("Select(Len)", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        // An EXPLICIT C# delegate creation renders as a G# construction,
        // whose operand cannot be a variant group — so the cast shape keeps
        // its arrow wrapper even after #3501 A5.
        [Fact]
        public void ContravariantCastMethodGroup_KeepsArrowWrapper()
        {
            string printed = Translate("""
                using System;
                using System.Collections.Generic;
                using System.Linq;

                public class W
                {
                    public List<string> Mixed(List<string> paths)
                        => paths.Select((Func<string, string>)Stringify).ToList();

                    private static string Stringify(object? value) => value?.ToString() ?? "";
                }
                """);

            Assert.Contains("(value string) -> W.Stringify(value)", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("func (", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        // Issue #3501 A5: covariant-return groups pass direct.
        [Fact]
        public void ReturnCovariantMethodGroup_PassesDirect()
        {
            string printed = Translate("""
                using System.Collections.Generic;
                using System.Linq;

                public class W
                {
                    public List<object> Objs(List<string> paths)
                        => paths.Select<string, object>(Twice).ToList();

                    private static string Twice(string s) => s + s;
                }
                """);

            Assert.Contains("Select[string, object](Twice)", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("func (s string) object", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ArrowWrapper_ExecutesWithParity()
        {
            string printed = Translate("""
                using System;
                using System.Collections.Generic;
                using System.Linq;

                public static class Obj
                {
                    public static int Run()
                    {
                        var items = new List<string> { "a", "bb" };
                        return items.Select((Func<string, int>)Weigh).Sum();
                    }

                    private static int Weigh(object? value) => (value as string)?.Length ?? 0;
                }
                """);

            Assert.Contains("(value string) -> Obj.Weigh(value)", printed, StringComparison.Ordinal);
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
