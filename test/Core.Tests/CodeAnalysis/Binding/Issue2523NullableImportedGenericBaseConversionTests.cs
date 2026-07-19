// <copyright file="Issue2523NullableImportedGenericBaseConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Linq.Expressions;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding
{
    /// <summary>
    /// Issue #2523: symbolic nullable arguments on an imported generic return
    /// must not erase the return's declared generic base interfaces.
    /// </summary>
    public sealed class Issue2523NullableImportedGenericBaseConversionTests
    {
        [Fact]
        public void InferredExplicitReducedAndChainedCallsKeepImportedBaseConversions()
        {
            AssertBinds(
                """
                import System.Collections.Generic
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
                }
                """);
        }

        [Fact]
        public void SourceAndMetadataEntityNavigationCombinationsKeepBaseConversions()
        {
            AssertBinds(
                """
                import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures

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
                }
                """);
        }

        [Fact]
        public void EntityFrameworkIncludeThenIncludeAndIncludeChainBinds()
        {
            AssertBinds(
                """
                import System.Collections.Generic
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
                        .Include((entity EfEntity2523) -> entity.Other)
                """,
                typeof(Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions).Assembly.Location);
        }

        [Fact]
        public void SymbolicHierarchySubstitutionHandlesNestedAndUnrelatedVarianceSlots()
        {
            var chainOpen = typeof(Issue2523Fixtures.IChain2523<,,,>);
            var queryOpen = typeof(Issue2523Fixtures.IQuery2523<>);
            var nestedOpen = typeof(Issue2523Fixtures.INested2523<>);
            var projectionOpen = typeof(Issue2523Fixtures.IProjection2523<>);

            var entity = ImportedTypeSymbol.Get(typeof(Issue2523Fixtures.MetadataEntity2523));
            var child = ImportedTypeSymbol.Get(typeof(Issue2523Fixtures.MetadataChild2523));
            var nullableChild = NullableTypeSymbol.Get(child);
            var nestedProjection = ImportedTypeSymbol.GetConstructed(
                projectionOpen.MakeGenericType(typeof(object)),
                projectionOpen,
                ImmutableArray.Create<TypeSymbol>(nullableChild));
            var source = ImportedTypeSymbol.GetConstructed(
                chainOpen.MakeGenericType(typeof(object), typeof(object), typeof(object), typeof(object)),
                chainOpen,
                ImmutableArray.Create<TypeSymbol>(
                    entity,
                    nullableChild,
                    NullableTypeSymbol.Get(TypeSymbol.String),
                    ImportedTypeSymbol.GetConstructed(
                        typeof(List<object>),
                        typeof(List<>),
                        ImmutableArray.Create<TypeSymbol>(nullableChild))));

            var queryTarget = ImportedTypeSymbol.GetConstructed(
                queryOpen.MakeGenericType(typeof(Issue2523Fixtures.MetadataEntity2523)),
                queryOpen,
                ImmutableArray.Create<TypeSymbol>(entity));
            var nestedTarget = ImportedTypeSymbol.GetConstructed(
                nestedOpen.MakeGenericType(projectionOpen.MakeGenericType(typeof(object))),
                nestedOpen,
                ImmutableArray.Create<TypeSymbol>(nestedProjection));

            Assert.True(Conversion.Classify(source, queryTarget).IsImplicit);
            Assert.True(Conversion.Classify(source, nestedTarget).IsImplicit);

            var wrongQueryTarget = ImportedTypeSymbol.GetConstructed(
                queryOpen.MakeGenericType(typeof(Issue2523Fixtures.MetadataChild2523)),
                queryOpen,
                ImmutableArray.Create<TypeSymbol>(child));
            Assert.False(Conversion.Classify(source, wrongQueryTarget).Exists);
        }

        [Fact]
        public void SeparateMetadataLoadContextsStillRecognizeProjectedBaseInterface()
        {
            var reference = typeof(Issue2523Fixtures.IChain2523<,,,>).Assembly.Location;
            using var resolverA = ReferenceResolver.WithReferences(new[] { reference });
            using var resolverB = ReferenceResolver.WithReferences(new[] { reference });

            Assert.True(
                resolverA.TryResolveType(
                    "GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures.IChain2523`4",
                    out var chainOpen));
            Assert.True(
                resolverB.TryResolveType(
                    "GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures.IQuery2523`1",
                    out var queryOpen));
            Assert.True(
                resolverA.TryResolveType(
                    "GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures.MetadataEntity2523",
                    out var entityA));
            Assert.True(
                resolverB.TryResolveType(
                    "GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures.MetadataEntity2523",
                    out var entityB));
            Assert.True(
                resolverA.TryResolveType(
                    "GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures.MetadataChild2523",
                    out var childA));

            var entitySymbolA = ImportedTypeSymbol.Get(entityA);
            var entitySymbolB = ImportedTypeSymbol.Get(entityB);
            var contextObject = chainOpen.GetGenericArguments()[0].BaseType!;
            var source = ImportedTypeSymbol.GetConstructed(
                chainOpen.MakeGenericType(
                    contextObject,
                    contextObject,
                    contextObject,
                    contextObject),
                chainOpen,
                ImmutableArray.Create<TypeSymbol>(
                    entitySymbolA,
                    NullableTypeSymbol.Get(ImportedTypeSymbol.Get(childA)),
                    TypeSymbol.String,
                    TypeSymbol.String));
            var target = ImportedTypeSymbol.GetConstructed(
                queryOpen.MakeGenericType(entityB),
                queryOpen,
                ImmutableArray.Create<TypeSymbol>(entitySymbolB));

            Assert.False(ReferenceEquals(chainOpen.Assembly, queryOpen.Assembly));
            Assert.True(Conversion.Classify(source, target).IsImplicit);
        }

        private static void AssertBinds(string source, params string[] additionalReferences)
        {
            var paths = TrustedPlatformAssemblies().ToList();
            paths.Add(typeof(Issue2523Fixtures.IChain2523<,,,>).Assembly.Location);
            paths.AddRange(additionalReferences);

            using var resolver = ReferenceResolver.WithReferences(paths);
            var tree = SyntaxTree.Parse(SourceText.From(source));
            var global = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), resolver);
            var program = Binder.BindProgram(global, resolver);
            var diagnostics = global.Diagnostics.AddRange(program.Diagnostics);
            Assert.True(
                diagnostics.All(diagnostic => !diagnostic.IsError),
                string.Join(Environment.NewLine, diagnostics));
        }

        private static IEnumerable<string> TrustedPlatformAssemblies()
        {
            var value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
            return string.IsNullOrWhiteSpace(value)
                ? Array.Empty<string>()
                : value.Split(Path.PathSeparator).Where(File.Exists);
        }
    }
}

