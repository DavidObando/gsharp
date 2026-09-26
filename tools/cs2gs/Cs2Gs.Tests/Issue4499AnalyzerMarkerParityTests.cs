// <copyright file="Issue4499AnalyzerMarkerParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
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
        class Consumer
        {
            // typeof(int32) is already the translated spelling.
            Type Primitive() => [|typeof(int)|];

            void Use(Type type, EventInfo evt)
            {
                _ = [|Door.Convert(type)|];
                // Door.Map(evt.EventHandlerType, null, default) must not affect expression ordinals.
                _ = [|Door.Map(evt.EventHandlerType, null, default)|];
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

        Assert.NotNull(result.GsWithMarkers);
        Assert.Empty(result.UnplacedMarkers);
        Assert.Equal(4, result.GsWithMarkers.Split("[|", StringSplitOptions.None).Length - 1);

        string[] units = result.GsWithMarkers.Split(
            SnippetTranslator.UnitSeparator,
            StringSplitOptions.None);
        Assert.Equal(2, units.Length);
        string symbols = Assert.Single(units, unit => unit.Contains("package Outer.Symbols", StringComparison.Ordinal));
        string binding = Assert.Single(units, unit => unit.Contains("package Binding", StringComparison.Ordinal));

        Assert.Equal(4, symbols.Split("[|", StringSplitOptions.None).Length - 1);
        Assert.DoesNotContain("[|", binding, StringComparison.Ordinal);
        Assert.Contains("-> [|typeof(int32)|]", symbols, StringComparison.Ordinal);
        Assert.DoesNotContain("// [|typeof(int32)|]", symbols, StringComparison.Ordinal);
        Assert.Contains("[|Door.Convert(type)|]", symbols, StringComparison.Ordinal);
        Assert.Contains("[|Door.Map(", symbols, StringComparison.Ordinal);
        Assert.Contains("nil", symbols, StringComparison.Ordinal);
        Assert.Contains("default(ImmutableArray[Type])", symbols, StringComparison.Ordinal);
        Assert.Contains("))|]", symbols, StringComparison.Ordinal);
    }
}
