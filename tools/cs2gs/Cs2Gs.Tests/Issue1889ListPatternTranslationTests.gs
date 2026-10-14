// <copyright file="Issue1889ListPatternTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1889: a C# list pattern (`ListPatternSyntax`) and its slice
/// ("rest") subpattern (`SlicePatternSyntax`) had no canonical G# form and
/// reported the CS2GS-GAP "is-pattern 'ListPattern' has no canonical G# form
/// yet". G# has a native list/slice pattern (spec §Pattern matching), so both
/// pattern-translation paths now emit it directly:
/// - a top-level `is`-pattern (`x is [...]`) — G#'s `is` operator only tests a type, so it lowers to a
/// hand-composed boolean (a length test ANDed with a per-element test), mirroring the existing
/// property/positional pattern lowering.
/// - a switch-expression/statement arm (`case [...]:` / `case [...] {`) — lowers directly to G#'s
/// native `ListPattern`/`SlicePattern`, since gsc's own pattern binder performs the length/element
/// matching at runtime.
open class Issue1889ListPatternTranslationTests {
    @Fact
    func IsPattern_ExactLengthConstantElements_LowersToLengthAndElementTests() {
        let rendered = Render(`
namespace Corpus.Issue1889
{
    public class Holder
    {
        public bool Describe(int[] values)
        {
            if (values is [1, 2, 3, 4])
            {
                return true;
            }

            return false;
        }
    }
}
`)
        Assert.Contains("values.Length == 4", rendered, StringComparison.Ordinal)
        Assert.Contains("values[0] == 1", rendered, StringComparison.Ordinal)
        Assert.Contains("values[3] == 4", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IsPattern_SliceInMiddle_LowersToMinLengthAndEdgeTests() {
        let rendered = Render(`
namespace Corpus.Issue1889
{
    public class Holder
    {
        public bool Describe(int[] values)
        {
            if (values is [1, .., 4])
            {
                return true;
            }

            return false;
        }
    }
}
`)
        Assert.Contains("values.Length >= 2", rendered, StringComparison.Ordinal)
        Assert.Contains("values[0] == 1", rendered, StringComparison.Ordinal)
        Assert.Contains("values[values.Length - 1] == 4", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IsPattern_ElementsAfterSlice_IndexFromEnd() {
        // The elements AFTER a slice must be indexed end-relative, not from the
        // front: `[1, .., 4, 5]` → last two are `^2`/`^1`, i.e. Length-2/Length-1.
        let rendered = Render(`
namespace Corpus.Issue1889
{
    public class Holder
    {
        public bool Describe(int[] values)
        {
            if (values is [1, .., 4, 5])
            {
                return true;
            }

            return false;
        }
    }
}
`)
        Assert.Contains("values.Length >= 3", rendered, StringComparison.Ordinal)
        Assert.Contains("values[0] == 1", rendered, StringComparison.Ordinal)
        Assert.Contains("values[values.Length - 2] == 4", rendered, StringComparison.Ordinal)
        Assert.Contains("values[values.Length - 1] == 5", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IsPattern_Empty_LowersToLengthZeroTest() {
        let rendered = Render(`
namespace Corpus.Issue1889
{
    public class Holder
    {
        public bool Describe(int[] values)
        {
            if (values is [])
            {
                return true;
            }

            return false;
        }
    }
}
`)
        Assert.Contains("values.Length == 0", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IsPattern_PatternProviderUsesBoundIndexerElementType() {
        let rendered = Render(`
using System.Collections;
using System.Collections.Generic;

namespace Corpus.Issue1889
{
    public sealed class Buffer : IEnumerable<int>
    {
        public int Length => 1;
        public long this[int index] => 1L;

        public IEnumerator<int> GetEnumerator()
        {
            yield return 0;
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    public class Holder
    {
        public bool Describe(Buffer values) => values is [1];
    }
}
`)
        Assert.Contains("values[0] == int64(1)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IsPattern_ProjectedGenericIndexerGuardsNullableElementMember() {
        let rendered = Render(`
#nullable enable
namespace Corpus.Issue1889
{
    public sealed class Node
    {
        public int Value => 1;
    }

    public sealed class Buffer<T>
    {
        private readonly T[] values;
        public Buffer(T[] values) { this.values = values; }
        public int Length => this.values.Length;
        public T this[int index] => this.values[index];
    }

    public class Holder
    {
        private static Buffer<T> Create<T>(T[] values) => new Buffer<T>(values);

        public bool Describe()
        {
            var values = new Node[1];
            var buffer = Create(values);
            return buffer is [{ Value: 1 }];
        }
    }
}
`)
        Assert.Contains("buffer[0] != nil", rendered, StringComparison.Ordinal)
        Assert.Contains("buffer[0].Value == 1", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IsPattern_HeadAndRestBinders_BindHeadByIndexAndRestBySlice() {
        let rendered = Render(`
namespace Corpus.Issue1889
{
    public class Holder
    {
        public int Describe(int[] values)
        {
            if (values is [var head, .. var rest])
            {
                return head + rest.Length;
            }

            return -1;
        }
    }
}
`)
        Assert.Contains("values is [var head, ..rest]", rendered, StringComparison.Ordinal)
        Assert.Contains("head + rest.Length", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("&& true", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchExpression_ListPatternArms_LowerToNativeListAndSlicePatterns() {
        let rendered = Render(`
namespace Corpus.Issue1889
{
    public class Holder
    {
        public string Describe(int[] values) => values switch
        {
            [] => "empty",
            [1, .., 4] => "edges",
            [var head, .. var rest] => $"{head}:{rest.Length}",
            _ => "other",
        };
    }
}
`)
        Assert.Contains("case []:", rendered, StringComparison.Ordinal)
        Assert.Contains("case [1, .., 4]:", rendered, StringComparison.Ordinal)
        Assert.Contains("case [var head, ..rest]:", rendered, StringComparison.Ordinal)
        Assert.Contains("\"$$head:$${rest.Length}\"", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchStatement_ListPatternArm_LowersToNativeListPattern() {
        let rendered = Render(`
namespace Corpus.Issue1889
{
    public class Holder
    {
        public string Describe(int[] values)
        {
            switch (values)
            {
                case [1, .., 4]:
                    return "edges";
                default:
                    return "other";
            }
        }
    }
}
`)
        Assert.Contains("case [1, .., 4] {", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

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
