// <copyright file="Issue3794AnalyzerSnippetPackageSplitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Cs2Gs.Translator.Analyzers;
using GSharp.CodeAnalysis.Analyzers.Testing;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0169 M5, issues #3794 and #3797: the two remaining ways a migrated
/// <c>InternalAnalyzers.Tests</c> case disagreed with its C# original.
///
/// <para>
/// <b>#3794 — package collapse.</b> A G# compilation unit declares exactly one
/// <c>package</c>. Emitting a multi-namespace C# snippet as ONE unit moved
/// every declaration into the first package, so the two namespace-scoped rules
/// judged the wrong ones: GSA0004 found nothing at all in a snippet whose C#
/// original reports four times, and GSA0003 reported a false positive on a
/// declaration the C# exempts precisely because it lives in a different
/// namespace. The snippet is now emitted as one unit per package and the
/// verifier compiles them together.
/// </para>
///
/// <para>
/// <b>#3797 — the one lexical rename.</b> C#'s predefined type keywords become
/// G#'s width-bearing primitive names, so a marker reading
/// <c>typeof(int) != type</c> could not be re-placed on the printed
/// <c>typeof(int32) != type</c> and was dropped, leaving the migrated test with
/// two markers and three ids.
/// </para>
///
/// <para>
/// Every assertion here EXECUTES: the real analyzer is translated, compiled by
/// the real G# compiler, loaded, and run through the real
/// <see cref="GSharpAnalyzerVerifier"/> over the translated snippet — the exact
/// path the migrated test takes. Positives and negatives share that one path,
/// so an analyzer that quietly stopped reporting fails the positive cases
/// instead of passing the negative ones (the #3795 failure mode).
/// </para>
/// </summary>
public sealed class Issue3794AnalyzerSnippetPackageSplitTests : IDisposable
{
    // The real Prelude + positive snippet from
    // EmitCacheKeyRemapScopeAnalyzerTests.ReportsSymbolKeyedReferenceCachesWithoutRemapScope:
    // three namespaces, four expected GSA0004 diagnostics, all in the third.
    private const string Gsa0004Prelude = """
using System.Collections.Generic;

namespace System.Reflection.Metadata
{
    public struct EntityHandle { }
    public struct MemberReferenceHandle { }
    public struct TypeSpecificationHandle { }
    public struct MethodSpecificationHandle { }
    public struct TypeDefinitionHandle { }
    public struct MethodDefinitionHandle { }
    public struct FieldDefinitionHandle { }
}

namespace GSharp.Core.CodeAnalysis.Symbols
{
    public class TypeSymbol { }
    public class StructSymbol { }
    public class TypeParameterSymbol { }
    public class FunctionSymbol { }
}


""";

    private const string Gsa0004Positive = Gsa0004Prelude + """
namespace GSharp.Core.CodeAnalysis.Emit
{
    using System.Reflection.Metadata;
    using GSharp.Core.CodeAnalysis.Symbols;

    internal readonly struct RemapScope { }

    internal readonly struct BadCompositeKey
    {
        private readonly TypeSymbol[] typeArgs;

        public BadCompositeKey(TypeSymbol[] typeArgs) => this.typeArgs = typeArgs;
    }

    internal sealed class Caches
    {
        private readonly Dictionary<StructSymbol, MemberReferenceHandle> [|plainSymbolCache|] = new();
        private readonly Dictionary<(StructSymbol Sym, object ClassRemap, object MethodRemap), EntityHandle> [|objectTupleCache|] = new();
        private readonly Dictionary<BadCompositeKey, MethodSpecificationHandle> [|compositeKeyCache|] = new();

        public Dictionary<TypeParameterSymbol, MemberReferenceHandle> [|NullableCtorRefs|] { get; } = new();
    }
}
""";

    // The real negative snippet from the same class. Under package collapse it
    // passed VACUOUSLY — every declaration had left the Emit package, so
    // silence proved nothing. Split, it is a real exemption test again.
    private const string Gsa0004Negative = Gsa0004Prelude + """
namespace GSharp.Core.CodeAnalysis.Emit
{
    using System.Reflection.Metadata;
    using GSharp.Core.CodeAnalysis.Symbols;

    internal readonly struct RemapScope { }

    internal readonly struct ScopedCompositeKey
    {
        private readonly TypeSymbol[] typeArgs;
        private readonly RemapScope scope;

        public ScopedCompositeKey(TypeSymbol[] typeArgs, RemapScope scope)
        {
            this.typeArgs = typeArgs;
            this.scope = scope;
        }
    }

    internal sealed class Caches
    {
        // Key carries the remap scope: the invariant is satisfied.
        private readonly Dictionary<(StructSymbol Sym, RemapScope Scope), EntityHandle> scopedTupleCache = new();
        private readonly Dictionary<ScopedCompositeKey, MethodSpecificationHandle> scopedCompositeCache = new();

        // Definition rows are scope-invariant: one row per symbol.
        private readonly Dictionary<StructSymbol, TypeDefinitionHandle> typeDefCache = new();
        private readonly Dictionary<FunctionSymbol, MethodDefinitionHandle> methodDefCache = new();

        // Non-symbol keys carry no symbolic type parameters.
        private readonly Dictionary<string, MemberReferenceHandle> stringKeyedCache = new();

        // Non-handle values are not metadata rows.
        private readonly Dictionary<FunctionSymbol, TypeParameterSymbol[]> symbolToSymbolsCache = new();

        public Dictionary<(TypeParameterSymbol Tp, RemapScope Scope), MemberReferenceHandle> ScopedProperty { get; } = new();
    }
}

namespace GSharp.Core.CodeAnalysis.Binding
{
    using System.Reflection.Metadata;
    using GSharp.Core.CodeAnalysis.Symbols;

    // Outside the Emit namespace: not this rule's concern.
    internal sealed class OtherLayer
    {
        private readonly Dictionary<StructSymbol, MemberReferenceHandle> notEmit = new();
    }
}
""";

