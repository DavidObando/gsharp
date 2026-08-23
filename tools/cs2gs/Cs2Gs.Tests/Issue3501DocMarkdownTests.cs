// <copyright file="Issue3501DocMarkdownTests.cs" company="GSharp">
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
    // Issue #3501 Track B1: C# XML doc comments convert to G#'s ADR-0057
    // Markdown authoring surface instead of passing XML tags through
    // verbatim. Constructs outside the bijective subset splice into the
    // ```xmldoc escape hatch; malformed XML passes through untouched.
    public sealed class Issue3501DocMarkdownTests
    {
        [Fact]
        public void SummaryParamsReturnsException_ConvertToBlockTags()
        {
            string printed = Translate("""
                public class Widget
                {
                    /// <summary>
                    /// Computes the widget's mass in grams.
                    /// </summary>
                    /// <param name="scale">The scale factor applied to the raw mass.</param>
                    /// <typeparam name="T">Unused, documented anyway.</typeparam>
                    /// <returns>The scaled mass.</returns>
                    /// <exception cref="System.ArgumentException">When scale is negative.</exception>
                    public int Mass<T>(int scale) => 42 * scale;
                }
                """);

            Assert.Contains("/// Computes the widget's mass in grams.", printed, StringComparison.Ordinal);
            Assert.Contains("/// @param scale The scale factor applied to the raw mass.", printed, StringComparison.Ordinal);
            Assert.Contains("/// @typeparam T Unused, documented anyway.", printed, StringComparison.Ordinal);
            Assert.Contains("/// @returns The scaled mass.", printed, StringComparison.Ordinal);
            Assert.Contains("/// @exception System.ArgumentException When scale is negative.", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("<summary>", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("<param", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void InlineElements_ConvertToMarkdownSpellings()
        {
            string printed = Translate("""
                public class Widget
                {
                    /// <summary>
                    /// Uses <c>raw</c> mode; see <see cref="Widget"/> and
                    /// <see cref="Other">the other one</see>, or read
                    /// <see href="https://example.test/docs">the docs</see>.
                    /// Passing <paramref name="mode"/> as <see langword="null"/> resets.
                    /// </summary>
                    public int Run(string mode) => mode.Length;
                }

                public class Other
                {
                }
                """);

            Assert.Contains("`raw` mode; see (cref:Widget) and", printed, StringComparison.Ordinal);
            Assert.Contains("[the other one](cref:Other)", printed, StringComparison.Ordinal);
            Assert.Contains("[the docs](https://example.test/docs)", printed, StringComparison.Ordinal);
            Assert.Contains("[`mode`](paramref) as `null` resets.", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ParasListsAndCode_ConvertToMarkdownBlocks()
        {
            string printed = Translate("""
                public class Widget
                {
                    /// <summary>
                    /// First paragraph.
                    /// <para>Second paragraph.</para>
                    /// <list type="bullet">
                    /// <item><description>alpha</description></item>
                    /// <item><description>beta</description></item>
                    /// </list>
                    /// <code>
                    /// var w = Widget()
                    /// </code>
                    /// </summary>
                    public int Run() => 1;
                }
                """);

            Assert.Contains("/// First paragraph.", printed, StringComparison.Ordinal);
            Assert.Contains("/// Second paragraph.", printed, StringComparison.Ordinal);
            Assert.Contains("/// - alpha", printed, StringComparison.Ordinal);
            Assert.Contains("/// - beta", printed, StringComparison.Ordinal);
            Assert.Contains("/// ```", printed, StringComparison.Ordinal);
            Assert.Contains("/// var w = Widget()", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void UnmappedConstructs_UseXmldocEscapeHatch()
        {
            string printed = Translate("""
                public class Widget
                {
                    /// <summary>Documented.</summary>
                    /// <list type="table">
                    /// <listheader><term>Name</term><description>Meaning</description></listheader>
                    /// <item><term>Width</term><description>extent in X</description></item>
                    /// </list>
                    public int Run() => 1;
                }
                """);

            Assert.Contains("/// ```xmldoc", printed, StringComparison.Ordinal);
            Assert.Contains("<listheader><term>Name</term>", printed, StringComparison.Ordinal);
            Assert.Contains("/// Documented.", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void MalformedXml_PassesThroughVerbatim()
        {
            string printed = Translate("""
                public class Widget
                {
                    /// Raw prose with a stray < angle bracket, no tags.
                    public int Run() => 1;
                }
                """);

            Assert.Contains("/// Raw prose with a stray < angle bracket, no tags.", printed, StringComparison.Ordinal);
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
