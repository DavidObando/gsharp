// <copyright file="Issue2523NullableImportedGenericBaseConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures
import Microsoft.EntityFrameworkCore
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Linq.Expressions
import Xunit

/// Issue #2523: symbolic nullable arguments on an imported generic return
/// must not erase the return's declared generic base interfaces.
class Issue2523NullableImportedGenericBaseConversionTests {
    @Fact
    func InferredExplicitReducedAndChainedCallsKeepImportedBaseConversions() {
        AssertBinds(`import System.Collections.Generic
import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures

class LocalChild2523 {
    prop Name string { get; init; }
}

class LocalOther2523 {
}

class LocalEntity2523 {
    prop Child LocalChild2523? { get; init; }
    prop Other LocalOther2523? { get; init; }
    prop MetadataChild MetadataChild2523? { get; init; }
}

func Consume2523(value IQuery2523[LocalEntity2523]) { }

func Return2523(source IQuery2523[LocalEntity2523]) IQuery2523[LocalEntity2523] {
    let first = source.Include2523(
        (entity LocalEntity2523) -> entity.Child)
    let assigned IQuery2523[LocalEntity2523] = first
    Consume2523(first)

    let consecutive = first.Include2523(
        (entity LocalEntity2523) -> entity.Other)
    let components = source.Include2523(
        (entity LocalEntity2523) ->
            List[LocalChild2523]())
    let thenIncluded = components.ThenInclude2523(
        (child LocalChild2523) -> child.Name)
    let resumed = thenIncluded.Include2523(
        (entity LocalEntity2523) -> entity.MetadataChild)

    let explicit = source.Include2523[
        LocalEntity2523, LocalChild2523?](
        (entity LocalEntity2523) -> entity.Child)
    let explicitBase IQuery2523[LocalEntity2523] = explicit

    let nested = source.Include2523(
        (entity LocalEntity2523) ->
            List[LocalChild2523?]())
    let nestedBase IQuery2523[LocalEntity2523] = nested

    let joined = source.IncludePair2523(
        (entity LocalEntity2523) -> LocalChild2523(),
        (entity LocalEntity2523) -> entity.Child)
    let joinedBase IQuery2523[LocalEntity2523] = joined

    let valueNullable = source.Include2523(
        (entity LocalEntity2523) -> default(int32?))
    let valueBase IQuery2523[LocalEntity2523] = valueNullable

    return resumed
}`)
    }

    @Fact
    func SourceAndMetadataEntityNavigationCombinationsKeepBaseConversions() {
        AssertBinds(`import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures

class LocalEntity2523Mix {
}

class LocalNavigation2523Mix {
}

func Run2523Mix(
    local IQuery2523[LocalEntity2523Mix],
    metadata IQuery2523[MetadataEntity2523]) {
    let sourceSource = local.Include2523(
        (entity LocalEntity2523Mix) ->
            default(LocalNavigation2523Mix?))
    let sourceSourceBase IQuery2523[LocalEntity2523Mix] = sourceSource

    let sourceMetadata = local.Include2523(
        (entity LocalEntity2523Mix) ->
            default(MetadataChild2523?))
    let sourceMetadataBase IQuery2523[LocalEntity2523Mix] = sourceMetadata

    let metadataSource = metadata.Include2523(
        (entity MetadataEntity2523) ->
            default(LocalNavigation2523Mix?))
    let metadataSourceBase IQuery2523[MetadataEntity2523] = metadataSource

    let metadataMetadata = metadata.Include2523(
        (entity MetadataEntity2523) -> entity.Child)
    let metadataMetadataBase IQuery2523[MetadataEntity2523] = metadataMetadata
}`)
    }

    @Fact
    func EntityFrameworkIncludeThenIncludeAndIncludeChainBinds() {
        AssertBinds(`import System.Collections.Generic
import System.Linq
import Microsoft.EntityFrameworkCore

class EfChild2523 {
    prop Detail EfDetail2523? { get; init; }
}

class EfDetail2523 {
}

class EfOther2523 {
}

class EfEntity2523 {
    prop Child EfChild2523? { get; init; }
    prop Children List[EfChild2523] { get; init; }
    prop Other EfOther2523? { get; init; }
}

func BuildEf2523(source IQueryable[EfEntity2523]) IQueryable[EfEntity2523] ->
    source
        .Include((entity EfEntity2523) -> entity.Child)
        .Include((entity EfEntity2523) -> entity.Children)
        .ThenInclude((child EfChild2523) -> child.Detail)
        .Include((entity EfEntity2523) -> entity.Other)`, typeof(EntityFrameworkQueryableExtensions).Assembly.Location)
    }

