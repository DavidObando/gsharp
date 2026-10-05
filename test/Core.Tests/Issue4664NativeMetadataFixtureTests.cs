// <copyright file="Issue4664NativeMetadataFixtureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;
using Xunit.Abstractions;

namespace GSharp.Core.Tests;

/// <summary>Issue #4664: import oracles must keep native Roslyn metadata after harness migration.</summary>
public class Issue4664NativeMetadataFixtureTests
{
    private readonly ITestOutputHelper output;

    public Issue4664NativeMetadataFixtureTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Theory]
    [InlineData("CodeAnalysis.Symbols.ClrNullabilityTests+Sample")]
    [InlineData("CodeAnalysis.Symbols.ClrNullabilityTests+PairContainer`2")]
    [InlineData("CodeAnalysis.Symbols.ClrNullabilityTests+ValueContainer`1")]
    [InlineData("CodeAnalysis.Symbols.ClrNullabilityTests+GenericSurface`1")]
    [InlineData("CodeAnalysis.Binding.OverloadResolutionTests+Fixture")]
    [InlineData("CodeAnalysis.Binding.OverloadResolutionTests+EqualLike")]
    [InlineData("CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+IA")]
    [InlineData("CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+IB")]
    [InlineData("CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+BothAB")]
    [InlineData("CodeAnalysis.Binding.OverloadResolutionTests+ConstraintFixture")]
    [InlineData("CodeAnalysis.Binding.OverloadResolutionTests+MapLike")]
    [InlineData("CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayClass")]
    [InlineData("CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayStruct")]
    [InlineData("CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayNone")]
    [InlineData("CodeAnalysis.Binding.OverloadResolutionTests+AmbiguousSameShapeA")]
    [InlineData("CodeAnalysis.Binding.OverloadResolutionTests+AmbiguousSameShapeB")]
    [InlineData("CodeAnalysis.Binding.Issue1482NumericWideningLatticeTests+NIntFixture")]
    [InlineData("CodeAnalysis.Binding.Issue3834GenericMethodClosureDiagnosticsTests+ConstraintFixture")]
    [InlineData("CodeAnalysis.Binding.Issue3834GenericMethodClosureDiagnosticsTests+CrossContextBase")]
    [InlineData("CodeAnalysis.Binding.Issue3834GenericMethodClosureDiagnosticsTests+CrossContextDerived")]
    [InlineData("CodeAnalysis.Binding.AccessPathTests+GenericFixture`1")]
    [InlineData("CodeAnalysis.Binding.Issue3394InlineOutTupleBindingTests+OptionalNullFixture")]
    [InlineData("CodeAnalysis.Binding.Issue3394InlineOutTupleBindingTests+InferenceBase")]
    [InlineData("CodeAnalysis.Binding.Issue3394InlineOutTupleBindingTests+InferenceDerived")]
    [InlineData("CodeAnalysis.Binding.OverloadResolutionPropertyFixture")]
    [InlineData("CodeAnalysis.Documentation.DocIdSamples")]
    [InlineData("Fixtures.UnscopedRefIndexerFixture")]
    [InlineData("Fixtures.UnscopedRefIndexerPropertyLevelFixture")]
    public void ConsumersUseNativeTypesAndExplicitPhysicalReferences(string relativeName)
    {
        string fullName = "GSharp.Core.Tests." + relativeName;
        var native = NativeMetadataFixtures.GetType(fullName);
        Assert.NotEqual(typeof(Issue4664NativeMetadataFixtureTests).Assembly.GetName().Name, native.Assembly.GetName().Name);
        Assert.StartsWith("CSharpContract", native.Assembly.GetName().Name);
        Assert.Null(typeof(Issue4664NativeMetadataFixtureTests).Assembly.GetType(fullName));
        var context = AssemblyLoadContext.GetLoadContext(native.Assembly);
        Assert.NotNull(context);
        Assert.True(context.IsCollectible);

        string directory;
        using (var fixture = NativeMetadataFixtures.Compile())
        {
            directory = fixture.DirectoryPath;
            Assert.True(File.Exists(fixture.AssemblyPath));
            var loaded = fixture.Load();
            using var references = ReferenceResolver.WithReferences(new[] { fixture.AssemblyPath });
            // Private nested contracts are reflection inputs, not externally visible lookup candidates.
            Assert.True(references.TryResolveType(fullName, requireExternalVisibility: false, out var imported));
            // ReferenceResolver loads physical references as bytes, so Assembly.Location is empty.
            Assert.Equal(Path.GetFileNameWithoutExtension(fixture.AssemblyPath), imported.Assembly.GetName().Name);
            Assert.Contains(imported.Assembly, references.Assemblies);
            Assert.Equal(loaded.ManifestModule.ModuleVersionId, imported.Module.ModuleVersionId);
            Assert.Equal(native.FullName, imported.FullName);
            Assert.NotSame(typeof(Issue4664NativeMetadataFixtureTests).Assembly, imported.Assembly);
            this.output.WriteLine(
                $"Native Roslyn fixture: {fullName}; physical={fixture.AssemblyPath}; " +
                $"sha256={Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(fixture.AssemblyPath)))}; " +
                $"mvid={imported.Module.ModuleVersionId}; identity={imported.Assembly.FullName}");
        }

        Assert.False(Directory.Exists(directory));
    }

    [Fact]
    public void NullableContextAndByteArraysRemainNativeImportInputs()
    {
        using var fixture = NativeMetadataFixtures.Compile();
        using var references = ReferenceResolver.WithReferences(new[] { fixture.AssemblyPath });
        Assert.True(references.TryResolveType(
            "GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample", out var sample));

        var parent = Assert.IsAssignableFrom<Type>(sample.DeclaringType);
        var context = Assert.Single(parent.GetCustomAttributesData(),
            attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.NullableContextAttribute");
        Assert.Equal((byte)1, context.ConstructorArguments[0].Value);
        Assert.DoesNotContain(sample.GetCustomAttributesData(),
            attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.NullableContextAttribute");
        var surface = Assert.IsAssignableFrom<Type>(parent.GetNestedType("GenericSurface`1"));
        Assert.DoesNotContain(surface.GetCustomAttributesData(),
            attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.NullableContextAttribute");
        var valueContainer = Assert.IsAssignableFrom<Type>(parent.GetNestedType("ValueContainer`1"));
        var obliviousContext = Assert.Single(valueContainer.GetCustomAttributesData(),
            attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.NullableContextAttribute");
        Assert.Equal((byte)0, obliviousContext.ConstructorArguments[0].Value);

        var annotated = Assert.IsAssignableFrom<MethodInfo>(sample.GetMethod("AnnotatedReturn"));
        var nonNull = Assert.IsAssignableFrom<MethodInfo>(sample.GetMethod("NonNullReturn"));
        var dictionary = Assert.IsAssignableFrom<MethodInfo>(sample.GetMethod("GetDictionary"));
        var list = Assert.IsAssignableFrom<MethodInfo>(sample.GetMethod("GetList"));
        var nullableContext = Assert.Single(annotated.GetCustomAttributesData(),
            attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.NullableContextAttribute");
        Assert.Equal((byte)2, nullableContext.ConstructorArguments[0].Value);
        Assert.Empty(annotated.ReturnParameter.GetCustomAttributesData());
        Assert.Empty(nonNull.ReturnParameter.GetCustomAttributesData());
        Assert.Equal(new byte[] { 1, 1, 2 }, NullableBytes(dictionary.ReturnParameter));
        Assert.Equal(new byte[] { 1, 2 }, NullableBytes(list.ReturnParameter));
        Assert.Same(TypeSymbol.String, Assert.IsType<NullableTypeSymbol>(
            ClrNullability.GetReturnTypeSymbol(annotated)).UnderlyingType);
        Assert.Same(TypeSymbol.String, ClrNullability.GetReturnTypeSymbol(nonNull));
        var importedDictionary = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            ClrNullability.GetReturnTypeSymbol(dictionary));
        Assert.Same(TypeSymbol.String, importedDictionary.GetTypeArgumentSymbol(0));
        Assert.Same(TypeSymbol.String, Assert.IsType<NullableTypeSymbol>(
            importedDictionary.GetTypeArgumentSymbol(1)).UnderlyingType);
    }

    [Fact]
    public void OptionalParamsAndConstraintsRemainNativeImportInputs()
    {
        using var fixture = NativeMetadataFixtures.Compile();
        using var references = ReferenceResolver.WithReferences(new[] { fixture.AssemblyPath });
        Assert.True(references.TryResolveType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture", out var methods));
        var optional = Assert.IsAssignableFrom<MethodInfo>(methods.GetMethod("G_SerializeLike")).GetParameters()[1];
        Assert.True(optional.IsOptional);
        Assert.True(optional.HasDefaultValue);
        Assert.Null(optional.RawDefaultValue);
        Assert.DoesNotContain(methods.GetCustomAttributesData(),
            attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.NullableContextAttribute");

        Assert.True(references.TryResolveType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.Issue3394InlineOutTupleBindingTests", out var inference));
        var paramsMethod = Assert.IsAssignableFrom<MethodInfo>(
            inference.GetMethod("InvariantParams", BindingFlags.NonPublic | BindingFlags.Static));
        var parameter = Assert.Single(paramsMethod.GetParameters());
        Assert.True(parameter.ParameterType.IsArray);
        Assert.Contains(parameter.GetCustomAttributesData(),
            attribute => attribute.AttributeType.FullName == "System.ParamArrayAttribute");

        Assert.True(references.TryResolveType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ConstraintFixture", out var constraints));
        var classParameter = Assert.Single(Assert.IsAssignableFrom<MethodInfo>(
            constraints.GetMethod("OnlyClass")).GetGenericArguments());
        var structParameter = Assert.Single(Assert.IsAssignableFrom<MethodInfo>(
            constraints.GetMethod("OnlyStruct")).GetGenericArguments());
        var newParameter = Assert.Single(Assert.IsAssignableFrom<MethodInfo>(
            constraints.GetMethod("OnlyNew")).GetGenericArguments());
        Assert.Equal(GenericParameterAttributes.ReferenceTypeConstraint,
            classParameter.GenericParameterAttributes & GenericParameterAttributes.SpecialConstraintMask);
        Assert.Equal(GenericParameterAttributes.NotNullableValueTypeConstraint | GenericParameterAttributes.DefaultConstructorConstraint,
            structParameter.GenericParameterAttributes & GenericParameterAttributes.SpecialConstraintMask);
        Assert.Equal("System.ValueType", Assert.Single(structParameter.GetGenericParameterConstraints()).FullName);
        Assert.Equal(GenericParameterAttributes.DefaultConstructorConstraint,
            newParameter.GenericParameterAttributes & GenericParameterAttributes.SpecialConstraintMask);

        Assert.True(references.TryResolveType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.Issue3834GenericMethodClosureDiagnosticsTests+ConstraintFixture", out var dependent));
        var arguments = Assert.IsAssignableFrom<MethodInfo>(dependent.GetMethod("Dependent")).GetGenericArguments();
        Assert.Equal(2, arguments.Length);
        Assert.Equal(arguments[0], Assert.Single(arguments[1].GetGenericParameterConstraints()));
    }

    [Fact]
    public void PropertyGeneratorKeepsItsCompleteNativeCandidateSet()
    {
        var methods = CodeAnalysis.Binding.OverloadResolutionGenerators.Methods;
        Assert.Equal(20, methods.Length);
        Assert.Equal(15, CodeAnalysis.Binding.OverloadResolutionGenerators.FindOneParameterMethods().Length);
        Assert.All(methods, method =>
        {
            Assert.StartsWith("CSharpContract", method.Module.Assembly.GetName().Name);
            Assert.Same(
                NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionPropertyFixture"),
                method.DeclaringType);
        });
    }

    private static byte[] NullableBytes(ParameterInfo parameter)
    {
        var argument = Assert.Single(parameter.GetCustomAttributesData(),
            attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.NullableAttribute")
            .ConstructorArguments[0];
        return argument.Value is byte single
            ? new[] { single }
            : Assert.IsAssignableFrom<IList<CustomAttributeTypedArgument>>(argument.Value)
                .Select(item => (byte)item.Value).ToArray();
    }
}
