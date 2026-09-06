// <copyright file="Issue3834GenericMethodClosureDiagnosticsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Binding.OverloadResolution;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3834: <see cref="MethodInfo.MakeGenericMethod(Type[])"/> failures
/// caused by mixed reflection contexts are compiler invariant violations, not
/// ordinary generic-constraint inapplicability.
/// </summary>
public class Issue3834GenericMethodClosureDiagnosticsTests
{
    [Fact]
    public void RuntimeConstraintFailure_RemainsOrdinaryCandidateRejection()
    {
        MethodInfo open = typeof(ConstraintFixture).GetMethod(
            nameof(ConstraintFixture.Dependent),
            BindingFlags.Public | BindingFlags.Static);

        var result = ClrOverloadResolution.Resolve(
            new[] { open },
            Array.Empty<Type>(),
            explicitTypeArgs: new[] { typeof(string), typeof(object) });

        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void RuntimeByRefLikeArgument_RemainsOrdinaryCandidateRejection()
    {
        MethodInfo open = typeof(ConstraintFixture).GetMethod(
            nameof(ConstraintFixture.Identity),
            BindingFlags.Public | BindingFlags.Static);

        var result = ClrOverloadResolution.Resolve(
            new[] { open },
            new[] { typeof(Span<int>) });

        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void RuntimeCrossContextTypeArgument_ProducesInternalDiagnostic()
    {
        byte[] image = File.ReadAllBytes(typeof(SyntaxNode).Assembly.Location);
        var firstContext = new IsolatedLoadContext("issue3834-first");
        var secondContext = new IsolatedLoadContext("issue3834-second");

        try
        {
            Assembly firstAssembly = Load(firstContext, image);
            Assembly secondAssembly = Load(secondContext, image);
            Type firstNode = GetRequiredType(
                firstAssembly,
                "GSharp.Core.CodeAnalysis.Syntax.SyntaxNode");
            Type secondFunction = GetRequiredType(
                secondAssembly,
                "GSharp.Core.CodeAnalysis.Syntax.FunctionDeclarationSyntax");
            MethodInfo open = firstNode.GetMethods()
                .Single(method =>
                    method.Name == nameof(SyntaxNode.FirstAncestorOrSelf)
                    && method.IsGenericMethodDefinition);

            InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
                () => ClrOverloadResolution.Resolve(
                    new[] { open },
                    Array.Empty<Type>(),
                    explicitTypeArgs: new[] { secondFunction }));

            AssertInternalDiagnostic(exception, nameof(SyntaxNode.FirstAncestorOrSelf));
        }
        finally
        {
            firstContext.Unload();
            secondContext.Unload();
        }
    }

    [Fact]
    public void MetadataLoadContextConstraintFailure_RemainsOrdinaryCandidateRejection()
    {
        using ReferenceResolver resolver = CreateMetadataLoadContextResolver();
        Assert.True(resolver.TryResolveType("System.Nullable", out Type nullable));
        MethodInfo open = nullable.GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Single(method => method.Name == nameof(Nullable.Compare) && method.IsGenericMethodDefinition);
        Type stringType = resolver.MapClrTypeToReferences(typeof(string));

        var result = ClrOverloadResolution.Resolve(
            new[] { open },
            Array.Empty<Type>(),
            explicitTypeArgs: new[] { stringType });

        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void MetadataLoadContextRuntimeInference_ProducesInternalDiagnostic()
    {
        using ReferenceResolver resolver = CreateMetadataLoadContextResolver();
        Assert.True(resolver.TryResolveType("System.Linq.Enumerable", out Type enumerable));
        MethodInfo open = enumerable.GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Single(method =>
                method.Name == nameof(Enumerable.Repeat)
                && method.IsGenericMethodDefinition);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => ClrOverloadResolution.Resolve(
                new[] { open },
                new[] { typeof(string), typeof(int) }));

        AssertInternalDiagnostic(exception, nameof(Enumerable.Repeat));
    }

    [Fact]
    public void ErasedSymbol_DoesNotHideCrossContextConcreteArgument()
    {
        byte[] image = File.ReadAllBytes(typeof(Issue3834GenericMethodClosureDiagnosticsTests).Assembly.Location);
        var firstContext = new IsolatedLoadContext("issue3834-mixed-first");
        var secondContext = new IsolatedLoadContext("issue3834-mixed-second");

        try
        {
            Assembly firstAssembly = Load(firstContext, image);
            Assembly secondAssembly = Load(secondContext, image);
            Type firstFixture = GetRequiredType(firstAssembly, typeof(ConstraintFixture).FullName);
            Type secondDerived = GetRequiredType(secondAssembly, typeof(CrossContextDerived).FullName);
            MethodInfo open = firstFixture.GetMethod(
                nameof(ConstraintFixture.Mixed),
                BindingFlags.Public | BindingFlags.Static);
            var erased = new TypeParameterSymbol(
                "TErased",
                0,
                TypeParameterConstraint.Any,
                TypeParameterVariance.None);
            ImmutableArray<TypeSymbol> recovered = ImmutableArray.Create<TypeSymbol>(
                erased,
                TypeSymbol.FromClrType(secondDerived));

            InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
                () => ClrOverloadResolution.Resolve(
                    new[] { open },
                    Array.Empty<Type>(),
                    explicitTypeArgs: new[] { typeof(object), secondDerived },
                    recoverTypeArgSymbols: (_, _) => recovered));

            AssertInternalDiagnostic(exception, nameof(ConstraintFixture.Mixed));
        }
        finally
        {
            firstContext.Unload();
            secondContext.Unload();
        }
    }

    private static void AssertInternalDiagnostic(
        InvalidOperationException exception,
        string methodName)
    {
        var diagnostic = Compilation.CreateInternalErrorDiagnostic(exception);

        Assert.Equal("GS9998", diagnostic.Id);
        Assert.Contains("generic method closure invariant", diagnostic.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("incompatible reflection/load contexts", diagnostic.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(methodName, diagnostic.Message, StringComparison.Ordinal);
    }

    private static Assembly Load(AssemblyLoadContext context, byte[] image)
    {
        using var stream = new MemoryStream(image, writable: false);
        return context.LoadFromStream(stream);
    }

    private static Type GetRequiredType(Assembly assembly, string fullName)
        => assembly.GetType(fullName, throwOnError: true)
            ?? throw new InvalidOperationException($"Assembly does not declare '{fullName}'.");

    private static ReferenceResolver CreateMetadataLoadContextResolver()
        => ReferenceResolver.WithReferences(
            Directory.EnumerateFiles(
                RuntimeEnvironment.GetRuntimeDirectory(),
                "*.dll",
                SearchOption.TopDirectoryOnly));

    private sealed class IsolatedLoadContext : AssemblyLoadContext
    {
        public IsolatedLoadContext(string name)
            : base(name, isCollectible: true)
        {
        }

        protected override Assembly Load(AssemblyName assemblyName) => null;
    }

    public static class ConstraintFixture
    {
        public static void Dependent<TBase, TDerived>()
            where TDerived : TBase
        {
        }

        public static T Identity<T>(T value) => value;

        public static void Mixed<TErased, TConcrete>()
            where TConcrete : CrossContextBase
        {
        }
    }

    public class CrossContextBase
    {
    }

    public sealed class CrossContextDerived : CrossContextBase
    {
    }
}
