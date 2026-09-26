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
                _ = Door.Map(typeof(int32), null, default);
                _ = [|Door.Map(typeof(int), null, default)|];
                _ = [|Door.Tuple(default)|];
            }
        }
    }
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
        Assert.Equal(5, result.GsWithMarkers.Split("[|", StringSplitOptions.None).Length - 1);

        string[] units = result.GsWithMarkers.Split(
            SnippetTranslator.UnitSeparator,
            StringSplitOptions.None);
        Assert.Equal(2, units.Length);
        string symbols = Assert.Single(units, unit => unit.Contains("package Outer.Symbols", StringComparison.Ordinal));
        string binding = Assert.Single(units, unit => unit.Contains("package Binding", StringComparison.Ordinal));

        Assert.Equal(5, symbols.Split("[|", StringSplitOptions.None).Length - 1);
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
        Assert.Contains("nil", symbols, StringComparison.Ordinal);
        Assert.Contains("default(ImmutableArray[Type])", symbols, StringComparison.Ordinal);
        Assert.Contains("))|]", symbols, StringComparison.Ordinal);
    }
}
