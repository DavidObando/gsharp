// <copyright file="AssemblyDocumentationProviderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Documentation;

/// <summary>
/// ADR-0057 §6 ingestion: end-to-end tests that real companion <c>.xml</c> documentation
/// is discovered beside a resolved reference assembly, parsed XXE-safely, indexed by DocID,
/// and rendered through the shared <see cref="DocumentationIdProvider"/>.
/// </summary>
public class AssemblyDocumentationProviderTests
{
    [Fact]
    public void Resolve_KnownBclType_ReturnsSummaryFromReferencePackXml()
    {
        var resolver = ReferenceResolverForBcl();
        if (resolver == null)
        {
            return; // Reference pack not present in this environment; skip silently.
        }

        Assert.True(resolver.TryResolveType("System.String", out var stringType));

        var documentation = AssemblyDocumentationProvider.Resolve(stringType);
        Assert.NotNull(documentation);
        Assert.NotEmpty(documentation.Summary);
    }

    [Fact]
    public void Resolve_KnownBclMethod_ReturnsDocumentation()
    {
        var resolver = ReferenceResolverForBcl();
        if (resolver == null)
        {
            return;
        }

        Assert.True(resolver.TryResolveType("System.String", out var stringType));
        var method = stringType.GetMethods()
            .First(m => m.Name == "Substring" && m.GetParameters().Length == 1);

        var documentation = AssemblyDocumentationProvider.Resolve(method);
        Assert.NotNull(documentation);
        Assert.NotEmpty(documentation.Summary);
        Assert.Single(documentation.Parameters);
    }

    [Fact]
    public void Resolve_NullInputs_ReturnNull()
    {
        Assert.Null(AssemblyDocumentationProvider.Resolve((Type)null));
        Assert.Null(AssemblyDocumentationProvider.Resolve((System.Reflection.MethodInfo)null));
        Assert.Null(AssemblyDocumentationProvider.Resolve((System.Reflection.PropertyInfo)null));
        Assert.Null(AssemblyDocumentationProvider.Resolve((System.Reflection.FieldInfo)null));
        Assert.Null(AssemblyDocumentationProvider.Resolve((System.Reflection.EventInfo)null));
    }

    [Fact]
    public void ForAssembly_CoreLib_ProbesRefPackAndFindsSystemRuntimeXml()
    {
        // System.Private.CoreLib hosts System.Object but ships no sibling xml; the
        // ref-pack probing should discover System.Runtime.xml and resolve docs.
        var provider = AssemblyDocumentationProvider.ForAssembly(typeof(object).Assembly);
        Assert.NotNull(provider);

        if (!Directory.Exists("/usr/local/share/dotnet/packs/Microsoft.NETCore.App.Ref"))
        {
            // No ref pack installed — probing won't find anything, that's expected.
            Assert.False(provider.TryGetDocumentation("T:System.Object", out _));
            return;
        }

        Assert.True(provider.TryGetDocumentation("T:System.Object", out var doc));
        Assert.NotEmpty(doc.Summary);
    }

    [Fact]
    public void Resolve_RuntimeLoadedType_ProbesRefPackForXml()
    {
        // System.Console is loaded from the shared framework (no sibling xml), but the
        // ref pack probing should find System.Console.xml and resolve its documentation.
        var consoleType = typeof(Console);
        var documentation = AssemblyDocumentationProvider.Resolve(consoleType);

        if (!Directory.Exists("/usr/local/share/dotnet/packs/Microsoft.NETCore.App.Ref"))
        {
            // No ref pack installed — skip gracefully.
            return;
        }

        Assert.NotNull(documentation);
        Assert.NotEmpty(documentation.Summary);
    }

    [Fact]
    public void Resolve_RuntimeLoadedProperty_ProbesRefPackForXml()
    {
        // StringBuilder.Length is loaded from the shared framework; verify property docs
        // are resolved via the ref pack probe path.
        var lengthProperty = typeof(System.Text.StringBuilder)
            .GetProperty("Length", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance);

        if (!Directory.Exists("/usr/local/share/dotnet/packs/Microsoft.NETCore.App.Ref"))
        {
            return;
        }

        var documentation = AssemblyDocumentationProvider.Resolve(lengthProperty);
        Assert.NotNull(documentation);
        Assert.NotEmpty(documentation.Summary);
    }

    private static ReferenceResolver ReferenceResolverForBcl()
    {
        var packRoot = "/usr/local/share/dotnet/packs/Microsoft.NETCore.App.Ref";
        if (!Directory.Exists(packRoot))
        {
            return null;
        }

        // Pick the System.Runtime.dll whose sibling System.Runtime.xml exists, preferring
        // the highest version directory.
        var runtimeDll = Directory.EnumerateFiles(packRoot, "System.Runtime.dll", SearchOption.AllDirectories)
            .Where(p => File.Exists(Path.ChangeExtension(p, ".xml")))
            .OrderByDescending(p => p)
            .FirstOrDefault();

        return runtimeDll == null ? null : ReferenceResolver.WithReferences(new[] { runtimeDll });
    }
}
