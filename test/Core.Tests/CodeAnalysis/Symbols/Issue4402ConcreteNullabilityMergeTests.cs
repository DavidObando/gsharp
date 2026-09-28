// <copyright file="Issue4402ConcreteNullabilityMergeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #4402: concrete arrays and value tuples reached through a symbolic
/// receiver must read their complete declaration-site nullable layout.
/// </summary>
public sealed class Issue4402ConcreteNullabilityMergeTests
{
    [Fact]
    public void SymbolicReceiver_Reads_Concrete_Array_Tuple_Nested_ByRef_And_ValueNullable_Positions()
    {
        using var scope = NullabilityOptions.Enter(NullabilityMode.PlatformTypes);
        var receiver = Receiver(typeof(Surface<string>), NullableTypeSymbol.Get(TypeSymbol.String));
        var clr = typeof(Surface<string>);

        var add = RequiredMethod(clr, nameof(Surface<string>.Add));
        AssertConcretePairArray(MemberLookup.GetClrMethodParameterTypeSymbol(receiver, add, 1));

        var byRef = Assert.IsType<ByRefTypeSymbol>(
            MemberLookup.GetClrMethodParameterTypeSymbol(
                receiver,
                RequiredMethod(clr, nameof(Surface<string>.Mutate)),
                0));
        AssertConcretePairArray(byRef.PointeeType);

        var tuple = MemberLookup.GetClrPropertyTypeSymbol(
            receiver,
            RequiredProperty(clr, nameof(Surface<string>.ConcreteTuple)));
        Assert.Equal(
            new[] { ReferenceNullabilityKind.NotNull, ReferenceNullabilityKind.Nullable },
            tuple.GetElementPositions().Select(element => element.ReferenceNullability));

        var nullableTuple = Assert.IsType<NullableTypeSymbol>(
            MemberLookup.GetClrPropertyTypeSymbol(
                receiver,
                RequiredProperty(clr, nameof(Surface<string>.NullableTuple))));
        Assert.Equal(
            new[] { ReferenceNullabilityKind.NotNull, ReferenceNullabilityKind.Nullable },
            nullableTuple.GetElementPositions().Select(element => element.ReferenceNullability));

        var nested = MemberLookup.GetClrPropertyTypeSymbol(
            receiver,
            RequiredProperty(clr, nameof(Surface<string>.Nested)));
        var nestedArray = Assert.Single(nested.GetElementPositions());
        AssertConcretePairArray(nestedArray);

        var nullablePair = Assert.IsType<NullableTypeSymbol>(
            MemberLookup.GetClrPropertyTypeSymbol(
                receiver,
                RequiredProperty(clr, nameof(Surface<string>.NullablePair))));
        Assert.Equal(
            new[] { ReferenceNullabilityKind.NotNull, ReferenceNullabilityKind.Nullable },
            nullablePair.GetElementPositions().Select(element => element.ReferenceNullability));
    }

    [Fact]
    public void SymbolicReceiver_Preserves_Substituted_Array_And_Tuple_Arguments()
    {
        using var scope = NullabilityOptions.Enter(NullabilityMode.PlatformTypes);
        var receiver = Receiver(typeof(Surface<string>), NullableTypeSymbol.Get(TypeSymbol.String));
        var clr = typeof(Surface<string>);

        var genericArray = MemberLookup.GetClrPropertyTypeSymbol(
            receiver,
            RequiredProperty(clr, nameof(Surface<string>.GenericArray)));
        Assert.Equal(
            ReferenceNullabilityKind.Nullable,
            Assert.Single(genericArray.GetElementPositions()).ReferenceNullability);

        var genericTuple = MemberLookup.GetClrPropertyTypeSymbol(
            receiver,
            RequiredProperty(clr, nameof(Surface<string>.GenericTuple)));
        Assert.Equal(
            new[] { ReferenceNullabilityKind.Nullable, ReferenceNullabilityKind.Nullable },
            genericTuple.GetElementPositions().Select(element => element.ReferenceNullability));

        var valueReceiver = Receiver(typeof(Surface<int>), TypeSymbol.Int32);
        var valueArray = MemberLookup.GetClrPropertyTypeSymbol(
            valueReceiver,
            RequiredProperty(typeof(Surface<int>), nameof(Surface<int>.GenericArray)));
        Assert.Same(TypeSymbol.Int32, Assert.Single(valueArray.GetElementPositions()));
    }

