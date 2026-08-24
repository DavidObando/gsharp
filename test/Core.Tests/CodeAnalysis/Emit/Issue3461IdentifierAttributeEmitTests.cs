// <copyright file="Issue3461IdentifierAttributeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.Tests.Fixtures;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>Issue #3461: emitted attribute names map back to CLR metadata names.</summary>
public sealed class Issue3461IdentifierAttributeEmitTests
{
    [Fact]
    public void ImportedReservedNamedArguments_RoundTripThroughMetadata()
    {
        string fixtureAssembly = typeof(ImportedReservedNamedAttribute).Assembly.Location;
        using var resolver = ReferenceResolver.WithReferences(new[] { fixtureAssembly });
        var compilation = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                import GSharp.Core.Tests.Fixtures

                @ImportedReservedNamed("a", "b", type: "c", type_: "d")
                class Tagged {
                }
                """)));

        using var stream = new MemoryStream();
        var emit = compilation.Emit(stream);
        Assert.True(
            emit.Success,
            string.Join("; ", emit.Diagnostics.Select(diagnostic => diagnostic.Message)));
        stream.Position = 0;

        var loadContext = new AssemblyLoadContext(
            nameof(ImportedReservedNamedArguments_RoundTripThroughMetadata),
            isCollectible: true);
        try
        {
            loadContext.Resolving += (_, name) =>
                name.Name == typeof(ImportedReservedNamedAttribute).Assembly.GetName().Name
                    ? typeof(ImportedReservedNamedAttribute).Assembly
                    : null;
            Assembly assembly = loadContext.LoadFromStream(stream);
            Type tagged = assembly.GetTypes().Single(candidateType => candidateType.Name == "Tagged");
            CustomAttributeData attribute = tagged.GetCustomAttributesData()
                .Single(candidate =>
                    candidate.AttributeType == typeof(ImportedReservedNamedAttribute));

            Assert.Equal(
                new[] { "a", "b" },
                attribute.ConstructorArguments.Select(argument => argument.Value).ToArray());
            Assert.Equal(
                new[] { "type", "type_" },
                attribute.NamedArguments.Select(argument => argument.MemberName).ToArray());
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
