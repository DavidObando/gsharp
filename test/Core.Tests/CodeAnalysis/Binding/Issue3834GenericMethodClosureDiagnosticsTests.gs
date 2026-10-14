// <copyright file="Issue3834GenericMethodClosureDiagnosticsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.Tests
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.InteropServices
import System.Runtime.Loader
import Xunit

/// Issue #3834: (cref:MethodInfo.MakeGenericMethod(Type[])) failures
/// caused by mixed reflection contexts are compiler invariant violations, not
/// ordinary generic-constraint inapplicability.
open class Issue3834GenericMethodClosureDiagnosticsTests {
    @Fact
    func RuntimeConstraintFailure_RemainsOrdinaryCandidateRejection() {
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.Issue3834GenericMethodClosureDiagnosticsTests+ConstraintFixture"
        )
            .GetMethod("Dependent", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve(
            []MethodInfo{open_!!},
            Array.Empty[Type](),
            explicitTypeArgs: []Type{typeof(string), typeof(object)}
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome)
    }

    @Fact
    func RuntimeByRefLikeArgument_RemainsOrdinaryCandidateRejection() {
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.Issue3834GenericMethodClosureDiagnosticsTests+ConstraintFixture"
        )
            .GetMethod("Identity", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{open_!!}, []Type{typeof(Span[int32])})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome)
    }

    @Fact
    func RuntimeCrossContextTypeArgument_ProducesInternalDiagnostic() {
        let image = File.ReadAllBytes(typeof(SyntaxNode).Assembly.Location)
        let firstContext = IsolatedLoadContext("issue3834-first")
        let secondContext = IsolatedLoadContext("issue3834-second")
        try {
            let firstAssembly = Load(firstContext, image)
            let secondAssembly = Load(secondContext, image)
            let firstNode = GetRequiredType(firstAssembly, "GSharp.Core.CodeAnalysis.Syntax.SyntaxNode")
            let secondFunction = GetRequiredType(
                secondAssembly,
                "GSharp.Core.CodeAnalysis.Syntax.FunctionDeclarationSyntax"
            )
            let open_ = firstNode.GetMethods().Single(
                (method MethodInfo) -> method.Name == "FirstAncestorOrSelf" && method.IsGenericMethodDefinition
            )
            let exception = Assert.Throws[InvalidOperationException](
                func () object? {
                    return ClrOverloadResolution.Resolve(
                        []MethodInfo{open_},
                        Array.Empty[Type](),
                        explicitTypeArgs: []Type{secondFunction}
                    )
                }
            )
            AssertInternalDiagnostic(exception, "FirstAncestorOrSelf")
        } finally {
            firstContext.Unload()
            secondContext.Unload()
        }
    }

    @Fact
    func MetadataLoadContextConstraintFailure_RemainsOrdinaryCandidateRejection() {
        using let resolver = CreateMetadataLoadContextResolver()
        Assert.True(resolver.TryResolveType("System.Nullable", out var nullable))
        let open_ = nullable.GetMethods(BindingFlags.Public | BindingFlags.Static).Single(
            (method MethodInfo) -> method.Name == "Compare" && method.IsGenericMethodDefinition
        )
        let stringType = resolver.MapClrTypeToReferences(typeof(string))
        let result = ClrOverloadResolution.Resolve(
            []MethodInfo{open_},
            Array.Empty[Type](),
            explicitTypeArgs: []Type{stringType}
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome)
    }

    @Fact
    func MetadataLoadContextRuntimeInference_ProducesInternalDiagnostic() {
        using let resolver = CreateMetadataLoadContextResolver()
        Assert.True(resolver.TryResolveType("System.Linq.Enumerable", out var enumerable))
        let open_ = enumerable.GetMethods(BindingFlags.Public | BindingFlags.Static).Single(
            (method MethodInfo) -> method.Name == "Repeat" && method.IsGenericMethodDefinition
        )
        let exception = Assert.Throws[InvalidOperationException](
            func () object? {
                return ClrOverloadResolution.Resolve([]MethodInfo{open_}, []Type{typeof(string), typeof(int32)})
            }
        )
        AssertInternalDiagnostic(exception, "Repeat")
    }

    @Fact
    func ErasedSymbol_DoesNotHideCrossContextConcreteArgument() {
        let image = NativeMetadataFixtures.Image
        let firstContext = IsolatedLoadContext("issue3834-mixed-first")
        let secondContext = IsolatedLoadContext("issue3834-mixed-second")
        try {
            let firstAssembly = Load(firstContext, image)
            let secondAssembly = Load(secondContext, image)
            let firstFixture = GetRequiredType(
                firstAssembly,
                NativeMetadataFixtures.GetType(
                    "GSharp.Core.Tests.CodeAnalysis.Binding.Issue3834GenericMethodClosureDiagnosticsTests+ConstraintFixture"
                )
                    .FullName
            )
            let secondDerived = GetRequiredType(
                secondAssembly,
                NativeMetadataFixtures.GetType(
                    "GSharp.Core.Tests.CodeAnalysis.Binding.Issue3834GenericMethodClosureDiagnosticsTests+CrossContextDerived"
                )
                    .FullName
            )
            let open_ MethodInfo? = firstFixture.GetMethod("Mixed", BindingFlags.Public | BindingFlags.Static)
            let erased = TypeParameterSymbol("TErased", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
            let recovered = ImmutableArray.Create[TypeSymbol](erased, TypeSymbol.FromClrType(secondDerived))
            let exception = Assert.Throws[InvalidOperationException](
                func () object? {
                    return ClrOverloadResolution.Resolve(
                        []MethodInfo{open_!!},
                        Array.Empty[Type](),
                        explicitTypeArgs: []Type{typeof(object), secondDerived},
                        recoverTypeArgSymbols: func (_ MethodInfo, _ bool) ImmutableArray[TypeSymbol?] {
                            return recovered
                        }
                    )
                }
            )
            AssertInternalDiagnostic(exception, "Mixed")
        } finally {
            firstContext.Unload()
            secondContext.Unload()
        }
    }

    private class IsolatedLoadContext : AssemblyLoadContext {
        init(name string) : base(name, true) { }

        protected override func Load(assemblyName AssemblyName) Assembly? -> nil
    }

    shared {
        private func AssertInternalDiagnostic(exception InvalidOperationException, methodName string) {
            let diagnostic = Compilation.CreateInternalErrorDiagnostic(exception)
            Assert.Equal("GS9998", diagnostic.Id)
            Assert.Contains("generic method closure invariant", diagnostic.Message, StringComparison.OrdinalIgnoreCase)
            Assert.Contains(
                "incompatible reflection/load contexts",
                diagnostic.Message,
                StringComparison.OrdinalIgnoreCase
            )
            Assert.Contains(methodName, diagnostic.Message, StringComparison.Ordinal)
        }

        private func Load(context AssemblyLoadContext, image[]uint8) Assembly {
            using let stream = MemoryStream(image, writable: false)
            return context.LoadFromStream(stream)
        }

        private func GetRequiredType(assembly Assembly, fullName string?) Type -> assembly.GetType(
            fullName!!,
            throwOnError: true
        ) ??
            throw InvalidOperationException("Assembly does not declare '$fullName'.")

        private func CreateMetadataLoadContextResolver() ReferenceResolver -> ReferenceResolver.WithReferences(
            Directory.EnumerateFiles(RuntimeEnvironment.GetRuntimeDirectory(), "*.dll", SearchOption.TopDirectoryOnly)
        )
    }
}
