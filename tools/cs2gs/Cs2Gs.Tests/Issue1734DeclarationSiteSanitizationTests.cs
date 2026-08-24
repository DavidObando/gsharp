// <copyright file="Issue1734DeclarationSiteSanitizationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1734: <c>SanitizeIdentifier</c> is applied at every C# *reference*
/// site (<c>TranslateIdentifierName</c> and friends) but was skipped at many
/// *declaration*/*synthesis* sites, so a member/parameter/local/pattern
/// designator whose C# name collides with a G# reserved word (e.g. <c>defer</c>,
/// <c>select</c>) was declared under its raw name while every reference to it
/// was emitted sanitized (<c>defer_</c>) — producing G# that either fails to
/// parse (a bare keyword in declaration position) or fails to bind (declared
/// <c>defer</c> vs referenced <c>defer_</c>).
/// <para>
/// Every case below asserts that (1) the declaration and every reference use
/// the identical sanitized spelling, (2) the unsanitized raw form never leaks
/// into the printed output, and (3) the resulting G# round-trip-parses.
/// </para>
/// </summary>
public class Issue1734DeclarationSiteSanitizationTests
{
    [Fact]
    public void TypeDeclarationName_KeywordCollision_IsSanitizedConsistently()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("class defer_", rendered, StringComparison.Ordinal);
        Assert.Contains("Make() defer_", rendered, StringComparison.Ordinal);
        Assert.Contains("return defer_()", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "defer");
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ConstructorLiftPrimaryParameter_KeywordCollision_IsSanitizedConsistently()
    {
        string rendered = Render(@"
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
");

        // The lifted primary-constructor parameter and the member it feeds must
        // agree on the sanitized spelling everywhere: the parameter list, the
        // parameter-field read inside 'Read', and (if retained) the field itself.
        Assert.Contains("defer_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "defer");
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void LocalFunction_KeywordCollision_IsSanitizedConsistently()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("defer_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "defer");
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void TupleDeconstruction_KeywordCollision_IsSanitizedConsistently()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("let (value, guard_)", rendered, StringComparison.Ordinal);
        Assert.Contains("return value + guard_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "guard");
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void DeclarationPatternDesignator_KeywordCollision_IsSanitizedConsistently()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("defer_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "defer");
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void RecursivePatternNamedDesignator_KeywordCollision_IsSanitizedConsistently()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("defer_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "defer");
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void RecursivePatternBinding_QualifiedGenericType_UsesNativePattern()
    {
        string rendered = Render(@"
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
");

        Assert.DoesNotContain("list<int>", rendered, StringComparison.Ordinal);
        Assert.Contains("List[int32] { Count: var c }", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("list.Count", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void PropertyPatternFieldName_KeywordCollision_IsSanitizedConsistently()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("defer_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "defer");
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ObjectInitializerFieldName_KeywordCollision_IsSanitizedConsistently()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("defer_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "defer");
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void WithExpressionFieldName_KeywordCollision_IsSanitizedConsistently()
    {
        string rendered = Render(@"
namespace Corpus.Issue1734
{
    public sealed record Circle(int defer);

    public class Holder
    {
        public Circle Recolor(Circle circle) => circle with { defer = 4 };
    }
}
");

        Assert.Contains("defer_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "defer");
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void GenericMethodName_KeywordCollision_IsSanitizedConsistently()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("select_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "select");
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void TypeParameterName_KeywordCollision_IsSanitizedConsistently()
    {
        string rendered = Render(@"
namespace Corpus.Issue1734
{
    public class Box<defer>
    {
        public defer Value;

        public defer Read() => Value;
    }
}
");

        Assert.Contains("defer_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "defer");
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void LinqRangeVariable_KeywordCollision_IsSanitizedConsistently()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("defer_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "defer");
        AssertRoundTripParses(rendered);
    }

    // Asserts that no standalone (word-boundary-delimited) occurrence of the raw
    // keyword-colliding identifier survives in the printed output — only its
    // sanitized '<keyword>_' spelling may appear. A bare match would mean some
    // declaration or reference site still emits the unsanitized, unparseable /
    // unbound name (issue #1734).
    [Fact]
    public void TypeIdentifier_IsNoLongerSanitized()
    {
        // Issue #3510: `type` left the G# reserved keyword set (aliases parse
        // contextually), so a C# identifier named `type` keeps its spelling.
        string rendered = Render(@"
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
");

        Assert.Contains("Describe(type string)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("type_", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertNoRawKeywordCollision(string rendered, string keyword)
    {
        var regex = new System.Text.RegularExpressions.Regex(
            $@"(?<![A-Za-z0-9_]){System.Text.RegularExpressions.Regex.Escape(keyword)}(?![A-Za-z0-9_])");
        System.Text.RegularExpressions.Match match = regex.Match(rendered);
        Assert.False(
            match.Success,
            $"unsanitized raw keyword '{keyword}' leaked into the printed output:\n{rendered}");
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
