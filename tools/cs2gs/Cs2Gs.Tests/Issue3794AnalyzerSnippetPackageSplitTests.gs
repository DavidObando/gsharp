// <copyright file="Issue3794AnalyzerSnippetPackageSplitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Cs2Gs.Translator.Analyzers
import GSharp.CodeAnalysis.Analyzers.Testing
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import Xunit
import Cs2Gs.Translator

/// ADR-0169 M5, issues #3794 and #3797: the two remaining ways a migrated
/// `InternalAnalyzers.Tests` case disagreed with its C# original.
///
/// <b>#3794 — package collapse.</b> A G# compilation unit declares exactly one
/// `package`. Emitting a multi-namespace C# snippet as ONE unit moved
/// every declaration into the first package, so the two namespace-scoped rules
/// judged the wrong ones: GSA0004 found nothing at all in a snippet whose C#
/// original reports four times, and GSA0003 reported a false positive on a
/// declaration the C# exempts precisely because it lives in a different
/// namespace. The snippet is now emitted as one unit per package and the
/// verifier compiles them together.
///
/// <b>#3797 — the one lexical rename.</b> C#'s predefined type keywords become
/// G#'s width-bearing primitive names, so a marker reading
/// `typeof(int) != type` could not be re-placed on the printed
/// `typeof(int32) != type` and was dropped, leaving the migrated test with
/// two markers and three ids.
///
/// Every assertion here EXECUTES: the real analyzer is translated, compiled by
/// the real G# compiler, loaded, and run through the real
/// (cref:GSharpAnalyzerVerifier) over the translated snippet — the exact
/// path the migrated test takes. Positives and negatives share that one path,
/// so an analyzer that quietly stopped reporting fails the positive cases
/// instead of passing the negative ones (the #3795 failure mode).
class Issue3794AnalyzerSnippetPackageSplitTests : IDisposable {
    private let workDirectory DirectoryInfo = Directory.CreateTempSubdirectory("cs2gs-snippet-package-split")

    func Dispose() {
        try {
            workDirectory.Delete(recursive: true)
        } catch (IOException) { }
    }

    /// The producer and the consumer of the unit boundary must spell it
    /// identically; cs2gs cannot reference the G# testing assembly it emits
    /// calls into, so the two constants are checked against each other here.
    @Fact
    func UnitSeparator_IsSpelledIdenticallyOnBothSides() -> Assert.Equal(
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier.UnitSeparator,
        SnippetTranslator.UnitSeparator
    )

    /// A multi-namespace snippet becomes one G# compilation unit per package,
    /// in declaration order, each declaring its own package.
    @Fact
    func MultiNamespaceSnippet_EmitsOneUnitPerPackage() {
        let result = SnippetTranslator.Translate(Gsa0004Positive)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Empty(result.UnplacedMarkers)
        let units = SplitUnits(result.GsWithMarkers)
        Assert.Equal(3, units.Length)
        Assert.Contains("package System.Reflection.Metadata", units[0], StringComparison.Ordinal)
        Assert.Contains("package GSharp.Core.CodeAnalysis.Symbols", units[1], StringComparison.Ordinal)
        Assert.Contains("package GSharp.Core.CodeAnalysis.Emit", units[2], StringComparison.Ordinal)
        // All four markers belong to the Emit unit, which is the whole point:
        // before the split they landed in a package the rule does not police.
        Assert.Equal(4, CountMarkers(units[2]))
        Assert.Equal(0, CountMarkers(units[0]) + CountMarkers(units[1]))
    }

    /// A global-namespace declaration in a multi-namespace snippet belongs to
    /// no package filter, so it lands in the first unit, exactly once, instead
    /// of vanishing from every unit.
    @Fact
    func MultiNamespaceSnippet_KeepsGlobalDeclarationsInTheFirstUnit() {
        let result = SnippetTranslator.Translate(`namespace First.Space
{
    public class Alpha { }
}

namespace Second.Space
{
    public class Beta { }
}

public class GlobalGamma { }`)
        Assert.NotNull(result.GsWithMarkers)
        let units = SplitUnits(result.GsWithMarkers)
        Assert.Equal(2, units.Length)
        Assert.Contains("class GlobalGamma", units[0], StringComparison.Ordinal)
        Assert.DoesNotContain("class GlobalGamma", units[1], StringComparison.Ordinal)
    }

    /// A single-namespace snippet is still exactly one unit — the separator
    /// never appears where it is not needed, so every hand-written G# analyzer
    /// test and every already-passing migrated one is untouched.
    @Fact
    func SingleNamespaceSnippet_EmitsNoSeparator() {
        let result = SnippetTranslator.Translate(Gsa0003Positive)
        Assert.NotNull(result.GsWithMarkers)
        Assert.DoesNotContain(SnippetTranslator.UnitSeparator, result.GsWithMarkers, StringComparison.Ordinal)
    }

    /// Issue #3797: the marker whose text carries a predefined type keyword is
    /// placed on the renamed G# text instead of being dropped, and the other
    /// two — whose text is unchanged — still place.
    @Fact
    func PredefinedTypeMarker_IsPlacedAcrossThePrimitiveRename() {
        let result = SnippetTranslator.Translate(Gsa0002Positive)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Empty(result.UnplacedMarkers)
        Assert.Equal(3, CountMarkers(result.GsWithMarkers))
        Assert.DoesNotContain(
            result.Diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId &&
                d.Message!!.Contains("does not survive translation verbatim", StringComparison.Ordinal)
        )
    }

