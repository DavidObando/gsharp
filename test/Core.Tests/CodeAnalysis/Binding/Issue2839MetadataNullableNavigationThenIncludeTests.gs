// <copyright file="Issue2839MetadataNullableNavigationThenIncludeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2839Fixtures
import Microsoft.EntityFrameworkCore
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #2839: a nullable collection navigation property must bind the
/// collection `ThenInclude` overload regardless of whether its nullable
/// annotation came from source or from metadata. Issue #2523 only covered
/// the same-compilation form, so the cross-assembly shape regressed.
class Issue2839MetadataNullableNavigationThenIncludeTests {
    @Fact
    func MetadataNullableCollectionNavigationBindsThenInclude() {
        AssertBinds(`import System.Linq
import Microsoft.EntityFrameworkCore
import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2839Fixtures

func Build2839(source IQueryable[Entity2839]) IQueryable[Entity2839] ->
    source
        .Include((entity Entity2839) -> entity.NullableChildren)
        .ThenInclude((child Child2839) -> child.Leaf)`)
    }

    @Fact
    func MetadataNonNullableCollectionNavigationBindsThenInclude() {
        AssertBinds(`import System.Linq
import Microsoft.EntityFrameworkCore
import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2839Fixtures

func Build2839NonNull(source IQueryable[Entity2839]) IQueryable[Entity2839] ->
    source
        .Include((entity Entity2839) -> entity.Children)
        .ThenInclude((child Child2839) -> child.Leaf)`)
    }

    @Fact
    func SameCompilationNullableCollectionNavigationBindsThenInclude() {
        AssertBinds(`import System.Collections.Generic
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
        .ThenInclude((child LocalChild2839) -> child.Leaf)`)
    }

    @Fact
    func ExplicitlyAnnotatedReceiverBindsThenInclude() {
        AssertBinds(`import System.Collections.Generic
import System.Linq
import Microsoft.EntityFrameworkCore
import Microsoft.EntityFrameworkCore.Query
import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2839Fixtures

func BuildAnnotated2839(source IQueryable[Entity2839]) IQueryable[Entity2839] {
    let included IIncludableQueryable[Entity2839, ICollection[Child2839]?] =
        source.Include((entity Entity2839) -> entity.NullableChildren)
    return included.ThenInclude((child Child2839) -> child.Leaf)
}`)
    }

    @Fact
    func MetadataNullableInterfaceCollectionNavigationRecoversElementForFurtherChaining() {
        AssertBinds(`import System.Linq
import Microsoft.EntityFrameworkCore
import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2839Fixtures

func BuildChained2839(source IQueryable[Entity2839]) IQueryable[Entity2839] ->
    source
        .Include((entity Entity2839) -> entity.NullableChildren)
        .ThenInclude((child Child2839) -> child.Leaf)
        .ThenInclude((leaf Leaf2839) -> leaf.Name)
        .Include((entity Entity2839) -> entity.NullableList)
        .ThenInclude((child Child2839) -> child.Leaf)`)
    }

    @Fact
    func OahuBookLibraryShapeBindsIncludeIncludeThenInclude() {
        // Oahu/src/Oahu.Core/BookLibrary.cs:126 verbatim shape: a scalar
        // Include, then a collection Include over a metadata-annotated
        // nullable navigation, then ThenInclude off that collection.
        AssertBinds(`import System.Linq
import Microsoft.EntityFrameworkCore
import GSharp.Core.Tests.CodeAnalysis.Binding.Issue2839Fixtures

func BuildBookLibrary2839(source IQueryable[Entity2839]) IQueryable[Entity2839] ->
    source
        .Include((entity Entity2839) -> entity.Conversion)
        .Include((entity Entity2839) -> entity.NullableChildren)
        .ThenInclude((child Child2839) -> child.Leaf)`)
    }

    shared {
        private func AssertBinds(source string) {
            let paths = TrustedPlatformAssemblies().ToList()
            paths.Add(typeof(Entity2839).Assembly.Location)
            paths.Add(typeof(EntityFrameworkQueryableExtensions).Assembly.Location)
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
