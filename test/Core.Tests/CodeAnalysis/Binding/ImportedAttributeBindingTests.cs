// <copyright file="ImportedAttributeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.Tests.Fixtures;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests for issue #288: applying an attribute defined in a
/// referenced/imported assembly must not crash binding. Attribute types loaded
/// through a <see cref="System.Reflection.MetadataLoadContext"/> cannot be read
/// with runtime reflection (<c>Attribute.GetCustomAttribute</c> throws
/// <see cref="System.InvalidOperationException"/>), so
/// <see cref="KnownAttributes.GetAttributeUsage"/> must read
/// <c>[AttributeUsage]</c> via <see cref="System.Reflection.CustomAttributeData"/>.
/// </summary>
public class ImportedAttributeBindingTests
{
    private static ReferenceResolver FixtureResolver()
    {
        // Supplying a real reference path forces the compiler to load attribute
        // types through a MetadataLoadContext, reproducing the issue #288 crash.
        var fixturePath = typeof(ImportedMarkerAttribute).Assembly.Location;
        return ReferenceResolver.WithReferences(new[] { fixturePath });
    }

    private static BoundGlobalScope BindWithFixtures(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), FixtureResolver());
    }

    private static BoundGlobalScope BindWithIssue4503Contracts(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        using var resolver = ReferenceResolver.WithReferences(
            new[] { Issue4503ImportedAttributeContracts.Path });
        return Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            resolver);
    }

    [Fact]
    public void Imported_Attribute_With_Usage_Binds_Without_Crash()
    {
        var source = """
            package Demo
            import GSharp.Core.Tests.Fixtures

            @ImportedMarker
            class Hello {
            }
            """;

        var globalScope = BindWithFixtures(source);

        var hello = globalScope.Structs.Single(s => s.Name == "Hello");
        var attr = Assert.Single(hello.Attributes);
        Assert.Equal("GSharp.Core.Tests.Fixtures.ImportedMarkerAttribute", attr.AttributeType.Name);
        Assert.Equal(AttributeTargetKind.Type, attr.Target);

        // The attribute's [AttributeUsage] permits Class targets, so there must
        // be no invalid-use-site (GS0201) diagnostic.
        Assert.DoesNotContain(globalScope.Diagnostics, d => d.Id == "GS0201");
    }

    [Fact]
    public void Imported_Attribute_On_Method_Binds_Without_Crash()
    {
        var source = """
            package Demo
            import GSharp.Core.Tests.Fixtures

            class Hello {
                @ImportedMarker
                func Index() string {
                    return "hi"
                }
            }
            """;

        var globalScope = BindWithFixtures(source);

        Assert.DoesNotContain(globalScope.Diagnostics, d => d.Id == "GS0201");
    }

    [Fact]
    public void Imported_Attribute_Without_Usage_Defaults_To_All()
    {
        // ImportedDefaultAttribute carries no [AttributeUsage]; the CLR default
        // (AttributeTargets.All) must apply, so applying it to a type is valid.
        var source = """
            package Demo
            import GSharp.Core.Tests.Fixtures

            @ImportedDefault
            class Hello {
            }
            """;

        var globalScope = BindWithFixtures(source);

        var hello = globalScope.Structs.Single(s => s.Name == "Hello");
        Assert.Single(hello.Attributes);
        Assert.DoesNotContain(globalScope.Diagnostics, d => d.Id == "GS0201");
    }

    [Fact]
    public void NamedConstructorArguments_UseTheCompleteAllocatedParameterScope()
    {
        var globalScope = BindWithIssue4503Contracts(
            """
            package Demo
            import Issue4503.Contracts

            @ImportedReservedNamed(params__: "a", params_: "b")
            class Hello {
            }
            """);

        var attribute = Assert.Single(globalScope.Structs.Single(s => s.Name == "Hello").Attributes);
        Assert.Equal("a", attribute.GetConstructorArgument(0, "params")?.Value);
        Assert.Equal("b", attribute.GetConstructorArgument(1, "params_")?.Value);
    }

    [Fact]
    public void NamedConstructorMetadataName_ComesFromTheSelectedOverload()
    {
        var globalScope = BindWithIssue4503Contracts(
            """
            package Demo
            import Issue4503.Contracts

            @ImportedOverloadedReserved(params_: 1)
            class Hello {
            }
            """);

        var attribute = Assert.Single(globalScope.Structs.Single(s => s.Name == "Hello").Attributes);
        var argument = Assert.Single(attribute.PositionalArguments);
        Assert.Equal("params", attribute.GetConstructorParameterMetadataName(argument));
    }

    [Fact]
    public void EscapedRawClrConstructorParameterName_IsRecognized()
    {
        var globalScope = BindWithIssue4503Contracts(
            """
            package Demo
            import Issue4503.Contracts

            @ImportedReservedNamed($params: "a", params_: "b")
            class Hello {
            }
            """);

        var attribute = Assert.Single(globalScope.Structs.Single(s => s.Name == "Hello").Attributes);
        Assert.Equal("a", attribute.GetConstructorArgument(0, "params")?.Value);
        Assert.Equal("b", attribute.GetConstructorArgument(1, "params_")?.Value);
    }
}