    [Fact]
    public void NetStandard20_SymbolicReceiver_Reads_Platform_Array_And_Element()
    {
        using var scope = NullabilityOptions.Enter(NullabilityMode.PlatformTypes);
        var refDirectory = typeof(Issue4402ConcreteNullabilityMergeTests).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(attribute => attribute.Key == "NetStandard20ReferenceDirectory")
            .Value ?? throw new Xunit.Sdk.XunitException("prerequisite missing: NetStandard20ReferenceDirectory");
        Assert.True(Directory.Exists(refDirectory), $"prerequisite missing: '{refDirectory}'");

        using var resolver = ReferenceResolver.WithReferences(Directory.EnumerateFiles(refDirectory, "*.dll"));
        Assert.True(resolver.TryResolveType("System.Threading.Tasks.TaskFactory`1", out var factoryDefinition));
        Assert.True(resolver.TryResolveType("System.String", out var stringType));
        var closedFactory = factoryDefinition.MakeGenericType(stringType);
        var continueWhenAll = closedFactory.GetMethods()
            .Single(method => method.Name == "ContinueWhenAll"
                && method.GetParameters() is [var tasks, _]
                && tasks.ParameterType.IsArray
                && tasks.ParameterType.GetElementType()?.FullName == "System.Threading.Tasks.Task");
        var receiver = ImportedTypeSymbol.GetConstructed(
            closedFactory,
            factoryDefinition,
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.String));

        var tasks = MemberLookup.GetClrMethodParameterTypeSymbol(receiver, continueWhenAll, 0);
        Assert.Equal(ReferenceNullabilityKind.Platform, tasks.ReferenceNullability);
        Assert.Equal(
            ReferenceNullabilityKind.Platform,
            Assert.Single(tasks.GetElementPositions()).ReferenceNullability);
    }

    private static ImportedTypeSymbol Receiver(Type closedType, TypeSymbol argument)
        => ImportedTypeSymbol.GetConstructed(
            closedType,
            typeof(Surface<>),
            ImmutableArray.Create(argument));

    private static MethodInfo RequiredMethod(Type type, string name)
        => type.GetMethod(name)
            ?? throw new Xunit.Sdk.XunitException($"{type}.{name} not found");

    private static PropertyInfo RequiredProperty(Type type, string name)
        => type.GetProperty(name)
            ?? throw new Xunit.Sdk.XunitException($"{type}.{name} not found");

    private static void AssertConcretePairArray(TypeSymbol array)
    {
        Assert.Equal(ReferenceNullabilityKind.NotNull, array.ReferenceNullability);
        var pair = Assert.Single(array.GetElementPositions());
        Assert.Equal(ReferenceNullabilityKind.NotApplicable, pair.ReferenceNullability);
        Assert.Equal(
            new[] { ReferenceNullabilityKind.NotNull, ReferenceNullabilityKind.Nullable },
            pair.GetElementPositions().Select(element => element.ReferenceNullability));
    }

    private sealed class Surface<T>
    {
        public KeyValuePair<string, object?>[] ConcreteArray { get; } = Array.Empty<KeyValuePair<string, object?>>();

        public (string, object?) ConcreteTuple { get; }

        public (string, object?)? NullableTuple { get; }

        public List<KeyValuePair<string, object?>[]> Nested { get; } = new();

        public KeyValuePair<string, object?>? NullablePair { get; }

        public T[] GenericArray { get; } = Array.Empty<T>();

        public (T, object?) GenericTuple { get; }

        public void Add(T value, KeyValuePair<string, object?>[] tags)
        {
        }

        public void Mutate(ref KeyValuePair<string, object?>[] tags)
        {
        }
    }
}
