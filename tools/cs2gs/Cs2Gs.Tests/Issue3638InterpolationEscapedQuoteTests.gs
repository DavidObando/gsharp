// <copyright file="Issue3638InterpolationEscapedQuoteTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #3638: multiline interpolation must keep non-atomic holes intact.
/// Issue #3948 now keeps every hole inside a quoted interpolation fragment
/// instead of appending a synthetic `.ToString()`, preserving both the
/// original precedence and interpolation semantics.
open class Issue3638InterpolationEscapedQuoteTests {
    @Fact
    func MultilineInterpolation_EscapedQuotesAndExpressionHole_StaysInterpolatedAndRoundTrips() {
        // The Adr0158SyncMapSpikeTests shape: escaped quotes, `{{`/`}}` brace
        // escapes, a plain `{i}` hole, and a non-atomic `{i + 1}` hole.
        let rendered = Render(`
namespace Corpus.Issue3638
{
    public class Holder
    {
        public string Source(int i)
        {
            return $"func setK{i}(m SyncMap) int32 {{\n    m.Store(\"k{i}\", {i + 1})\n    return 0\n}}";
        }
    }
}
`)
        Assert.Contains("\"$${i + 1}\"", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("ToString()", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func MultilineInterpolation_PlainIdentifierHole_UsesShorthand() {
        let rendered = Render(`
namespace Corpus.Issue3638
{
    public class Holder
    {
        public string Source(int i)
        {
            return $"line1 {i}\nline2 \"x\"\nline3";
        }
    }
}
`)
        Assert.Contains("\"$$i\"", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("ToString()", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func MultilineVerbatimInterpolation_EscapedQuotesAndExpressionHole_StaysInterpolatedAndRoundTrips() {
        // Verbatim `$@""...""` uses `""""` quote escapes and real newlines but
        // flows through the same classic single-dollar machinery.
        let rendered = Render(`
namespace Corpus.Issue3638
{
    public class Holder
    {
        public string Source(int i)
        {
            return $@"b.F{i} = {i + 1} says ""hi""
line2
line3";
        }
    }
}
`)
        Assert.Contains("\"$${i + 1}\"", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func MultilineInterpolation_UnaryHole_StaysInterpolated() {
        let rendered = Render(`
namespace Corpus.Issue3638
{
    public class Holder
    {
        public string Source(int i)
        {
            return $"neg {-i}\nline2\nline3";
        }
    }
}
`)
        Assert.Contains("\"$${-i}\"", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    shared {
        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }
    }
}