    /// GSA0004, end to end, positive AND negative on one path: the real
    /// analyzer, translated and compiled by the real G# compiler, reports
    /// exactly four diagnostics at exactly the four re-placed markers of the
    /// split positive snippet — the case that reported NOTHING before the
    /// split — and stays silent over the split negative one, which before the
    /// split was silent for the wrong reason.
    /// @param markedSnippet The C# snippet with its markers.
    /// @param ids The expected diagnostic ids.
    @Theory
    @MemberData("Gsa0004Cases")
    func TranslatedGsa0004_AgreesWithTheCSharpExpectation(markedSnippet string, ids[]string) -> VerifyTranslated(
        "EmitCacheKeyRemapScopeAnalyzer.cs",
        "TranslatedGsa0004",
        markedSnippet,
        ids
    )

    /// GSA0003, positive AND negative on one path (theory data, one method):
    /// the positive demands three diagnostics, so an analyzer that has stopped
    /// reporting cannot pass the negative vacuously, and the negative — whose
    /// last cache is exempt only because of its namespace — demands silence.
    /// @param markedSnippet The C# snippet with its markers.
    /// @param ids The expected diagnostic ids.
    @Theory
    @MemberData("Gsa0003Cases")
    func TranslatedGsa0003_AgreesWithTheCSharpExpectation(markedSnippet string, ids[]string) -> VerifyTranslated(
        "StrongStaticReflectionCacheAnalyzer.cs",
        "TranslatedGsa0003",
        markedSnippet,
        ids
    )

    /// Translates [`markedSnippet`](paramref), translates and compiles the
    /// named analyzer, and runs the real verifier over both.
    /// @param analyzerFileName The analyzer source file name.
    /// @param assemblyName The emitted analyzer assembly name.
    /// @param markedSnippet The marked C# snippet.
    /// @param ids The expected diagnostic ids.
    private func VerifyTranslated(analyzerFileName string, assemblyName string, markedSnippet string, ids ...string) {
        let result = SnippetTranslator.Translate(markedSnippet)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Empty(result.UnplacedMarkers)
        let analyzerDll = Adr0169TranslatedAnalyzerHarness.CompileTranslatedAnalyzer(
            workDirectory.FullName,
            analyzerFileName,
            assemblyName
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        GSharp
            .CodeAnalysis
            .Analyzers
            .Testing
            .GSharpAnalyzerVerifier
            .VerifyAnalyzer(analyzer, result.GsWithMarkers!!, ids)
    }

    shared {
        // The real Prelude + positive snippet from
        // EmitCacheKeyRemapScopeAnalyzerTests.ReportsSymbolKeyedReferenceCachesWithoutRemapScope:
        // three namespaces, four expected GSA0004 diagnostics, all in the third.
        private const Gsa0004Prelude string = `using System.Collections.Generic;

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

`

        private const Gsa0004Positive string = Gsa0004Prelude + `namespace GSharp.Core.CodeAnalysis.Emit
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
}`

        // The real negative snippet from the same class. Under package collapse it
        // passed VACUOUSLY — every declaration had left the Emit package, so
        // silence proved nothing. Split, it is a real exemption test again.
        private const Gsa0004Negative string = Gsa0004Prelude + `namespace GSharp.Core.CodeAnalysis.Emit
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
}`

        // The real positive snippet from
        // StrongStaticReflectionCacheAnalyzerTests.ReportsStaticTypeAssemblyAndModuleDictionaryKeys.
        private const Gsa0003Positive string = `using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Symbols;

class C
{
    private static readonly Dictionary<Type, string> [|TypeCache|] = new();
    private static readonly ConcurrentDictionary<Assembly, string> [|AssemblyCache|] = new();
    private static readonly Dictionary<Module, string> [|ModuleCache|] = new();
}`

        // The real negative snippet from the same class: the last cache is exempt
        // ONLY because it lives in a non-metadata namespace, which is exactly what
        // package collapse destroyed.
        private const Gsa0003Negative string = `using System;
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
}`

        // The real positive snippet from
        // ReflectionTypeComparisonAnalyzerTests.ReportsTypeofReferenceComparisonsInCompilerMetadataNamespaces:
        // the middle marker is the one #3797 dropped.
        private const Gsa0002Positive string = `using System;

namespace GSharp.Core.CodeAnalysis.Binding
{
    class C
    {
        bool EqualsTypeof(Type type) => [|type == typeof(string)|];
        bool NotEqualsTypeof(Type type) => [|typeof(int) != type|];
        bool ReferenceEqualsTypeof(Type type) => [|ReferenceEquals(type, typeof(string))|];
    }
}`

        /// Gets the GSA0004 positive and negative cases.
        /// @returns The theory data.
        func Gsa0004Cases() sequence[[]object] {
            yield[]object{Gsa0004Positive, []string{"GSA0004", "GSA0004", "GSA0004", "GSA0004"}}
            yield[]object{Gsa0004Negative, Array.Empty[string]()}
        }

        /// Gets the GSA0003 positive and negative cases.
        /// @returns The theory data.
        func Gsa0003Cases() sequence[[]object] {
            yield[]object{Gsa0003Positive, []string{"GSA0003", "GSA0003", "GSA0003"}}
            yield[]object{Gsa0003Negative, Array.Empty[string]()}
        }

        private func SplitUnits(source string?)[]string -> source!!.Split(
            SnippetTranslator.UnitSeparator,
            StringSplitOptions.None
        )

        private func CountMarkers(source string?) int32 {
            var count = 0
            for var i = 0; i + 1 < source!!.Length; i++ {
                if source!![i] == '[' && source!![i + 1] == '|' {
                    count++
                }
            }
            return count
        }
    }
}