    @Fact
    func SymbolicHierarchySubstitutionHandlesNestedAndUnrelatedVarianceSlots() {
        let chainOpen = typeof(Issue2523Fixtures.IChain2523[_, _, _, _])
        let queryOpen = typeof(Issue2523Fixtures.IQuery2523[_])
        let nestedOpen = typeof(Issue2523Fixtures.INested2523[_])
        let projectionOpen = typeof(Issue2523Fixtures.IProjection2523[_])
        let entity = ImportedTypeSymbol.Get(typeof(MetadataEntity2523))
        let child = ImportedTypeSymbol.Get(typeof(MetadataChild2523))
        let nullableChild = NullableTypeSymbol.Get(child)
        let nestedProjection = ImportedTypeSymbol.GetConstructed(
            projectionOpen.MakeGenericType(typeof(object)),
            projectionOpen,
            ImmutableArray.Create[TypeSymbol](nullableChild)
        )
        let source = ImportedTypeSymbol.GetConstructed(
            chainOpen.MakeGenericType(typeof(object), typeof(object), typeof(object), typeof(object)),
            chainOpen,
            ImmutableArray.Create[TypeSymbol](
                entity,
                nullableChild,
                NullableTypeSymbol.Get(TypeSymbol.String),
                ImportedTypeSymbol.GetConstructed(
                    typeof(List[object]),
                    typeof(List[_]),
                    ImmutableArray.Create[TypeSymbol](nullableChild)
                )
            )
        )
        let queryTarget = ImportedTypeSymbol.GetConstructed(
            queryOpen.MakeGenericType(typeof(MetadataEntity2523)),
            queryOpen,
            ImmutableArray.Create[TypeSymbol](entity)
        )
        let nestedTarget = ImportedTypeSymbol.GetConstructed(
            nestedOpen.MakeGenericType(projectionOpen.MakeGenericType(typeof(object))),
            nestedOpen,
            ImmutableArray.Create[TypeSymbol](nestedProjection)
        )
        Assert.True(Conversion.Classify(source, queryTarget).IsImplicit)
        Assert.True(Conversion.Classify(source, nestedTarget).IsImplicit)
        let wrongQueryTarget = ImportedTypeSymbol.GetConstructed(
            queryOpen.MakeGenericType(typeof(MetadataChild2523)),
            queryOpen,
            ImmutableArray.Create[TypeSymbol](child)
        )
        Assert.False(Conversion.Classify(source, wrongQueryTarget).Exists)
    }

    @Fact
    func SeparateMetadataLoadContextsStillRecognizeProjectedBaseInterface() {
        let reference = typeof(Issue2523Fixtures.IChain2523[_, _, _, _]).Assembly.Location
        using let resolverA = ReferenceResolver.WithReferences([]string{reference})
        using let resolverB = ReferenceResolver.WithReferences([]string{reference})
        Assert.True(
            resolverA.TryResolveType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures.IChain2523`4",
                out var chainOpen
            )
        )
        Assert.True(
            resolverB.TryResolveType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures.IQuery2523`1",
                out var queryOpen
            )
        )
        Assert.True(
            resolverA.TryResolveType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures.MetadataEntity2523",
                out var entityA
            )
        )
        Assert.True(
            resolverB.TryResolveType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures.MetadataEntity2523",
                out var entityB
            )
        )
        Assert.True(
            resolverA.TryResolveType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures.MetadataChild2523",
                out var childA
            )
        )
        let entitySymbolA = ImportedTypeSymbol.Get(entityA)
        let entitySymbolB = ImportedTypeSymbol.Get(entityB)
        let contextObject = chainOpen.GetGenericArguments()[0].BaseType!!
        let source = ImportedTypeSymbol.GetConstructed(
            chainOpen.MakeGenericType(contextObject, contextObject, contextObject, contextObject),
            chainOpen,
            ImmutableArray.Create[TypeSymbol](
                entitySymbolA,
                NullableTypeSymbol.Get(ImportedTypeSymbol.Get(childA)),
                TypeSymbol.String,
                TypeSymbol.String
            )
        )
        let target = ImportedTypeSymbol.GetConstructed(
            queryOpen.MakeGenericType(entityB),
            queryOpen,
            ImmutableArray.Create[TypeSymbol](entitySymbolB)
        )
        Assert.False(object.ReferenceEquals(chainOpen.Assembly, queryOpen.Assembly))
        Assert.True(Conversion.Classify(source, target).IsImplicit)
    }

    shared {
        private func AssertBinds(source string, additionalReferences ...string) {
            let paths = TrustedPlatformAssemblies().ToList()
            paths.Add(typeof(Issue2523Fixtures.IChain2523[_, _, _, _]).Assembly.Location)
            paths.AddRange(additionalReferences)
            using let resolver = ReferenceResolver.WithReferences(paths)
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let global = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), resolver)
            let program = Binder.BindProgram(global, resolver)
            let diagnostics = global.Diagnostics.AddRange(program.Diagnostics)
            Assert.True(
                diagnostics.All((diagnostic Diagnostic) -> !diagnostic.IsError),
                string.Join(Environment.NewLine, diagnostics)
            )
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrWhiteSpace(value) {
                cast[IEnumerable[string]](Array.Empty[string]())
            } else {
                value!!.Split(Path.PathSeparator).Where(File.Exists)
            }
        }
    }
}
