// <copyright file="Issue4369NestedTypeArrayAttributeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.Tests.Fixtures;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>Issue #4369: nested attribute arrays retain their source static type.</summary>
public sealed class Issue4369NestedTypeArrayAttributeTests
{
    [Fact]
    public void BinderRetainsNestedTypeArrayStaticTypeButLeavesObjectArrayUnwrapped()
    {
        var scope = GSharp.Core.CodeAnalysis.Binding.Binder.BindGlobalScope(
            previous: null,
            System.Collections.Immutable.ImmutableArray.Create(GsSyntaxTree.Parse(
                """
                package App
                import System

                class ValuesAttribute(Values []object) : Attribute {}

                @Values([]object{[]Type{typeof(Local)}, []object{"control"}})
                class Local {}
                """)));

        Assert.Empty(scope.Diagnostics);
        var attribute = Assert.Single(scope.Structs.Single(type => type.Name == "Local").Attributes);
        var outer = Assert.IsType<object[]>(Assert.Single(attribute.PositionalArguments).Value);
        var nestedTypeArray = Assert.IsType<BoundAttributeArgument>(outer[0]);
        var staticElementType = nestedTypeArray.Type switch
        {
            ArrayTypeSymbol array => array.ElementType,
            SliceTypeSymbol slice => slice.ElementType,
            _ => null,
        };
        Assert.NotNull(staticElementType);
        Assert.Equal(typeof(Type), staticElementType.ClrType);
        Assert.IsType<object[]>(nestedTypeArray.Value);
        Assert.IsType<object[]>(outer[1]);
    }

    [Fact]
    public void EmittedMetadataRoundTripsLikeEquivalentRoslynAttribute()
    {
        using var contracts = new Issue4369NestedTypeArrayAttributeContracts();
        const string assemblyName = "Issue4369.Subject";
        const string gsSource = """
            package App
            import System
            import Issue4369.Contracts

            @Values([]object{[]Type{typeof(Local)}, []object{"control"}})
            class Local {}
            """;
        const string csSource = """
            using System;
            using Issue4369.Contracts;

            namespace App;

            [Values(new object[] { new Type[] { typeof(Local) }, new object[] { "control" } })]
            public class Local {}
            """;

        byte[] gsImage;
        using (var resolver = ReferenceResolver.WithReferences(new[] { contracts.Path }))
        using (var stream = new MemoryStream())
        {
            var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(gsSource))) { IsLibrary = true };
            var result = compilation.Emit(stream, pdbStream: null, refStream: null, assemblyName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
            gsImage = stream.ToArray();
        }

        var csCompilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(csSource) },
            ReferenceResolver.HostTrustedPlatformAssemblyPaths()
                .Append(contracts.Path)
                .Select(path => MetadataReference.CreateFromFile(path)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var csStream = new MemoryStream();
        var csResult = csCompilation.Emit(csStream);
        Assert.True(csResult.Success, string.Join(Environment.NewLine, csResult.Diagnostics));

        Assert.Equal(
            DescribeAttribute(contracts.LoadWith(csStream.ToArray())),
            DescribeAttribute(contracts.LoadWith(gsImage)));
    }

    private static string DescribeAttribute((Assembly Contract, Assembly Subject) assemblies)
    {
        var attributeType = assemblies.Contract.GetType("Issue4369.Contracts.ValuesAttribute");
        var target = assemblies.Subject.GetType("App.Local");
        var argument = Assert.Single(
            Assert.Single(target.GetCustomAttributesData(), item => item.AttributeType == attributeType)
                .ConstructorArguments);
        return Describe(argument);
    }

    private static string Describe(CustomAttributeTypedArgument argument)
    {
        if (argument.Value is IReadOnlyCollection<CustomAttributeTypedArgument> elements)
        {
            return argument.ArgumentType.FullName
                + "["
                + string.Join(",", elements.Select(Describe))
                + "]";
        }

        return argument.ArgumentType.FullName + ":" + (argument.Value is Type type ? type.FullName : argument.Value);
    }
}
