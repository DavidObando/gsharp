// <copyright file="Issue1734DeclarationSiteSanitizationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Text.RegularExpressions
import Xunit

/// Issue #1734: `SanitizeIdentifier` is applied at every C# *reference*
/// site (`TranslateIdentifierName` and friends) but was skipped at many
/// *declaration*/*synthesis* sites, so a member/parameter/local/pattern
/// designator whose C# name collides with a G# reserved word (e.g. `defer`,
/// `select`) was declared under its raw name while every reference to it
/// was emitted sanitized (`defer_`) — producing G# that either fails to
/// parse (a bare keyword in declaration position) or fails to bind (declared
/// `defer` vs referenced `defer_`).
///
/// Every case below asserts that (1) the declaration and every reference use
/// the identical sanitized spelling, (2) the unsanitized raw form never leaks
/// into the printed output, and (3) the resulting G# round-trip-parses.
open class Issue1734DeclarationSiteSanitizationTests {
    @Fact
    func TypeDeclarationName_KeywordCollision_IsSanitizedConsistently() {
        let rendered = Render(`
namespace Corpus.Issue1734
{
    public class defer
    {
        public int Value;
    }

    public class Holder
    {
        public defer Make()
        {
            return new defer();
        }
    }
}
`)
        Assert.Contains("class $$defer", rendered, StringComparison.Ordinal)
        Assert.Contains("Make() $$defer", rendered, StringComparison.Ordinal)
        Assert.Contains("return $$defer()", rendered, StringComparison.Ordinal)
        AssertNoRawKeywordCollision(rendered, "defer")
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ConstructorLiftPrimaryParameter_KeywordCollision_IsSanitizedConsistently() {
        let rendered = Render(`
namespace Corpus.Issue1734
{
    public class Holder
    {
        public readonly string defer;

        public Holder(string defer)
        {
            this.defer = defer;
        }

        public string Read() => defer;
    }
}
`)
        // The lifted primary-constructor parameter and the member it feeds must
        // agree on the sanitized spelling everywhere: the parameter list, the
        // parameter-field read inside 'Read', and (if retained) the field itself.
        Assert.Contains("$$defer", rendered, StringComparison.Ordinal)
        AssertNoRawKeywordCollision(rendered, "defer")
        AssertRoundTripParses(rendered)
    }

    @Fact
    func LocalFunction_KeywordCollision_IsSanitizedConsistently() {
        let rendered = Render(`
namespace Corpus.Issue1734
{
    public class Holder
    {
        public int Compute()
        {
            int defer() => 5;
            return defer() + defer();
        }
    }
}
`)
        Assert.Contains("defer_", rendered, StringComparison.Ordinal)
        AssertNoRawKeywordCollision(rendered, "defer")
        AssertRoundTripParses(rendered)
    }

    @Fact
    func TupleDeconstruction_KeywordCollision_IsSanitizedConsistently() {
        let rendered = Render(`
namespace Corpus.Issue1734
{
    public class Holder
    {
        private (int, int) Pair() => (1, 2);

        public int Compute()
        {
            var (value, guard) = Pair();
            return value + guard;
        }
    }
}
`)
        Assert.Contains("let (value, guard_)", rendered, StringComparison.Ordinal)
        Assert.Contains("return value + guard_", rendered, StringComparison.Ordinal)
        AssertNoRawKeywordCollision(rendered, "guard")
        AssertRoundTripParses(rendered)
    }

    @Fact
    func DeclarationPatternDesignator_KeywordCollision_IsSanitizedConsistently() {
        let rendered = Render(`
namespace Corpus.Issue1734
{
    public class Shape { }

    public class Circle : Shape
    {
        public int Radius;
    }

    public class Holder
    {
        public int Describe(Shape shape)
        {
            switch (shape)
            {
                case Circle defer:
                    return defer.Radius;
                default:
                    return 0;
            }
        }
    }
}
`)
        Assert.Contains("defer_", rendered, StringComparison.Ordinal)
        AssertNoRawKeywordCollision(rendered, "defer")
        AssertRoundTripParses(rendered)
    }

    @Fact
    func RecursivePatternNamedDesignator_KeywordCollision_IsSanitizedConsistently() {
        let rendered = Render(`
namespace Corpus.Issue1734
{
    public class Shape { }

    public class Circle : Shape
    {
        public int Radius;
    }

    public class Holder
    {
        public int Describe(Shape shape)
        {
            switch (shape)
            {
                case Circle { Radius: var r } defer:
                    return r + defer.Radius;
                default:
                    return 0;
            }
        }
    }
}
`)
        Assert.Contains("defer_", rendered, StringComparison.Ordinal)
        AssertNoRawKeywordCollision(rendered, "defer")
        AssertRoundTripParses(rendered)
    }

    @Fact
    func RecursivePatternBinding_QualifiedGenericType_UsesNativePattern() {
        let rendered = Render(`
using System.Collections.Generic;

namespace Corpus.Issue1734
{
    public class Holder
    {
        public int Describe(object value)
        {
            switch (value)
            {
                case List<int> { Count: var c }:
                    return c;
                default:
                    return 0;
            }
        }
    }
}
`)
        Assert.DoesNotContain("list<int>", rendered, StringComparison.Ordinal)
        Assert.Contains("List[int32] { Count: var c }", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("list.Count", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func PropertyPatternFieldName_KeywordCollision_IsSanitizedConsistently() {
        let rendered = Render(`
namespace Corpus.Issue1734
{
    public class Circle
    {
        public int defer;
    }

    public class Holder
    {
        public int Describe(Circle circle)
        {
            switch (circle)
            {
                case Circle { defer: var t }:
                    return t;
                default:
                    return 0;
            }
        }
    }
}
`)
        Assert.Contains("$$defer", rendered, StringComparison.Ordinal)
        AssertNoRawKeywordCollision(rendered, "defer")
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ObjectInitializerFieldName_KeywordCollision_IsSanitizedConsistently() {
        let rendered = Render(`
namespace Corpus.Issue1734
{
    public class Circle
    {
        public int defer;
    }

    public class Holder
    {
        public Circle Make()
        {
            return new Circle { defer = 3 };
        }
    }
}
`)
        Assert.Contains("$$defer", rendered, StringComparison.Ordinal)
        AssertNoRawKeywordCollision(rendered, "defer")
        AssertRoundTripParses(rendered)
    }

    @Fact
    func WithExpressionFieldName_KeywordCollision_IsSanitizedConsistently() {
        let rendered = Render(`
namespace Corpus.Issue1734
{
    public sealed record Circle(int defer);

    public class Holder
    {
        public Circle Recolor(Circle circle) => circle with { defer = 4 };
    }
}
`)
        Assert.Contains("$$defer", rendered, StringComparison.Ordinal)
        AssertNoRawKeywordCollision(rendered, "defer")
        AssertRoundTripParses(rendered)
    }

    @Fact
    func GenericMethodName_KeywordCollision_IsSanitizedConsistently() {
        let rendered = Render(`
namespace Corpus.Issue1734
{
    public class Box
    {
        public T select<T>(T value) => value;
    }

    public class Holder
    {
        public int Use(Box box) => box.select<int>(5);
    }
}
`)
        Assert.Contains("$$select", rendered, StringComparison.Ordinal)
        AssertNoRawKeywordCollision(rendered, "select")
        AssertRoundTripParses(rendered)
    }

    @Fact
    func TypeParameterName_KeywordCollision_IsEscapedConsistently() {
        let rendered = Render(`
namespace Corpus.Issue1734
{
    public class Box<defer>
    {
        public defer Value;

        public defer Read() => Value;
    }
}
`)
        Assert.Contains("class Box[$$defer]", rendered, StringComparison.Ordinal)
        Assert.Contains("Value $$defer", rendered, StringComparison.Ordinal)
        Assert.Contains("Read() $$defer", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("defer_", rendered, StringComparison.Ordinal)
        AssertNoRawKeywordCollision(rendered, "defer")
        AssertRoundTripParses(rendered)
    }

    @Fact
    func LinqRangeVariable_KeywordCollision_IsSanitizedConsistently() {
        let rendered = Render(`
using System.Collections.Generic;
using System.Linq;

namespace Corpus.Issue1734
{
    public class Holder
    {
        public IEnumerable<int> Filter(IEnumerable<int> values)
        {
            return from defer in values
                   where defer > 0
                   select defer;
        }
    }
}
`)
        Assert.Contains("defer_", rendered, StringComparison.Ordinal)
        AssertNoRawKeywordCollision(rendered, "defer")
        AssertRoundTripParses(rendered)
    }

    // Asserts that no standalone (word-boundary-delimited) occurrence of the raw
    // keyword-colliding identifier survives in the printed output — only its
    // sanitized '<keyword>_' spelling may appear. A bare match would mean some
    // declaration or reference site still emits the unsanitized, unparseable /
    // unbound name (issue #1734).
    @Fact
    func TypeIdentifier_IsNoLongerSanitized() {
        // Issue #3510: `type` left the G# reserved keyword set (aliases parse
        // contextually), so a C# identifier named `type` keeps its spelling.
        let rendered = Render(`
namespace Corpus.Issue3510
{
    public class Holder
    {
        public string Describe(string type)
        {
            string local = type;
            return local + type;
        }
    }
}
`)
        Assert.Contains("Describe(type string)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("type_", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertNoRawKeywordCollision(rendered string, keyword string) {
            let regex = Regex("(?<![A-Za-z0-9_$$])${Regex.Escape(keyword)}(?![A-Za-z0-9_])")
            let match = regex.Match(rendered)
            Assert.False(match.Success, (`unsanitized raw keyword '` + "$keyword" + `' leaked into the printed output:
` + "$rendered"))
        }

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
            return GSharpPrinter.Print(unit)
        }
    }
}
