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
    }

    [Fact]
    public void ForAssembly_WithoutSiblingXml_ReturnsProviderThatFindsNothing()
    {
        // The host runtime's shared-framework assemblies ship no sibling xml, so the
        // provider must degrade to "docs unavailable" rather than throw.
        var provider = AssemblyDocumentationProvider.ForAssembly(typeof(object).Assembly);
        Assert.NotNull(provider);
        Assert.False(provider.TryGetDocumentation("T:System.Object", out _));
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
