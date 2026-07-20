// <copyright file="Issue2523IncludableQueryableBaseInterfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2523: an imported generic method (EF Core's <c>Include</c>/
/// <c>ThenInclude</c>) can correctly infer a nullable-reference type argument
/// from an expression-tree lambda (#2498/#2499), but the resulting imported
/// constructed interface then failed to convert to its declared CLR base
/// interface (<c>IIncludableQueryable&lt;TEntity,TProperty&gt;</c> implements
/// <c>IQueryable&lt;TEntity&gt;</c>), because the erasure that builds the
/// constructed return's type-erased CLR shape collapsed EVERY type-argument
/// slot to <c>object</c> — including the unrelated, already-concrete
/// <c>TEntity</c> slot — whenever ANY slot (the nullable <c>TProperty</c>)
/// needed symbolic preservation. <c>IIncludableQueryable&lt;object,object&gt;</c>
/// does not implement <c>IQueryable&lt;Entity&gt;</c>, so every downstream
/// conversion/receiver check for the OTHER slot broke (GS0155 direct, GS0159
/// once a chained call needed the receiver to also be a valid
/// <c>IQueryable&lt;TEntity&gt;</c>).
/// </summary>
public sealed class Issue2523IncludableQueryableBaseInterfaceTests
{
    private const string DataLibrarySource = """
        package Issue2523Data
        import System.Collections.Generic

        class Child2523 {
        }

        class Other2523 {
        }

        class Entity2523 {
            prop Child Child2523? { get; set; }
            prop Other Other2523? { get; set; }
        }

        class NonNullEntity2523 {
            prop Child Child2523 { get; set; }
        }

        class Conversion2523 {
        }

        class Component2523 {
            prop Conversion Conversion2523? { get; set; }
        }

        class Book2523 {
            prop Conversion Conversion2523? { get; set; }
            prop Components List[Component2523] { get; set; }
        }
        """;

    private static readonly string DataLibraryPath = EmitDataLibrary();

    [Fact]
    public void TwoIncludeChain_MetadataEntityAndNavigationTypes_BindsWithoutDiagnostics()
    {
        // The issue's own minimal two-project repro: Entity/Child/Other are
        // imported (metadata) types, both navigation properties nullable.
        // Before the fix the SECOND Include reported GS0159 ("Cannot find
        // function Include") because the first Include's result could not be
        // used as the IQueryable[Entity2523] receiver the second Include
        // requires.
        AssertBinds("""
            package Consumer
            import System.Linq
            import Microsoft.EntityFrameworkCore
            import Issue2523Data

            func Build(source IQueryable[Entity2523]) IQueryable[Entity2523] ->
                source.Include((e Entity2523) -> e.Child).Include((e Entity2523) -> e.Other)
            """);
    }

    [Fact]
    public void ChainedIncludeThenIncludeInclude_ThreeLevelOahuTopology_BindsWithoutDiagnostics()
    {
        // Oahu evidence from the issue: Include(single-nav).Include(collection-nav).ThenInclude(single-nav),
        // every navigation nullable. This additionally exercises a SECOND,
        // deeper gap: ThenInclude's receiver is itself a chained Include
        // result whose own two type arguments were already fully concrete
        // (so #833's symbolic construction never ran for IT), yet ThenInclude
        // still needs to recover TEntity structurally from that receiver.
        AssertBinds("""
            package Consumer2
            import System.Linq
            import System.Collections.Generic
            import Microsoft.EntityFrameworkCore
            import Issue2523Data

            func Build(source IQueryable[Book2523]) IQueryable[Book2523] ->
                source.Include((b Book2523) -> b.Conversion)
                    .Include((b Book2523) -> b.Components)
                    .ThenInclude((c Component2523) -> c.Conversion)
            """);
    }

    [Fact]
    public void IsolatedConversions_AssignmentReturnArgumentAndExtensionReceiver_AllSucceed()
    {
        // The issue's "Isolated conversion evidence": IIncludableQueryable
        // [Entity,Child?] -> IQueryable[Entity] must succeed as an
        // assignment, a function return, an argument, and (via chained
        // Include) an extension-method receiver conversion.
        AssertBinds("""
            package Consumer3
            import System.Linq
            import Microsoft.EntityFrameworkCore
            import Issue2523Data

            func TakesQueryable(q IQueryable[Entity2523]) int32 -> 0

            func AsAssignment(source IQueryable[Entity2523]) IQueryable[Entity2523] {
                let included IQueryable[Entity2523] = source.Include((e Entity2523) -> e.Child)
                return included
            }

            func AsReturn(source IQueryable[Entity2523]) IQueryable[Entity2523] ->
                source.Include((e Entity2523) -> e.Child)

            func AsArgument(source IQueryable[Entity2523]) int32 ->
                TakesQueryable(source.Include((e Entity2523) -> e.Child))

            func AsExtensionReceiver(source IQueryable[Entity2523]) IQueryable[Entity2523] ->
                source.Include((e Entity2523) -> e.Child).Where((e Entity2523) -> e.Other != nil)
            """);
    }

