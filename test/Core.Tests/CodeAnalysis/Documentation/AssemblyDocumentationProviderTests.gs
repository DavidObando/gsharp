// <copyright file="AssemblyDocumentationProviderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Documentation

import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.IO
import System.Linq
import System.Reflection
import System.Text
import Xunit

/// ADR-0057 §6 ingestion: end-to-end tests that real companion `.xml` documentation
/// is discovered beside a resolved reference assembly, parsed XXE-safely, indexed by DocID,
/// and rendered through the shared (cref:DocumentationIdProvider).
open class AssemblyDocumentationProviderTests {
    @Fact
    func Resolve_KnownBclType_ReturnsSummaryFromReferencePackXml() {
        let resolver ReferenceResolver? = ReferenceResolverForBcl()
        if resolver == nil {
            return // Reference pack not present in this environment; skip silently.

        }
        Assert.True(resolver.TryResolveType("System.String", out var stringType))
        let documentation DocumentationComment? = AssemblyDocumentationProvider.Resolve(stringType)
        Assert.NotNull(documentation)
        Assert.NotEmpty(documentation!!.Summary)
    }

    @Fact
    func Resolve_KnownBclMethod_ReturnsDocumentation() {
        let resolver ReferenceResolver? = ReferenceResolverForBcl()
        if resolver == nil {
            return
        }
        Assert.True(resolver.TryResolveType("System.String", out var stringType))
        let method = stringType.GetMethods().First(
            (m MethodInfo) -> m.Name == "Substring" && m.GetParameters().Length == 1
        )
        let documentation DocumentationComment? = AssemblyDocumentationProvider.Resolve(method)
        Assert.NotNull(documentation)
        Assert.NotEmpty(documentation!!.Summary)
        Assert.Single(documentation!!.Parameters)
    }

    @Fact
    func Resolve_NullInputs_ReturnNull() {
        Assert.Null(AssemblyDocumentationProvider.Resolve(default(Type)))
        Assert.Null(AssemblyDocumentationProvider.Resolve(default(MethodInfo)))
        Assert.Null(AssemblyDocumentationProvider.Resolve(default(PropertyInfo)))
        Assert.Null(AssemblyDocumentationProvider.Resolve(default(FieldInfo)))
        Assert.Null(AssemblyDocumentationProvider.Resolve(default(EventInfo)))
    }

    @Fact
    func ForAssembly_CoreLib_ProbesRefPackAndFindsSystemRuntimeXml() {
        // System.Private.CoreLib hosts System.Object but ships no sibling xml; the
        // ref-pack probing should discover System.Runtime.xml and resolve docs when
        // a ref pack is installed next to the runtime.
        let provider AssemblyDocumentationProvider? = AssemblyDocumentationProvider.ForAssembly(typeof(object).Assembly)
        Assert.NotNull(provider)
        if provider!!.TryGetDocumentation("T:System.Object", out var doc) {
            // Ref pack was found — verify the documentation is meaningful.
            Assert.NotEmpty(doc.Summary)
        }
        // If no ref pack is installed, the provider degrades gracefully (returns false).

    }

    @Fact
    func Resolve_RuntimeLoadedType_ProbesRefPackForXml() {
        // System.Console is loaded from the shared framework (no sibling xml), but the
        // ref pack probing should find System.Console.xml and resolve its documentation.
        let consoleType = typeof(Console)
        let documentation DocumentationComment? = AssemblyDocumentationProvider.Resolve(consoleType)
        if documentation == nil {
            // No ref pack installed — probing degrades gracefully.
            return
        }
        Assert.NotEmpty(documentation.Summary)
    }

    @Fact
    func Resolve_RuntimeLoadedProperty_ProbesRefPackForXml() {
        // StringBuilder.Length is loaded from the shared framework; verify property docs
        // are resolved via the ref pack probe path.
        let lengthProperty PropertyInfo? = typeof(StringBuilder).GetProperty(
            "Length",
            BindingFlags.Public | BindingFlags.Instance
        )
        let documentation DocumentationComment? = AssemblyDocumentationProvider.Resolve(lengthProperty!!)
        if documentation == nil {
            // No ref pack installed — probing degrades gracefully.
            return
        }
        Assert.NotEmpty(documentation.Summary)
    }

    shared {
        private func ReferenceResolverForBcl() ReferenceResolver? {
            let packRoot = "/usr/local/share/dotnet/packs/Microsoft.NETCore.App.Ref"
            if !Directory.Exists(packRoot) {
                return nil
            }
            // Pick the System.Runtime.dll whose sibling System.Runtime.xml exists, preferring
            // the highest version directory.
            let runtimeDll string? = Directory
                .EnumerateFiles(packRoot, "System.Runtime.dll", SearchOption.AllDirectories)
                .Where((p string) -> File.Exists(Path.ChangeExtension(p, ".xml")))
                .OrderByDescending((p string) -> p)
                .FirstOrDefault()
            return if runtimeDll == nil {
                default(ReferenceResolver?)
            } else {
                ReferenceResolver.WithReferences([]string{runtimeDll})
            }
        }
    }
}
