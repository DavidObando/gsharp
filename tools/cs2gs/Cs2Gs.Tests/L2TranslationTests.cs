// <copyright file="L2TranslationTests.cs" company="GSharp">
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
/// Targeted translation tests for the L2-Library constructs (issue #914,
/// ADR-0115 §B): interface members carry no <c>open</c>, C# casts become
/// width-bearing G# conversions, object initializers become struct literals,
/// <c>with</c>-expressions are preserved, sibling <c>shared</c> static calls are
/// qualified through their owning type, and xUnit attributes map to G#
/// attribute applications. Each test uses a uniquely named user type so the
/// snippets never collide within a single compilation.
/// </summary>
public class L2TranslationTests
{
    /// <summary>
    /// ADR-0115 §B.6: interface members are implicitly abstract, so the
    /// translator never emits <c>open</c> on them — the canonical G# form is the
    /// plain <c>func</c>/<c>prop</c> signature (see <c>samples/InterfaceUpcast.gs</c>).
    /// </summary>
    [Fact]
    public void InterfaceMembers_HaveNoOpen()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public interface IShapeKindOnly
    {
        int Kind { get; }
        double AreaOf();
    }
}");

        Assert.Contains("interface IShapeKindOnly {", printed);
        Assert.Contains("prop Kind int32 {", printed);
        Assert.Contains("func AreaOf() float64;", printed);
        Assert.DoesNotContain("open", printed);
    }

    /// <summary>
    /// ADR-0115 §B.17: a C# explicit numeric cast <c>(int)expr</c> becomes the
    /// width-bearing G# conversion call <c>int32(expr)</c>. This is
    /// behaviour-faithful — the CLR truncates a <c>float64</c> toward zero just
    /// as C# <c>(int)</c> does, so <c>ToCents(1.234)</c> still yields <c>123</c>.
    /// </summary>
    [Fact]
    public void Cast_TranslatesToWidthConversion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class CastHost
    {
        public static int ToCents(double dollars) => (int)(dollars * 100.0);
    }
}");

        Assert.Contains("int32(", printed);
        Assert.Contains("dollars * 100.0", printed);
        Assert.DoesNotContain("return nil", printed);
    }

    /// <summary>
    /// ADR-0115 §B.16: a C# object initializer <c>new T { Field = v }</c> on a
    /// value type maps to the G# composite (struct) literal <c>T{Field: v}</c>.
    /// </summary>
    [Fact]
    public void ObjectInitializer_TranslatesToStructLiteral()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public struct BoxDims
    {
        public double Width { get; set; }
        public double Height { get; set; }
    }

    public static class BoxHost
    {
        public static BoxDims Make() => new BoxDims { Width = 6.0, Height = 7.0 };
    }
}");

        Assert.Contains("BoxDims{Width: 6.0, Height: 7.0}", printed);
    }

    /// <summary>
    /// Issue #946: a C# <c>init</c> accessor maps to a first-class G# <c>init</c>
    /// accessor (previously mapped to <c>set</c> with a gap diagnostic per
    /// ADR-0115 §B.11).
    /// </summary>
    [Fact]
    public void InitAccessor_TranslatesToInit()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Config
    {
        public string Name { get; init; }
    }
}");

        Assert.Contains("get;", printed);
        Assert.Contains("init;", printed);
        Assert.DoesNotContain("set;", printed);
    }

    /// <summary>
    /// ADR-0115 §B.15: a C# <c>with</c>-expression maps to the canonical G#
    /// <c>expr with { Field = value }</c> form (using <c>=</c>); an empty update
    /// list renders <c>expr with { }</c>.
    /// </summary>
    [Fact]
    public void WithExpression_TranslatesToWith()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed record Tone(string Name, int Rgb)
    {
        public Tone Recolor() => this with { Name = ""green"", Rgb = 0x00FF00 };

        public Tone Copy() => this with { };
    }
}");

        Assert.Contains("with { Name = \"green\", Rgb = 0x00FF00 }", printed);
        Assert.Contains("with { }", printed);
    }

    /// <summary>
    /// ADR-0115 §B.18: a C# bare sibling static call inside a non-entry static
    /// class (<c>Round(value, 2)</c>) is qualified through its owning type
    /// (<c>RoundHost.Round(value, 2)</c>), because a G# <c>shared</c> method body
    /// has no implicit type scope.
    /// </summary>
    [Fact]
    public void SiblingStaticCall_IsQualifiedByOwningType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class RoundHost
    {
        public static double One(double value) => Two(value, 2);

        public static double Two(double value, int digits) => value;
    }
}");

        Assert.Contains("RoundHost.Two(value, 2)", printed);
    }

    /// <summary>
    /// ADR-0115 §B.11: xUnit <c>[Fact]</c>/<c>[Theory]</c>/<c>[InlineData(...)]</c>
    /// attributes map to the G# <c>@Fact</c>/<c>@Theory</c>/<c>@InlineData(...)</c>
    /// attribute applications, with <c>float64</c> inline-data spellings
    /// preserved verbatim.
    /// </summary>
    [Fact]
    public void XUnitAttributes_MapToGSharpApplications()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class FactAttribute : System.Attribute { }
    public sealed class TheoryAttribute : System.Attribute { }
    public sealed class InlineDataAttribute : System.Attribute
    {
        public InlineDataAttribute(params object[] data) { }
    }

    public sealed class TonesUnderTest
    {
        [Fact]
        public void Single() { }

        [Theory]
        [InlineData(3.0, 4.0, 12.0)]
        public void Cases(double width, double height, double area) { }
    }
}");

        Assert.Contains("@Fact", printed);
        Assert.Contains("@Theory", printed);
        Assert.Contains("@InlineData(3.0, 4.0, 12.0)", printed);
    }

    /// <summary>
    /// ADR-0115 §B.12: a C# float literal keeps its spelling (<c>2.0</c> stays
    /// <c>2.0</c>) because G# has no implicit numeric promotion; collapsing it to
    /// <c>2</c> would type as <c>int32</c> and break <c>int32 * float64</c>.
    /// </summary>
    [Fact]
    public void FloatLiteral_PreservesSpelling()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class LiteralHost
    {
        public static double Twice(double radius) => 2.0 * radius;
    }
}");

        Assert.Contains("2.0 * radius", printed);
    }

    /// <summary>
    /// ADR-0117 (issue #479): a C# list collection initializer
    /// <c>new List&lt;int&gt;{1, 2, 3}</c> maps to the canonical G# collection
    /// initializer <c>List[int32]{ 1, 2, 3 }</c> (bare elements → <c>Add</c>),
    /// rather than dropping the elements as the pre-ADR-0117 translator did.
    /// </summary>
    [Fact]
    public void ListCollectionInitializer_TranslatesToCollectionInitializer()
    {
        string printed = TranslateUnit(@"
using System.Collections.Generic;
namespace Demo
{
    public static class ListHost
    {
        public static List<int> Make() => new List<int> { 1, 2, 3 };
    }
}");

        Assert.Contains("List[int32]{ 1, 2, 3 }", printed);
    }

    /// <summary>
    /// ADR-0117 (issue #479): a C# dictionary collection initializer using the
    /// complex element form <c>{ {"a", 1} }</c> maps to the canonical G#
    /// <c>key: value</c> pair form <c>Dictionary[string, int32]{ "a": 1, ... }</c>.
    /// </summary>
    [Fact]
    public void DictionaryComplexInitializer_TranslatesToKeyedPairs()
    {
        string printed = TranslateUnit(@"
using System.Collections.Generic;
namespace Demo
{
    public static class DictHost
    {
        public static Dictionary<string, int> Make() =>
            new Dictionary<string, int> { { ""a"", 1 }, { ""b"", 2 } };
    }
}");

        Assert.Contains("Dictionary[string, int32]{ \"a\": 1, \"b\": 2 }", printed);
    }

    /// <summary>
    /// ADR-0117 (issue #479): a C# dictionary indexer initializer
    /// <c>{ ["a"] = 1 }</c> maps to the canonical G# indexed element form
    /// <c>Dictionary[string, int32]{ ["a"] = 1 }</c>, and constructor arguments
    /// (a comparer) are preserved on the construction target — the analogue of
    /// the C# <c>new(StringComparer.OrdinalIgnoreCase){ ... }</c> case.
    /// </summary>
    [Fact]
    public void DictionaryIndexedInitializer_WithComparer_TranslatesToIndexedElements()
    {
        string printed = TranslateUnit(@"
using System;
using System.Collections.Generic;
namespace Demo
{
    public static class HeaderHost
    {
        public static Dictionary<string, int> Make() =>
            new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase) { [""Key""] = 5 };
    }
}");

        Assert.Contains("Dictionary[string, int32](StringComparer.OrdinalIgnoreCase){ [\"Key\"] = 5 }", printed);
    }

    /// <summary>
    /// Issue #947: a C# <c>readonly</c> field assigned inside a constructor whose
    /// body is not a simple parameter-to-member copy (so the primary-constructor
    /// lift does not apply) now translates to a G# <c>let</c> field that the
    /// emitted <c>init(...)</c> constructor assigns directly — which is valid G#
    /// now that <c>let</c> fields carry C# <c>readonly</c>-field semantics.
    /// </summary>
    [Fact]
    public void ReadonlyField_AssignedInNonLiftableConstructor_TranslatesToLetWithInit()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class StampX
    {
        private readonly int doubled;
        public StampX(int n)
        {
            this.doubled = n * 2;
        }
        public int Doubled => this.doubled;
    }
}");

        Assert.Contains("let doubled int32", printed);
        Assert.Contains("init(n int32)", printed);
        Assert.Contains("doubled = n * 2", printed);
        Assert.DoesNotContain("var doubled", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
