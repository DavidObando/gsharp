// <copyright file="Issue2839MetadataNullableNavigationThenIncludeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding
{
    /// <summary>
    /// Issue #2839: a nullable collection navigation property must bind the
    /// collection <c>ThenInclude</c> overload regardless of whether its nullable
    /// annotation came from source or from metadata. Issue #2523 only covered
    /// the same-compilation form, so the cross-assembly shape regressed.
    /// </summary>
    public sealed class Issue2839MetadataNullableNavigationThenIncludeTests
    {
        [Fact]
        public void MetadataNullableCollectionNavigationBindsThenInclude()
        {
            AssertBinds(
                """
                import System.Linq
                import Microsoft.EntityFrameworkCore
                import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2839Fixtures

                func Build2839(source IQueryable[Entity2839]) IQueryable[Entity2839] ->
                    source
                        .Include((entity Entity2839) -> entity.NullableChildren)
                        .ThenInclude((child Child2839) -> child.Leaf)
                """);
        }

        [Fact]
        public void MetadataNonNullableCollectionNavigationBindsThenInclude()
        {
            AssertBinds(
                """
                import System.Linq
                import Microsoft.EntityFrameworkCore
                import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2839Fixtures

                func Build2839NonNull(source IQueryable[Entity2839]) IQueryable[Entity2839] ->
                    source
                        .Include((entity Entity2839) -> entity.Children)
                        .ThenInclude((child Child2839) -> child.Leaf)
                """);
        }

        [Fact]
        public void SameCompilationNullableCollectionNavigationBindsThenInclude()
        {
            AssertBinds(
                """
                import System.Collections.Generic
                import System.Linq
                import Microsoft.EntityFrameworkCore

                class LocalLeaf2839 {
                }

                class LocalChild2839 {
                    prop Leaf LocalLeaf2839? { get; init; }
                }

                class LocalEntity2839 {
                    prop NullableChildren ICollection[LocalChild2839]? { get; init; }
                }

                func BuildLocal2839(source IQueryable[LocalEntity2839]) IQueryable[LocalEntity2839] ->
                    source
                        .Include((entity LocalEntity2839) -> entity.NullableChildren)
                        .ThenInclude((child LocalChild2839) -> child.Leaf)
                """);
        }

        [Fact]
        public void ExplicitlyAnnotatedReceiverBindsThenInclude()
        {
            AssertBinds(
                """
                import System.Collections.Generic
                import System.Linq
                import Microsoft.EntityFrameworkCore
                import Microsoft.EntityFrameworkCore.Query
                import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2839Fixtures

                func BuildAnnotated2839(source IQueryable[Entity2839]) IQueryable[Entity2839] {
                    let included IIncludableQueryable[Entity2839, ICollection[Child2839]?] =
                        source.Include((entity Entity2839) -> entity.NullableChildren)
                    return included.ThenInclude((child Child2839) -> child.Leaf)
                }
                """);
        }

        [Fact]
        public void MetadataNullableInterfaceCollectionNavigationRecoversElementForFurtherChaining()
        {
            AssertBinds(
                """
                import System.Linq
                import Microsoft.EntityFrameworkCore
                import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2839Fixtures

                func BuildChained2839(source IQueryable[Entity2839]) IQueryable[Entity2839] ->
                    source
                        .Include((entity Entity2839) -> entity.NullableChildren)
                        .ThenInclude((child Child2839) -> child.Leaf)
                        .ThenInclude((leaf Leaf2839) -> leaf.Name)
                        .Include((entity Entity2839) -> entity.NullableList)
                        .ThenInclude((child Child2839) -> child.Leaf)
                """);
        }

        [Fact]
        public void OahuBookLibraryShapeBindsIncludeIncludeThenInclude()
        {
            // Oahu/src/Oahu.Core/BookLibrary.cs:126 verbatim shape: a scalar
            // Include, then a collection Include over a metadata-annotated
            // nullable navigation, then ThenInclude off that collection.
            AssertBinds(
                """
                import System.Linq
                import Microsoft.EntityFrameworkCore
                import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2839Fixtures

                func BuildBookLibrary2839(source IQueryable[Entity2839]) IQueryable[Entity2839] ->
                    source
                        .Include((entity Entity2839) -> entity.Conversion)
                        .Include((entity Entity2839) -> entity.NullableChildren)
                        .ThenInclude((child Child2839) -> child.Leaf)
                """);
        }

        private static void AssertBinds(string source)
        {
            var paths = TrustedPlatformAssemblies().ToList();
            paths.Add(typeof(Issue2839Fixtures.Entity2839).Assembly.Location);
            paths.Add(typeof(Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions).Assembly.Location);

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

namespace GSharp.Core.Tests.CodeAnalysis.Binding.Issue2839Fixtures
{
    public sealed class Leaf2839
    {
        public string? Name { get; set; }
    }

    public sealed class Child2839
    {
        public Leaf2839? Leaf { get; set; }
    }

    public sealed class Entity2839
    {
        public Leaf2839? Conversion { get; set; }

        public ICollection<Child2839>? NullableChildren { get; } = new List<Child2839>();

        public ICollection<Child2839> Children { get; } = new List<Child2839>();

        public List<Child2839>? NullableList { get; } = new List<Child2839>();
    }
}
