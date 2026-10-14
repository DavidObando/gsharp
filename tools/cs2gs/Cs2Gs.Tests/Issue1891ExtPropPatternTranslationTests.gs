// <copyright file="Issue1891ExtPropPatternTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1891: an extended property subpattern (a nested member access in a
/// property subpattern, e.g. `{ Start.X: 0 }`) parses as
/// `ExpressionColon` rather than `NameColon`. The `is`-form
/// boolean-test lowering already handled this correctly (it lowers to a
/// nested member-access test, e.g. `receiver.Start.X == 0`). The
/// switch-arm G#-pattern lowering only recognized `NameColon` and
/// misreported the subpattern as an unsupported *positional* subpattern. G#'s
/// property-pattern field is a single identifier (no dotted form), so the
/// switch-arm fix nests `PropertyPattern`s instead: `Start.X: 0`
/// becomes `{ Start: { X: 0 } }`, to any chain depth.
open class Issue1891ExtPropPatternTranslationTests {
    @Fact
    func SwitchExpression_ExtendedPropertySubpattern_LowersToNestedPropertyPattern() {
        let rendered = Render(PointSource + `
    public class Holder
    {
        public string Describe(Segment s) => s switch
        {
            { Start.X: 0 } => "zero",
            _ => "other",
        };
    }
}
`)
        Assert.Contains("{ Start: { X: 0 } }", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchExpression_DeepMemberChain_LowersToDeeplyNestedPropertyPattern() {
        let rendered = Render(`
namespace Corpus.Issue1891
{
    public class C
    {
        public int Value;
    }

    public class B
    {
        public C C;
    }

    public class A
    {
        public B B;
    }

    public class Holder
    {
        public string Describe(A a) => a switch
        {
            { B.C.Value: 0 } => "zero",
            _ => "other",
        };
    }
}
`)
        Assert.Contains("{ B: { C: { Value: 0 } } }", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchExpression_ExtendedSubpatternCombinedWithSimpleSubpattern_LowersBothFields() {
        let rendered = Render(PointSource + `
    public class Holder
    {
        public string Describe(Segment s) => s switch
        {
            { Start.X: 0, Length: 1 } => "match",
            _ => "other",
        };
    }
}
`)
        Assert.Contains("{ Start: { X: 0 }, Length: 1 }", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IsPattern_ExtendedPropertySubpattern_StillLowersToNestedMemberAccessTest() {
        // Regression: the is-form path already handled ExpressionColon; the
        // switch-arm fix must not disturb it.
        let rendered = Render(PointSource + `
    public class Holder
    {
        public bool Describe(Segment s)
        {
            if (s is { Start.X: 0 })
            {
                return true;
            }

            return false;
        }
    }
}
`)
        Assert.Contains("s.Start.X == 0", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private const PointSource string = `
namespace Corpus.Issue1891
{
    public class Point
    {
        public int X;
        public int Y;
    }

    public class Segment
    {
        public Point Start;
        public int Length;
    }
`

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
