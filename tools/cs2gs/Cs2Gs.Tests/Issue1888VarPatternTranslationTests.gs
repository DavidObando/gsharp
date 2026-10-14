// <copyright file="Issue1888VarPatternTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1888: a C# `var` pattern (`VarPatternSyntax`) ALWAYS
/// matches and binds the subject (or sub-value); it had no canonical G# form
/// and reported the CS2GS-GAP "pattern 'VarPattern' has no canonical G# form
/// yet". Native G# `var name` patterns now preserve every scalar surface:
/// - a top-level `is`-pattern (`x is var v`) — lowers to the native `x is var v`.
/// - a switch-expression/statement arm (`var v =>`) — native `case var v`.
/// - a nested property subpattern (`{ Prop: var v }`) — native nested total binding.
open class Issue1888VarPatternTranslationTests {
    @Fact
    func IsPattern_VarBinder_EmitsNativeTotalBinding() {
        let rendered = Render(`
namespace Corpus.Issue1888
{
    public class Holder
    {
        public string Describe(object product)
        {
            if (product is var captured)
            {
                return captured.ToString();
            }

            return "unreachable";
        }
    }
}
`)
        Assert.Contains("if product is var captured {", rendered, StringComparison.Ordinal)
        Assert.Contains("captured.ToString()", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchExpression_VarArm_EmitsNativeTotalBinding() {
        let rendered = Render(`
namespace Corpus.Issue1888
{
    public class Holder
    {
        public string Describe(int n) => n switch
        {
            0 => "zero",
            var v => $"other ({v})",
        };
    }
}
`)
        Assert.Contains("case var v:", rendered, StringComparison.Ordinal)
        Assert.Contains("other ($$v)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchStatement_VarArm_EmitsNativeTotalBinding() {
        let rendered = Render(`
namespace Corpus.Issue1888
{
    public class Holder
    {
        public string Describe(int n)
        {
            switch (n)
            {
                case 0:
                    return "zero";
                case var v:
                    return $"other ({v})";
            }
        }
    }
}
`)
        Assert.Contains("case var v {", rendered, StringComparison.Ordinal)
        Assert.Contains("other ($$v)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func PropertyPattern_VarSubpattern_BindsToMemberAccessOnEnclosingProperty() {
        let rendered = Render(`
namespace Corpus.Issue1888
{
    public class Address
    {
        public string City;
    }

    public class Person
    {
        public Address Address;
    }

    public class Holder
    {
        public string Describe(Person person)
        {
            if (person is { Address: var addr })
            {
                return addr.City;
            }

            return "unreachable";
        }
    }
}
`)
        Assert.Contains("person is { Address: var addr }", rendered, StringComparison.Ordinal)
        Assert.Contains("addr.City", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("&& true", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchExpression_NestedVarSubpattern_LowersToDiscardFieldWithSubstitutedBind() {
        let rendered = Render(`
namespace Corpus.Issue1888
{
    public class Address
    {
        public string City;
    }

    public class Person
    {
        public string Name;
        public Address Address;
    }

    public class Holder
    {
        public string Describe(Person person) => person switch
        {
            { Name: "Ada" } => "ada",
            { Address: var addr } => addr.City,
            _ => "other",
        };
    }
}
`)
        Assert.Contains("{ Address: var addr }", rendered, StringComparison.Ordinal)
        Assert.Contains("addr.City", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IsPattern_VarTupleDesignation_StaysLoudGap() {
        // `var (a, b)` deconstructs — G# has no canonical form, so it must keep
        // reporting the CS2GS-GAP rather than silently emit a bindingless match.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
namespace Corpus.Issue1888
{
    public class Holder
    {
        public bool Describe((int, int) point)
        {
            if (point is var (a, b))
            {
                return a == b;
            }

            return false;
        }
    }
}
`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Message!!.Contains("tuple designation", StringComparison.Ordinal)
        )
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