    // The real positive snippet from
    // StrongStaticReflectionCacheAnalyzerTests.ReportsStaticTypeAssemblyAndModuleDictionaryKeys.
    private const string Gsa0003Positive = """
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Symbols;

class C
{
    private static readonly Dictionary<Type, string> [|TypeCache|] = new();
    private static readonly ConcurrentDictionary<Assembly, string> [|AssemblyCache|] = new();
    private static readonly Dictionary<Module, string> [|ModuleCache|] = new();
}
""";

    // The real negative snippet from the same class: the last cache is exempt
    // ONLY because it lives in a non-metadata namespace, which is exactly what
    // package collapse destroyed.
    private const string Gsa0003Negative = """
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;

namespace GSharp.Core.CodeAnalysis.Symbols
{
    class TypeSymbol { }
    class C
    {
        private static readonly ConcurrentDictionary<TypeSymbol, string> SymbolCache = new();
        private static readonly ConcurrentDictionary<(Type Source, Type Target), string> TupleCache = new();
        private readonly Dictionary<Type, string> InstanceCache = new();
    }
}

namespace GSharp.Core.CodeAnalysis.Syntax
{
    class SyntaxCache
    {
        private static readonly ConcurrentDictionary<Type, string> ChildAccessorsByType = new();
    }
}
""";

    // The real positive snippet from
    // ReflectionTypeComparisonAnalyzerTests.ReportsTypeofReferenceComparisonsInCompilerMetadataNamespaces:
    // the middle marker is the one #3797 dropped.
    private const string Gsa0002Positive = """
using System;

namespace GSharp.Core.CodeAnalysis.Binding
{
    class C
    {
        bool EqualsTypeof(Type type) => [|type == typeof(string)|];
        bool NotEqualsTypeof(Type type) => [|typeof(int) != type|];
        bool ReferenceEqualsTypeof(Type type) => [|ReferenceEquals(type, typeof(string))|];
    }
}
""";

    private readonly DirectoryInfo workDirectory =
        Directory.CreateTempSubdirectory("cs2gs-snippet-package-split");

    public void Dispose()
    {
        try
        {
            workDirectory.Delete(recursive: true);
        }
        catch (IOException)
        {
        }
    }

    /// <summary>
    /// The producer and the consumer of the unit boundary must spell it
    /// identically; cs2gs cannot reference the G# testing assembly it emits
    /// calls into, so the two constants are checked against each other here.
    /// </summary>
    [Fact]
    public void UnitSeparator_IsSpelledIdenticallyOnBothSides()
        => Assert.Equal(GSharpAnalyzerVerifier.UnitSeparator, SnippetTranslator.UnitSeparator);

    /// <summary>
    /// A multi-namespace snippet becomes one G# compilation unit per package,
    /// in declaration order, each declaring its own package.
    /// </summary>
    [Fact]
    public void MultiNamespaceSnippet_EmitsOneUnitPerPackage()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(Gsa0004Positive);

        Assert.NotNull(result.GsWithMarkers);
        Assert.Empty(result.UnplacedMarkers);

        string[] units = SplitUnits(result.GsWithMarkers);
        Assert.Equal(3, units.Length);
        Assert.Contains("package System.Reflection.Metadata", units[0], StringComparison.Ordinal);
        Assert.Contains("package GSharp.Core.CodeAnalysis.Symbols", units[1], StringComparison.Ordinal);
        Assert.Contains("package GSharp.Core.CodeAnalysis.Emit", units[2], StringComparison.Ordinal);