namespace GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures
{
    public interface IQuery2523<out TEntity>
    {
    }

    public interface IProjection2523<out TValue>
    {
    }

    public interface INested2523<out TValue>
    {
    }

    public interface IChain2523<out TEntity, out TProperty, in TInput, TInvariant>
        : IQuery2523<TEntity>,
          IProjection2523<TProperty>,
          INested2523<IProjection2523<TProperty>>
    {
    }

    public sealed class MetadataEntity2523
    {
        public MetadataChild2523? Child { get; set; }
    }

    public sealed class MetadataChild2523
    {
    }

    public static class QueryExtensions2523
    {
        public static IChain2523<TEntity, TProperty, string, string> Include2523<TEntity, TProperty>(
            this IQuery2523<TEntity> source,
            Expression<Func<TEntity, TProperty>> selector)
            => null!;

        public static IChain2523<TEntity, TProperty, string, string> IncludePair2523<TEntity, TProperty>(
            this IQuery2523<TEntity> source,
            Expression<Func<TEntity, TProperty>> first,
            Expression<Func<TEntity, TProperty>> second)
            => null!;

        public static IChain2523<TEntity, TNext, string, string> ThenInclude2523<TEntity, TPrevious, TNext>(
            this IQuery2523<TEntity> source,
            Expression<Func<TPrevious, TNext>> selector)
            => null!;
    }
}
