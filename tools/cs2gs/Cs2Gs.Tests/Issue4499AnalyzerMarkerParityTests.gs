// <copyright file="Issue4499AnalyzerMarkerParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Translator
import Cs2Gs.Translator.Analyzers
import System
import System.Linq
import Xunit

class Issue4499AnalyzerMarkerParityTests {
    @Fact
    func MarkersSurviveFormattingAndStayWithTheirCompilationUnit() {
        let result = SnippetTranslator.Translate(Source)
        Assert.True(
            result.GsWithMarkers != nil,
            string.Join(
                Environment.NewLine,
                result.Diagnostics.Select((diagnostic TranslationDiagnostic) -> diagnostic.Message)
            )
        )
        Assert.Empty(result.UnplacedMarkers)
        Assert.Equal(6, result.GsWithMarkers!!.Split("[|", StringSplitOptions.None).Length - 1)
        let units = result.GsWithMarkers!!.Split(SnippetTranslator.UnitSeparator, StringSplitOptions.None)
        Assert.Equal(2, units.Length)
        let symbols = Assert.Single(
            units,
            (unit string) -> unit.Contains("package Outer.Symbols", StringComparison.Ordinal)
        )
        let binding = Assert.Single(units, (unit string) -> unit.Contains("package Binding", StringComparison.Ordinal))
        Assert.Equal(6, symbols.Split("[|", StringSplitOptions.None).Length - 1)
        Assert.DoesNotContain("[|", binding, StringComparison.Ordinal)
        Assert.Contains("-> [|typeof(int32)|]", symbols, StringComparison.Ordinal)
        Assert.DoesNotContain("// [|typeof(int32)|]", symbols, StringComparison.Ordinal)
        Assert.Contains("[|Door.Convert(type)|]", symbols, StringComparison.Ordinal)
        Assert.Contains("[|Door.Map(", symbols, StringComparison.Ordinal)
        let earlierTranslatedSpelling = symbols.IndexOf("Door.Map(typeof(int32), nil,", StringComparison.Ordinal)
        let markedRenamedCall = symbols.IndexOf("[|Door.Map(typeof(int32), nil,", StringComparison.Ordinal)
        Assert.True(earlierTranslatedSpelling >= 0 && markedRenamedCall > earlierTranslatedSpelling)
        Assert.Contains("let _ = [|Door.Map(", symbols, StringComparison.Ordinal)
        Assert.Contains(
            "// Door.Map(typeof(int32), nil, default(ImmutableArray[Type]))",
            symbols,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "\"Door.Map(typeof(int32), nil, default(ImmutableArray[Type]))\"",
            symbols,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("// [|Door.Map", symbols, StringComparison.Ordinal)
        Assert.DoesNotContain("\"[|Door.Map", symbols, StringComparison.Ordinal)
        Assert.Contains("nil", symbols, StringComparison.Ordinal)
        Assert.Contains("default(ImmutableArray[Type])", symbols, StringComparison.Ordinal)
        Assert.Contains("))|]", symbols, StringComparison.Ordinal)
        let earlierExplicitDefault = symbols.IndexOf("Door.Tuple(default((int32, string)))", StringComparison.Ordinal)
        let markedContextualDefault = symbols.IndexOf(
            "[|Door.Tuple(default((int32, string)))|]",
            StringComparison.Ordinal
        )
        Assert.True(earlierExplicitDefault >= 0 && markedContextualDefault > earlierExplicitDefault)
        let earlierPackageCall = symbols.IndexOf("Math.Abs(value)", StringComparison.Ordinal)
        let markedGlobalCall = symbols.IndexOf("[|Math.Abs(value)|]", StringComparison.Ordinal)
        Assert.True(earlierPackageCall >= 0 && markedGlobalCall > earlierPackageCall)
    }

    @Fact
    func FormattingFallbackPreservesAliasSpellingInItsOrdinal() {
        const source = `using System;

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
}`
        let result = SnippetTranslator.Translate(source)
        Assert.NotNull(result.GsWithMarkers)
        Assert.True(
            result.UnplacedMarkers.Count == 0,
            result.GsWithMarkers + Environment.NewLine + string.Join(Environment.NewLine, result.UnplacedMarkers)
        )
        let earlierAliasCall = result.GsWithMarkers!!.IndexOf("Door.Map(", StringComparison.Ordinal)
        let markedPredefinedCall = result.GsWithMarkers!!.IndexOf("[|Door.Map(", StringComparison.Ordinal)
        Assert.True(earlierAliasCall >= 0 && markedPredefinedCall > earlierAliasCall)
        Assert.Contains("integer.Parse", result.GsWithMarkers, StringComparison.Ordinal)
        Assert.Contains("int32.Parse", result.GsWithMarkers, StringComparison.Ordinal)
    }

    @Fact
    func NonExpressionMarkerIsReportedUnplacedInsteadOfThrowing() {
        let result = SnippetTranslator.Translate(`class Consumer
{
    void Use()
    {
        [|return;|]
    }
}`)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Equal([]string{"return;"}, result.UnplacedMarkers)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.DiagnosticId == SnippetTranslator.SnippetDiagnosticId
        )
    }