        // All four markers belong to the Emit unit, which is the whole point:
        // before the split they landed in a package the rule does not police.
        Assert.Equal(4, CountMarkers(units[2]));
        Assert.Equal(0, CountMarkers(units[0]) + CountMarkers(units[1]));
    }

    /// <summary>
    /// A single-namespace snippet is still exactly one unit — the separator
    /// never appears where it is not needed, so every hand-written G# analyzer
    /// test and every already-passing migrated one is untouched.
    /// </summary>
    [Fact]
    public void SingleNamespaceSnippet_EmitsNoSeparator()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(Gsa0003Positive);

        Assert.NotNull(result.GsWithMarkers);
        Assert.DoesNotContain(SnippetTranslator.UnitSeparator, result.GsWithMarkers, StringComparison.Ordinal);
    }

    /// <summary>
    /// Issue #3797: the marker whose text carries a predefined type keyword is
    /// placed on the renamed G# text instead of being dropped, and the other
    /// two — whose text is unchanged — still place.
    /// </summary>
    [Fact]
    public void PredefinedTypeMarker_IsPlacedAcrossThePrimitiveRename()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(Gsa0002Positive);

        Assert.NotNull(result.GsWithMarkers);
        Assert.Empty(result.UnplacedMarkers);
        Assert.Equal(3, CountMarkers(result.GsWithMarkers));
        Assert.DoesNotContain(
            result.Diagnostics,
            d => d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId
                && d.Message.Contains("does not survive translation verbatim", StringComparison.Ordinal));
    }

    /// <summary>
    /// GSA0004, end to end, positive AND negative on one path: the real
    /// analyzer, translated and compiled by the real G# compiler, reports
    /// exactly four diagnostics at exactly the four re-placed markers of the
    /// split positive snippet — the case that reported NOTHING before the
    /// split — and stays silent over the split negative one, which before the
    /// split was silent for the wrong reason.
    /// </summary>
    /// <param name="markedSnippet">The C# snippet with its markers.</param>
    /// <param name="ids">The expected diagnostic ids.</param>
    [Theory]
    [MemberData(nameof(Gsa0004Cases))]
    public void TranslatedGsa0004_AgreesWithTheCSharpExpectation(string markedSnippet, string[] ids)
        => VerifyTranslated(
            "EmitCacheKeyRemapScopeAnalyzer.cs",
            "TranslatedGsa0004",
            markedSnippet,
            ids);

    /// <summary>Gets the GSA0004 positive and negative cases.</summary>
    /// <returns>The theory data.</returns>
    public static IEnumerable<object[]> Gsa0004Cases()
    {
        yield return new object[]
        {
            Gsa0004Positive,
            new[] { "GSA0004", "GSA0004", "GSA0004", "GSA0004" },
        };
        yield return new object[] { Gsa0004Negative, Array.Empty<string>() };
    }

    /// <summary>
    /// GSA0003, positive AND negative on one path (theory data, one method):
    /// the positive demands three diagnostics, so an analyzer that has stopped
    /// reporting cannot pass the negative vacuously, and the negative — whose
    /// last cache is exempt only because of its namespace — demands silence.
    /// </summary>
    /// <param name="markedSnippet">The C# snippet with its markers.</param>
    /// <param name="ids">The expected diagnostic ids.</param>
    [Theory]
    [MemberData(nameof(Gsa0003Cases))]
    public void TranslatedGsa0003_AgreesWithTheCSharpExpectation(string markedSnippet, string[] ids)
        => VerifyTranslated(
            "StrongStaticReflectionCacheAnalyzer.cs",
            "TranslatedGsa0003",
            markedSnippet,
            ids);

    /// <summary>Gets the GSA0003 positive and negative cases.</summary>
    /// <returns>The theory data.</returns>
    public static IEnumerable<object[]> Gsa0003Cases()
    {
        yield return new object[] { Gsa0003Positive, new[] { "GSA0003", "GSA0003", "GSA0003" } };
        yield return new object[] { Gsa0003Negative, Array.Empty<string>() };
    }

    /// <summary>
    /// Translates <paramref name="markedSnippet"/>, translates and compiles the
    /// named analyzer, and runs the real verifier over both.
    /// </summary>
    /// <param name="analyzerFileName">The analyzer source file name.</param>
    /// <param name="assemblyName">The emitted analyzer assembly name.</param>
    /// <param name="markedSnippet">The marked C# snippet.</param>
    /// <param name="ids">The expected diagnostic ids.</param>
    private void VerifyTranslated(
        string analyzerFileName,
        string assemblyName,
        string markedSnippet,
        params string[] ids)
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(markedSnippet);
        Assert.NotNull(result.GsWithMarkers);
        Assert.Empty(result.UnplacedMarkers);

        string analyzerDll = Adr0169TranslatedAnalyzerHarness.CompileTranslatedAnalyzer(
            workDirectory.FullName, analyzerFileName, assemblyName);
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, result.GsWithMarkers, ids);
    }

    private static string[] SplitUnits(string source)
        => source.Split(SnippetTranslator.UnitSeparator, StringSplitOptions.None);

    private static int CountMarkers(string source)
    {
        var count = 0;
        for (var i = 0; i + 1 < source.Length; i++)
        {
            if (source[i] == '[' && source[i + 1] == '|')
            {
                count++;
            }
        }

        return count;
    }
}
