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
/// designator whose C# name collides with a G# reserved word (e.g. <c>type</c>,
/// <c>select</c>) was declared under its raw name while every reference to it
/// was emitted sanitized (<c>type_</c>) — producing G# that either fails to
/// parse (a bare keyword in declaration position) or fails to bind (declared
/// <c>type</c> vs referenced <c>type_</c>).
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
    public class type
    {
        public int Value;
    }

    public class Holder
    {
        public type Make()
        {
            return new type();
        }
    }
}
");

        Assert.Contains("class type_", rendered, StringComparison.Ordinal);
        Assert.Contains("Make() type_", rendered, StringComparison.Ordinal);
        Assert.Contains("return type_()", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "type");
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
        public readonly string type;

        public Holder(string type)
        {
            this.type = type;
        }

        public string Read() => type;
    }
}
");

        // The lifted primary-constructor parameter and the member it feeds must
        // agree on the sanitized spelling everywhere: the parameter list, the
        // parameter-field read inside 'Read', and (if retained) the field itself.
        Assert.Contains("type_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "type");
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
            int type() => 5;
            return type() + type();
        }
    }
}
");

        Assert.Contains("type_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "type");
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
                case Circle type:
                    return type.Radius;
                default:
                    return 0;
            }
        }
    }
}
");

        Assert.Contains("type_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "type");
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
                case Circle { Radius: var r } type:
                    return r + type.Radius;
                default:
                    return 0;
            }
        }
    }
}
");

        Assert.Contains("type_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "type");
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void RecursivePatternSynthesizedDesignator_QualifiedGenericType_UsesRightmostSimpleName()
    {
        // The synthesized designator must be derived from the right-most simple
        // identifier of the type ('List', not the invalid 'list<int>' that
        // 'Type.ToString()' would yield for a generic type).
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
        Assert.Contains("list", rendered, StringComparison.Ordinal);
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
        public int type;
    }

    public class Holder
    {
        public int Describe(Circle circle)
        {
            switch (circle)
            {
                case Circle { type: var t }:
                    return t;
                default:
                    return 0;
            }
        }
    }
}
");

        Assert.Contains("type_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "type");
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
        public int type;
    }

    public class Holder
    {
        public Circle Make()
        {
            return new Circle { type = 3 };
        }
    }
}
");

        Assert.Contains("type_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "type");
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void WithExpressionFieldName_KeywordCollision_IsSanitizedConsistently()
    {
        string rendered = Render(@"
namespace Corpus.Issue1734
{
    public sealed record Circle(int type);

    public class Holder
    {
        public Circle Recolor(Circle circle) => circle with { type = 4 };
    }
}
");

        Assert.Contains("type_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "type");
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
    public class Box<type>
    {
        public type Value;

        public type Read() => Value;
    }
}
");

        Assert.Contains("type_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "type");
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
            return from type in values
                   where type > 0
                   select type;
        }
    }
}
");

        Assert.Contains("type_", rendered, StringComparison.Ordinal);
        AssertNoRawKeywordCollision(rendered, "type");
        AssertRoundTripParses(rendered);
    }

    // Asserts that no standalone (word-boundary-delimited) occurrence of the raw
    // keyword-colliding identifier survives in the printed output — only its
    // sanitized '<keyword>_' spelling may appear. A bare match would mean some
    // declaration or reference site still emits the unsanitized, unparseable /
    // unbound name (issue #1734).
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
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

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