    [Theory]
    [InlineData("EntitySourceEntity", "package Issue2523.SourceSource\nimport System.Linq\nimport Microsoft.EntityFrameworkCore\n\nclass SourceEntitySs2523 {\n}\n\nclass SourceNavSs2523 {\n}\n\nfunc Build(source IQueryable[SourceEntitySs2523]) IQueryable[SourceEntitySs2523] ->\n    source.Include((e SourceEntitySs2523) -> default(SourceNavSs2523?)).Include((e SourceEntitySs2523) -> default(SourceNavSs2523?))")]
    [InlineData("SourceEntityMetadataNav", "package Issue2523.SourceMetadata\nimport System.Linq\nimport Microsoft.EntityFrameworkCore\nimport Issue2523Data\n\nclass SourceEntitySm2523 {\n}\n\nfunc Build(source IQueryable[SourceEntitySm2523]) IQueryable[SourceEntitySm2523] ->\n    source.Include((e SourceEntitySm2523) -> default(Child2523?)).Include((e SourceEntitySm2523) -> default(Other2523?))")]
    [InlineData("MetadataEntitySourceNav", "package Issue2523.MetadataSource\nimport System.Linq\nimport Microsoft.EntityFrameworkCore\nimport Issue2523Data\n\nclass SourceNavMs2523 {\n}\n\nfunc Build(source IQueryable[Entity2523]) IQueryable[Entity2523] ->\n    source.Include((e Entity2523) -> default(SourceNavMs2523?)).Include((e Entity2523) -> default(SourceNavMs2523?))")]
    [InlineData("MetadataEntityMetadataNav", "package Issue2523.MetadataMetadata\nimport System.Linq\nimport Microsoft.EntityFrameworkCore\nimport Issue2523Data\n\nfunc Build(source IQueryable[Entity2523]) IQueryable[Entity2523] ->\n    source.Include((e Entity2523) -> e.Child).Include((e Entity2523) -> e.Other)")]
    public void EntityNavigationTypeCombinations_SourceAndMetadataMixes_BindWithoutDiagnostics(string scenario, string source)
    {
        // Contributor-ready coverage requirement: source/source, source/
        // metadata, metadata/source, and metadata/metadata entity/navigation
        // types must all bind the chained Include without diagnostics.
        Assert.NotNull(scenario);
        AssertBinds(source);
    }

    [Fact]
    public void NonNullNavigation_Control_StillBindsWithoutDiagnostics()
    {
        // Control from the issue: a non-nullable first navigation already
        // worked before the fix and must keep working after it.
        AssertBinds("""
            package Consumer4
            import System.Linq
            import Microsoft.EntityFrameworkCore
            import Issue2523Data

            func Build(source IQueryable[NonNullEntity2523]) IQueryable[NonNullEntity2523] ->
                source.Include((e NonNullEntity2523) -> e.Child)
            """);
    }

    [Fact]
    public void NullableAnnotationIsPreserved_NotStripped()
    {
        // Issue #2498/#2523 constraint: the fix must not strip `?` to make
        // the call bind. Assigning `nil` through the inferred TProperty
        // position (mirroring Issue2498's own verification idiom) fails to
        // bind (GS0155 nil-into-non-nullable) unless the nullable annotation
        // genuinely survived the round trip through Include's return type.
        var diagnostics = Bind("""
            package Consumer5
            import System.Linq
            import Microsoft.EntityFrameworkCore
            import Issue2523Data

            func Build(source IQueryable[Entity2523], holder Child2523) Child2523 {
                var slot Child2523? = nil
                let included = source.Include((e Entity2523) -> e.Child)
                slot = holder
                return holder
            }
            """);
        Assert.DoesNotContain(diagnostics, d => d.IsError);

        // Control: forcing a non-nullable target for the SAME inferred
        // nullable navigation must still be rejected — proving `?` was
        // never silently dropped from the recovered TProperty.
        var rejected = Bind("""
            package Consumer5Control
            import System.Linq
            import Microsoft.EntityFrameworkCore
            import Issue2523Data

            func ExtractChild(source IQueryable[Entity2523]) Child2523 {
                let items = source.Include((e Entity2523) -> e.Child)
                for item in items {
                    return item.Child
                }

                return default(Child2523)
            }
            """);
        Assert.Contains(rejected, d => d.Id == "GS0155");
    }