    @Fact
    func FormattingFallbackCountsExplicitDefaultsIndependentOfTheirType() {
        let result = SnippetTranslator.Translate(`static class Door
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
}`)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Empty(result.UnplacedMarkers)
        let earlier = result.GsWithMarkers!!.IndexOf("Door.Map(", StringComparison.Ordinal)
        let marked = result.GsWithMarkers!!.IndexOf("[|Door.Map(", StringComparison.Ordinal)
        Assert.True(earlier >= 0 && marked > earlier)
    }

    @Fact
    func MarkerInNamespaceWithoutAnEmittedUnitIsReportedUnplaced() {
        let result = SnippetTranslator.Translate(`namespace One
{
    class First { }
}

namespace [|Empty|]
{
}

namespace Two
{
    class Second { }
}`)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Equal([]string{"Empty"}, result.UnplacedMarkers)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.DiagnosticId == SnippetTranslator.SnippetDiagnosticId
        )
    }

    @Fact
    func MarkerInEmptyNamespaceIsUnplacedWithOneEmittedPackage() {
        let result = SnippetTranslator.Translate(`namespace [|Empty|]
{
}

namespace One
{
    class Consumer
    {
        void Use()
        {
            int Empty = 0;
        }
    }
}`)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Equal([]string{"Empty"}, result.UnplacedMarkers)
        Assert.DoesNotContain("[|Empty|]", result.GsWithMarkers, StringComparison.Ordinal)
    }

    @Fact
    func FormattingFallbackCanPlaceMarkerInsideInterpolationHole() {
        let result = SnippetTranslator.Translate(`using System;
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
}`)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Empty(result.UnplacedMarkers)
        Assert.Contains("$${[|Door.Map(", result.GsWithMarkers, StringComparison.Ordinal)
        Assert.DoesNotContain("// [|Door.Map", result.GsWithMarkers, StringComparison.Ordinal)
        Assert.DoesNotContain("\"[|Door.Map", result.GsWithMarkers, StringComparison.Ordinal)
    }

    @Fact
    func FormattingFallbackMatchesOnlyWholeTargetExpressions() {
        let result = SnippetTranslator.Translate(`using System;
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
}`)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Empty(result.UnplacedMarkers)
        let qualified = result.GsWithMarkers!!.IndexOf("this.Door.Map(", StringComparison.Ordinal)
        let marked = result.GsWithMarkers!!.IndexOf("[|Door.Map(", StringComparison.Ordinal)
        Assert.True(qualified >= 0 && marked > qualified, result.GsWithMarkers)
    }

    @Fact
    func FormattingFallbackToleratesNullAssertionAfterCompositeReceivers() {
        let result = SnippetTranslator.Translate(`using System.Collections.Immutable;

class Door
{
    public object Map(object other, ImmutableArray<object> arguments) => this;
}

class Consumer
{
    Door? Find() => null;
    ImmutableArray<Door?> Nodes => default;

    void Use()
    {
        _ = [|Find().Map(null, default)|];
        _ = [|Nodes[0].Map(null, default)|];
    }
}`)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Empty(result.UnplacedMarkers)
        Assert.Contains("[|Find()!!.Map(nil, default(", result.GsWithMarkers, StringComparison.Ordinal)
        Assert.Contains("[|Nodes[0]!!.Map(nil, default(", result.GsWithMarkers, StringComparison.Ordinal)
    }

    shared {
        private const Source string = `using System;
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
}`
    }
}
