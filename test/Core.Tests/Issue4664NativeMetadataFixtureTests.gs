// <copyright file="Issue4664NativeMetadataFixtureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.Tests.CodeAnalysis.Binding
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Security.Cryptography
import Xunit
import Xunit.Abstractions

/// Issue #4664: import oracles must keep native Roslyn metadata after harness migration.
open class Issue4664NativeMetadataFixtureTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData("CodeAnalysis.Symbols.ClrNullabilityTests+Sample")
    @InlineData("CodeAnalysis.Symbols.ClrNullabilityTests+PairContainer`2")
    @InlineData("CodeAnalysis.Symbols.ClrNullabilityTests+ValueContainer`1")
    @InlineData("CodeAnalysis.Symbols.ClrNullabilityTests+GenericSurface`1")
    @InlineData("CodeAnalysis.Binding.OverloadResolutionTests+Fixture")
    @InlineData("CodeAnalysis.Binding.OverloadResolutionTests+EqualLike")
    @InlineData("CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+IA")
    @InlineData("CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+IB")
    @InlineData("CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+BothAB")
    @InlineData("CodeAnalysis.Binding.OverloadResolutionTests+ConstraintFixture")
    @InlineData("CodeAnalysis.Binding.OverloadResolutionTests+MapLike")
    @InlineData("CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayClass")
    @InlineData("CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayStruct")
    @InlineData("CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayNone")
    @InlineData("CodeAnalysis.Binding.OverloadResolutionTests+AmbiguousSameShapeA")
    @InlineData("CodeAnalysis.Binding.OverloadResolutionTests+AmbiguousSameShapeB")
    @InlineData("CodeAnalysis.Binding.Issue1482NumericWideningLatticeTests+NIntFixture")
    @InlineData("CodeAnalysis.Binding.Issue3834GenericMethodClosureDiagnosticsTests+ConstraintFixture")
    @InlineData("CodeAnalysis.Binding.Issue3834GenericMethodClosureDiagnosticsTests+CrossContextBase")
    @InlineData("CodeAnalysis.Binding.Issue3834GenericMethodClosureDiagnosticsTests+CrossContextDerived")
    @InlineData("CodeAnalysis.Binding.AccessPathTests+GenericFixture`1")
    @InlineData("CodeAnalysis.Binding.Issue3394InlineOutTupleBindingTests+OptionalNullFixture")
    @InlineData("CodeAnalysis.Binding.Issue3394InlineOutTupleBindingTests+InferenceBase")
    @InlineData("CodeAnalysis.Binding.Issue3394InlineOutTupleBindingTests+InferenceDerived")
    @InlineData("CodeAnalysis.Binding.OverloadResolutionPropertyFixture")
    @InlineData("CodeAnalysis.Documentation.DocIdSamples")
    @InlineData("Fixtures.UnscopedRefIndexerFixture")
    @InlineData("Fixtures.UnscopedRefIndexerPropertyLevelFixture")
    func ConsumersUseNativeTypesAndExplicitPhysicalReferences(relativeName string) {
        let fullName = "GSharp.Core.Tests." + relativeName
        let native = NativeMetadataFixtures.GetType(fullName)
        Assert.NotEqual(
            typeof(Issue4664NativeMetadataFixtureTests).Assembly.GetName().Name,
            native.Assembly.GetName().Name
        )
        Assert.StartsWith("CSharpContract", native.Assembly.GetName().Name)
        Assert.Null(typeof(Issue4664NativeMetadataFixtureTests).Assembly.GetType(fullName))
        let context AssemblyLoadContext? = AssemblyLoadContext.GetLoadContext(native.Assembly)
        Assert.NotNull(context)
        Assert.True(context!!.IsCollectible)
        var directory string
        {
            using let fixture = NativeMetadataFixtures.Compile()
            directory = fixture.DirectoryPath
            Assert.True(File.Exists(fixture.AssemblyPath))
            let loaded = fixture.Load()
            using let references = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
            // Private nested contracts are reflection inputs, not externally visible lookup candidates.
            Assert.True(references.TryResolveType(fullName, requireExternalVisibility: false, out var imported))
            // ReferenceResolver loads physical references as bytes, so Assembly.Location is empty.
            Assert.Equal(Path.GetFileNameWithoutExtension(fixture.AssemblyPath), imported.Assembly.GetName().Name)
            Assert.Contains(imported.Assembly, references.Assemblies)
            Assert.Equal(loaded.ManifestModule.ModuleVersionId, imported.Module.ModuleVersionId)
            Assert.Equal(native.FullName, imported.FullName)
            Assert.NotSame(typeof(Issue4664NativeMetadataFixtureTests).Assembly, imported.Assembly)
            this.output.WriteLine(
                "Native Roslyn fixture: $fullName; physical=${fixture.AssemblyPath}; " +
                    "sha256=${Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(fixture.AssemblyPath)))}; " +
                    "mvid=${imported.Module.ModuleVersionId}; identity=${imported.Assembly.FullName}"
            )
        }
        Assert.False(Directory.Exists(directory))
    }

    @Fact
    func NullableContextAndByteArraysRemainNativeImportInputs() {
        using let fixture = NativeMetadataFixtures.Compile()
        using let references = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        Assert.True(
            references.TryResolveType(
                "GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample",
                out var sample
            )
        )
        let parent = Assert.IsAssignableFrom[Type](sample.DeclaringType)
        let context = Assert.Single(
            parent.GetCustomAttributesData(),
            (attribute CustomAttributeData) -> attribute
                .AttributeType
                .FullName == "System.Runtime.CompilerServices.NullableContextAttribute"
        )
        Assert.Equal(uint8(1), context.ConstructorArguments[0].Value)
        Assert.DoesNotContain(
            sample.GetCustomAttributesData(),
            (attribute CustomAttributeData) -> attribute
                .AttributeType
                .FullName == "System.Runtime.CompilerServices.NullableContextAttribute"
        )
        let surface = Assert.IsAssignableFrom[Type](parent.GetNestedType("GenericSurface`1"))
        Assert.DoesNotContain(
            surface.GetCustomAttributesData(),
            (attribute CustomAttributeData) -> attribute
                .AttributeType
                .FullName == "System.Runtime.CompilerServices.NullableContextAttribute"
        )
        let valueContainer = Assert.IsAssignableFrom[Type](parent.GetNestedType("ValueContainer`1"))
        let obliviousContext = Assert.Single(
            valueContainer.GetCustomAttributesData(),
            (attribute CustomAttributeData) -> attribute
                .AttributeType
                .FullName == "System.Runtime.CompilerServices.NullableContextAttribute"
        )
        Assert.Equal(uint8(0), obliviousContext.ConstructorArguments[0].Value)
        let annotated = Assert.IsAssignableFrom[MethodInfo](sample.GetMethod("AnnotatedReturn"))
        let nonNull = Assert.IsAssignableFrom[MethodInfo](sample.GetMethod("NonNullReturn"))
        let dictionary = Assert.IsAssignableFrom[MethodInfo](sample.GetMethod("GetDictionary"))
        let list = Assert.IsAssignableFrom[MethodInfo](sample.GetMethod("GetList"))
        let nullableContext = Assert.Single(
            annotated.GetCustomAttributesData(),
            (attribute CustomAttributeData) -> attribute
                .AttributeType
                .FullName == "System.Runtime.CompilerServices.NullableContextAttribute"
        )
        Assert.Equal(uint8(2), nullableContext.ConstructorArguments[0].Value)
        Assert.Empty(annotated.ReturnParameter.GetCustomAttributesData())
        Assert.Empty(nonNull.ReturnParameter.GetCustomAttributesData())
        Assert.Equal([]uint8{1, 1, 2}, NullableBytes(dictionary.ReturnParameter))
        Assert.Equal([]uint8{1, 2}, NullableBytes(list.ReturnParameter))
        Assert.Same(
            TypeSymbol.String,
            Assert.IsType[NullableTypeSymbol](ClrNullability.GetReturnTypeSymbol(annotated)).UnderlyingType
        )
        Assert.Same(TypeSymbol.String, ClrNullability.GetReturnTypeSymbol(nonNull))
        let importedDictionary = Assert.IsType[NullabilityAnnotatedTypeSymbol](
            ClrNullability.GetReturnTypeSymbol(dictionary)
        )
        Assert.Same(TypeSymbol.String, importedDictionary.GetTypeArgumentSymbol(0))
        Assert.Same(
            TypeSymbol.String,
            Assert.IsType[NullableTypeSymbol](importedDictionary.GetTypeArgumentSymbol(1)).UnderlyingType
        )
    }

    @Fact
    func OptionalParamsAndConstraintsRemainNativeImportInputs() {
        using let fixture = NativeMetadataFixtures.Compile()
        using let references = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        Assert.True(
            references.TryResolveType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture",
                out var methods
            )
        )
        let optional = Assert.IsAssignableFrom[MethodInfo](methods.GetMethod("G_SerializeLike")).GetParameters()[1]
        Assert.True(optional.IsOptional)
        Assert.True(optional.HasDefaultValue)
        Assert.Null(optional.RawDefaultValue)
        Assert.DoesNotContain(
            methods.GetCustomAttributesData(),
            (attribute CustomAttributeData) -> attribute
                .AttributeType
                .FullName == "System.Runtime.CompilerServices.NullableContextAttribute"
        )
        Assert.True(
            references.TryResolveType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.Issue3394InlineOutTupleBindingTests",
                out var inference
            )
        )
        let paramsMethod = Assert.IsAssignableFrom[MethodInfo](
            inference.GetMethod("InvariantParams", BindingFlags.NonPublic | BindingFlags.Static)
        )
        let parameter = Assert.Single(paramsMethod.GetParameters())
        Assert.True(parameter.ParameterType.IsArray)
        Assert.Contains(
            parameter.GetCustomAttributesData(),
            (attribute CustomAttributeData) -> attribute.AttributeType.FullName == "System.ParamArrayAttribute"
        )
        Assert.True(
            references.TryResolveType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ConstraintFixture",
                out var constraints
            )
        )
        let classParameter = Assert.Single(
            Assert.IsAssignableFrom[MethodInfo](constraints.GetMethod("OnlyClass")).GetGenericArguments()
        )
        let structParameter = Assert.Single(
            Assert.IsAssignableFrom[MethodInfo](constraints.GetMethod("OnlyStruct")).GetGenericArguments()
        )
        let newParameter = Assert.Single(
            Assert.IsAssignableFrom[MethodInfo](constraints.GetMethod("OnlyNew")).GetGenericArguments()
        )
        Assert.Equal(
            GenericParameterAttributes.ReferenceTypeConstraint,
            classParameter.GenericParameterAttributes & GenericParameterAttributes.SpecialConstraintMask
        )
        Assert.Equal(
            GenericParameterAttributes.NotNullableValueTypeConstraint | GenericParameterAttributes.DefaultConstructorConstraint,
            structParameter.GenericParameterAttributes & GenericParameterAttributes.SpecialConstraintMask
        )
        Assert.Equal("System.ValueType", Assert.Single(structParameter.GetGenericParameterConstraints()).FullName)
        Assert.Equal(
            GenericParameterAttributes.DefaultConstructorConstraint,
            newParameter.GenericParameterAttributes & GenericParameterAttributes.SpecialConstraintMask
        )
        Assert.True(
            references.TryResolveType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.Issue3834GenericMethodClosureDiagnosticsTests+ConstraintFixture",
                out var dependent
            )
        )
        let arguments = Assert.IsAssignableFrom[MethodInfo](dependent.GetMethod("Dependent")).GetGenericArguments()
        Assert.Equal(2, arguments.Length)
        Assert.Equal(arguments[0], Assert.Single(arguments[1].GetGenericParameterConstraints()))
    }

    @Fact
    func PropertyGeneratorKeepsItsCompleteNativeCandidateSet() {
        let methods = OverloadResolutionGenerators.Methods
        Assert.Equal(20, methods.Length)
        Assert.Equal(15, OverloadResolutionGenerators.FindOneParameterMethods().Length)
        Assert.All(
            methods,
            (method MethodInfo) -> {
                Assert.StartsWith("CSharpContract", method.Module.Assembly.GetName().Name)
                Assert.Same(
                    NativeMetadataFixtures.GetType(
                        "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionPropertyFixture"
                    ),
                    method.DeclaringType
                )
            }
        )
    }

    shared {
        private func NullableBytes(parameter ParameterInfo)[]uint8 {
            let argument = Assert.Single(
                parameter.GetCustomAttributesData(),
                (attribute CustomAttributeData) -> attribute
                    .AttributeType
                    .FullName == "System.Runtime.CompilerServices.NullableAttribute"
            )
                .ConstructorArguments[0]
            return if argument.Value is uint8 single {
                []uint8{single}
            } else {
                Assert
                    .IsAssignableFrom[IList[CustomAttributeTypedArgument]](argument.Value)
                    .Select((item CustomAttributeTypedArgument) -> uint8(item.Value))
                    .ToArray()
            }
        }
    }
}
