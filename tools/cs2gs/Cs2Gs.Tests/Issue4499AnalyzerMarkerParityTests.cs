// <copyright file="Issue4499AnalyzerMarkerParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.Translator.Analyzers;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4499AnalyzerMarkerParityTests
{
    private const string Source = """
using System;
using System.Collections.Immutable;
using System.Reflection;

namespace Outer
{
    namespace Symbols
    {
        using int32 = System.Int32;

        static class Door
        {
            public static Type Convert(Type type) => type;

            public static Type Map(Type type, Type definition, ImmutableArray<Type> arguments)
                => Door.Convert(type);

            public static object Tuple((int, string) value) => value;
        }

        static class SomeDoor
        {
            public static Type Map(Type type, Type definition, ImmutableArray<Type> arguments)
                => type;
        }

        class EarlierPackageMember
        {
            int Use(int value) => Math.Abs(value);
        }
    }
}

namespace Binding
{
    using Outer.Symbols;

    class EarlierOtherUnit
    {
        Type Use(Type type) => Door.Convert(type);
    }
}

namespace Outer
{
    namespace Symbols
    {
        using int32 = System.Int32;

        class Consumer
        {
            // typeof(int32) is already the translated spelling.
            Type Primitive() => [|typeof(int)|];

            void Use(Type type, EventInfo evt)
            {
                _ = [|Door.Convert(type)|];
                // Door.Map(evt.EventHandlerType, null, default) must not affect expression ordinals.
                _ = [|Door.Map(evt.EventHandlerType, null, default)|];
                _ = SomeDoor.Map(typeof(int), null, default);
                // Door.Map(typeof(int32), nil, default(ImmutableArray[Type]))
                string collision = "Door.Map(typeof(int32), nil, default(ImmutableArray[Type]))";
                Console.WriteLine(collision);
                _ = Door.Map(typeof(int32), null, default);
                _ = [|Door.Map(typeof(int), null, default)|];
                _ = Door.Tuple(default((int, string)));
                _ = [|Door.Tuple(default)|];
            }
        }
    }
}

class GlobalConsumer
{
    int Use(int value) => [|Math.Abs(value)|];
}
""";

    [Fact]
    public void MarkersSurviveFormattingAndStayWithTheirCompilationUnit()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(Source);

        Assert.True(
            result.GsWithMarkers is not null,
            string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.Message)));
        Assert.Empty(result.UnplacedMarkers);
        Assert.Equal(6, result.GsWithMarkers.Split("[|", StringSplitOptions.None).Length - 1);

        string[] units = result.GsWithMarkers.Split(
            SnippetTranslator.UnitSeparator,
            StringSplitOptions.None);
        Assert.Equal(2, units.Length);
        string symbols = Assert.Single(units, unit => unit.Contains("package Outer.Symbols", StringComparison.Ordinal));
        string binding = Assert.Single(units, unit => unit.Contains("package Binding", StringComparison.Ordinal));

        Assert.Equal(6, symbols.Split("[|", StringSplitOptions.None).Length - 1);
        Assert.DoesNotContain("[|", binding, StringComparison.Ordinal);
        Assert.Contains("-> [|typeof(int32)|]", symbols, StringComparison.Ordinal);
        Assert.DoesNotContain("// [|typeof(int32)|]", symbols, StringComparison.Ordinal);
        Assert.Contains("[|Door.Convert(type)|]", symbols, StringComparison.Ordinal);
        Assert.Contains("[|Door.Map(", symbols, StringComparison.Ordinal);
        int earlierTranslatedSpelling = symbols.IndexOf(
            "Door.Map(typeof(int32), nil,", StringComparison.Ordinal);
        int markedRenamedCall = symbols.IndexOf(
            "[|Door.Map(typeof(int32), nil,", StringComparison.Ordinal);
        Assert.True(earlierTranslatedSpelling >= 0 && markedRenamedCall > earlierTranslatedSpelling);
        Assert.Contains("let _ = [|Door.Map(", symbols, StringComparison.Ordinal);
        Assert.Contains("// Door.Map(typeof(int32), nil, default(ImmutableArray[Type]))", symbols, StringComparison.Ordinal);
        Assert.Contains("\"Door.Map(typeof(int32), nil, default(ImmutableArray[Type]))\"", symbols, StringComparison.Ordinal);
        Assert.DoesNotContain("// [|Door.Map", symbols, StringComparison.Ordinal);
        Assert.DoesNotContain("\"[|Door.Map", symbols, StringComparison.Ordinal);
        Assert.Contains("nil", symbols, StringComparison.Ordinal);
        Assert.Contains("default(ImmutableArray[Type])", symbols, StringComparison.Ordinal);
        Assert.Contains("))|]", symbols, StringComparison.Ordinal);
        int earlierExplicitDefault = symbols.IndexOf(
            "Door.Tuple(default((int32, string)))", StringComparison.Ordinal);
        int markedContextualDefault = symbols.IndexOf(
            "[|Door.Tuple(default((int32, string)))|]", StringComparison.Ordinal);
        Assert.True(earlierExplicitDefault >= 0 && markedContextualDefault > earlierExplicitDefault);
        int earlierPackageCall = symbols.IndexOf(
            "Math.Abs(value)", StringComparison.Ordinal);
        int markedGlobalCall = symbols.IndexOf(
            "[|Math.Abs(value)|]", StringComparison.Ordinal);
        Assert.True(earlierPackageCall >= 0 && markedGlobalCall > earlierPackageCall);
    }

    [Fact]
    public void FormattingFallbackPreservesAliasSpellingInItsOrdinal()
    {
        const string source = """
using System;

namespace Sample
{
    using integer = System.Int32;

    static class Door
    {
        public static object Map(int value, object other, object last) => value;
    }

    class Consumer
    {
        void Use()
        {
            _ = Door.Map(integer.Parse("1"), null, default);
            _ = [|Door.Map(int.Parse("1"), null, default)|];
        }
    }
}
""";

        SnippetTranslationResult result = SnippetTranslator.Translate(source);

        Assert.NotNull(result.GsWithMarkers);
        Assert.True(
            result.UnplacedMarkers.Count == 0,
            result.GsWithMarkers + Environment.NewLine + string.Join(Environment.NewLine, result.UnplacedMarkers));
        int earlierAliasCall = result.GsWithMarkers.IndexOf(
            "Door.Map(", StringComparison.Ordinal);
        int markedPredefinedCall = result.GsWithMarkers.IndexOf(
            "[|Door.Map(", StringComparison.Ordinal);
        Assert.True(earlierAliasCall >= 0 && markedPredefinedCall > earlierAliasCall);
        Assert.Contains("integer.Parse", result.GsWithMarkers, StringComparison.Ordinal);
        Assert.Contains("int32.Parse", result.GsWithMarkers, StringComparison.Ordinal);
    }

    [Fact]
    public void NonExpressionMarkerIsReportedUnplacedInsteadOfThrowing()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate("""
class Consumer
{
    void Use()
    {
        [|return;|]
    }
}
""");

        Assert.NotNull(result.GsWithMarkers);
        Assert.Equal(new[] { "return;" }, result.UnplacedMarkers);
        Assert.Contains(
            result.Diagnostics,
            diagnostic => diagnostic.DiagnosticId == SnippetTranslator.SnippetDiagnosticId);
    }

    [Fact]
    public void FormattingFallbackCountsExplicitDefaultsIndependentOfTheirType()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate("""
static class Door
{
    public static object Map(object value, object other, object last) => value;
}

class Consumer
{
    void Use()
    {
        _ = Door.Map(default(int), null, default);
        _ = [|Door.Map(default(string), null, default)|];
    }
}
""");

        Assert.NotNull(result.GsWithMarkers);
        Assert.Empty(result.UnplacedMarkers);
        int earlier = result.GsWithMarkers.IndexOf("Door.Map(", StringComparison.Ordinal);
        int marked = result.GsWithMarkers.IndexOf("[|Door.Map(", StringComparison.Ordinal);
        Assert.True(earlier >= 0 && marked > earlier);
    }

    [Fact]
    public void MarkerInNamespaceWithoutAnEmittedUnitIsReportedUnplaced()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate("""
namespace One
{
    class First { }
}

namespace [|Empty|]
{
}

namespace Two
{
    class Second { }
}
""");

        Assert.NotNull(result.GsWithMarkers);
        Assert.Equal(new[] { "Empty" }, result.UnplacedMarkers);
        Assert.Contains(
            result.Diagnostics,
            diagnostic => diagnostic.DiagnosticId == SnippetTranslator.SnippetDiagnosticId);
    }

    [Fact]
    public void FormattingFallbackCanPlaceMarkerInsideInterpolationHole()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate("""
using System;
using System.Collections.Immutable;

static class Door
{
    public static object Map(Type type, object other, ImmutableArray<Type> arguments) => type;
}

class Consumer
{
    string Use()
    {
        // Door.Map(typeof(int32), nil, default(ImmutableArray[Type]))
        string collision = "Door.Map(typeof(int32), nil, default(ImmutableArray[Type]))";
        Console.WriteLine(collision);
        return $"{[|Door.Map(typeof(int), null, default)|]}";
    }
}
""");

        Assert.NotNull(result.GsWithMarkers);
        Assert.Empty(result.UnplacedMarkers);
        Assert.Contains("${[|Door.Map(", result.GsWithMarkers, StringComparison.Ordinal);
        Assert.DoesNotContain("// [|Door.Map", result.GsWithMarkers, StringComparison.Ordinal);
        Assert.DoesNotContain("\"[|Door.Map", result.GsWithMarkers, StringComparison.Ordinal);
    }

    [Fact]
    public void FormattingFallbackMatchesOnlyWholeTargetExpressions()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate("""
using System;
using System.Collections.Immutable;

class Door
{
    public object Map(Type type, object other, ImmutableArray<Type> arguments) => type;
}

class Consumer
{
    Door Door { get; } = new Door();

    void Use()
    {
        _ = this.Door.Map(typeof(int), null, default);
        _ = [|Door.Map(typeof(int), null, default)|];
    }
}
""");

        Assert.NotNull(result.GsWithMarkers);
        Assert.Empty(result.UnplacedMarkers);
        int qualified = result.GsWithMarkers.IndexOf("this.Door.Map(", StringComparison.Ordinal);
        int marked = result.GsWithMarkers.IndexOf("[|Door.Map(", StringComparison.Ordinal);
        Assert.True(qualified >= 0 && marked > qualified, result.GsWithMarkers);
    }
}