    [Fact]
    public void GroupByGeneralization_SubsetSubstitutionWithNullableReferenceKey_BindsWithoutDiagnostics()
    {
        // Generalizes the root cause beyond EF Core using a plain BCL
        // example with the SAME shape: Enumerable.GroupBy returns
        // IGrouping[TKey,TElement] (both covariant, #1927 territory), whose
        // declared base IEnumerable[TElement] substitutes only a SUBSET
        // (TElement) of the two type parameters — the same "subset
        // substitution" pattern as IIncludableQueryable[TEntity,TProperty]
        // dropping TProperty from its IQueryable[TEntity] base. TElement
        // (Entity2523) is an imported metadata type so this exercises the
        // SAME preserve-the-concrete-slot code path as the EF Core tests
        // above (a BCL `string`/`int32` "kept" slot cannot: those live on
        // process-wide `TypeSymbol.String`/`TypeSymbol.Int32` singletons
        // bound to the LIVE host CLR, an orthogonal characteristic that
        // makes `MakeGenericType` reject combining them with a type resolved
        // through this test's own MetadataLoadContext-backed resolver —
        // unrelated to the #2523 fix itself, which already degrades
        // gracefully to the pre-fix erasure whenever that happens).
        AssertBinds("""
            package Consumer6
            import System.Linq
            import System.Collections.Generic
            import Issue2523Data

            func WithNullableReferenceKey(source []Entity2523) IEnumerable[Entity2523] {
                let groups = source.GroupBy((e Entity2523) -> e.Other).ToArray()
                let firstGroup = groups[0]
                let asEnumerable IEnumerable[Entity2523] = firstGroup
                return asEnumerable
            }
            """);
    }

    [Fact]
    public void GroupByGeneralization_NullableValueKey_ControlStillBindsWithoutDiagnostics()
    {
        // Control mirroring the issue's "value-type Nullable<T> controls"
        // requirement: a nullable VALUE-typed key (int32?) needs no #2523
        // symbolic-erasure recovery at all — reflection already represents
        // Nullable<T> faithfully — so this exercises the pre-existing,
        // already-correct path and must keep working unchanged.
        AssertBinds("""
            package Consumer6Value
            import System.Linq
            import System.Collections.Generic

            func WithNullableValueKey(source []string) IEnumerable[string] {
                let groups = source.GroupBy((value string) ->
                    if value.Length > 0 { value.Length } else { default(int32?) }).ToArray()
                let firstGroup = groups[0]
                let asEnumerable IEnumerable[string] = firstGroup
                return asEnumerable
            }
            """);
    }

    private static string EmitDataLibrary()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2523Data");
        Directory.CreateDirectory(directory);
        var libraryPath = Path.Combine(directory, "Issue2523.Data.dll");
        var library = new Compilation(SyntaxTree.Parse(SourceText.From(DataLibrarySource)))
        {
            IsLibrary = true,
        };

        using var peStream = File.Create(libraryPath);
        var result = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2523.Data");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }

    private static void AssertBinds(string source)
    {
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var paths = new List<string>();
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (!string.IsNullOrEmpty(tpa))
        {
            paths.AddRange(tpa.Split(Path.PathSeparator).Where(File.Exists));
        }

        paths.AddRange(EfCoreAssemblyPaths());
        paths.Add(DataLibraryPath);

        using var resolver = ReferenceResolver.WithReferences(paths.Distinct());
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), resolver);
        var program = Binder.BindProgram(globalScope, resolver);
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }

    private static IEnumerable<string> EfCoreAssemblyPaths()
    {
        // Force the EF Core assemblies to be loaded in the current process
        // (Core.Tests.csproj references Microsoft.EntityFrameworkCore.Relational,
        // which transitively pulls in the main EFCore + Abstractions
        // assemblies that declare Include/ThenInclude/IIncludableQueryable),
        // then hand every already-loaded EFCore-named assembly's path to the
        // resolver so `import Microsoft.EntityFrameworkCore` resolves.
        _ = typeof(Microsoft.EntityFrameworkCore.DbContext);
        return AppDomain.CurrentDomain.GetAssemblies()
            .Where(a => !a.IsDynamic
                && a.GetName().Name?.StartsWith("Microsoft.EntityFrameworkCore", StringComparison.Ordinal) == true)
            .Select(a => a.Location)
            .Where(location => !string.IsNullOrEmpty(location));
    }
}
