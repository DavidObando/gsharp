// <copyright file="Issue4402ConcreteNullabilityMergeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import Xunit
import Xunit.Sdk

/// Issue #4402: concrete arrays and value tuples reached through a symbolic
/// receiver must read their complete declaration-site nullable layout.
class Issue4402ConcreteNullabilityMergeTests {
    @Fact
    func SymbolicReceiver_Reads_Concrete_Array_Tuple_Nested_ByRef_And_ValueNullable_Positions() {
        using let scope_ = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
        let receiver = Receiver(typeof(Surface[string]), NullableTypeSymbol.Get(TypeSymbol.String))
        let clr = typeof(Surface[string])
        let add = RequiredMethod(clr, "Add")
        AssertConcretePairArray(MemberLookup.GetClrMethodParameterTypeSymbol(receiver, add, 1))
        let byRef = Assert.IsType[ByRefTypeSymbol](
            MemberLookup.GetClrMethodParameterTypeSymbol(receiver, RequiredMethod(clr, "Mutate"), 0)
        )
        AssertConcretePairArray(byRef.PointeeType)
        let tuple = MemberLookup.GetClrPropertyTypeSymbol(receiver, RequiredProperty(clr, "ConcreteTuple"))
        Assert.Equal(
            []ReferenceNullabilityKind{ReferenceNullabilityKind.NotNull, ReferenceNullabilityKind.Nullable},
            tuple.GetElementPositions().Select((element TypeSymbol) -> element.ReferenceNullability)
        )
        let nullableTuple = Assert.IsType[NullableTypeSymbol](
            MemberLookup.GetClrPropertyTypeSymbol(receiver, RequiredProperty(clr, "NullableTuple"))
        )
        Assert.Equal(
            []ReferenceNullabilityKind{ReferenceNullabilityKind.NotNull, ReferenceNullabilityKind.Nullable},
            nullableTuple.GetElementPositions().Select((element TypeSymbol) -> element.ReferenceNullability)
        )
        let nested = MemberLookup.GetClrPropertyTypeSymbol(receiver, RequiredProperty(clr, "Nested"))
        let nestedArray = Assert.Single(nested.GetElementPositions())
        AssertConcretePairArray(nestedArray)
        let nullablePair = Assert.IsType[NullableTypeSymbol](
            MemberLookup.GetClrPropertyTypeSymbol(receiver, RequiredProperty(clr, "NullablePair"))
        )
        Assert.Equal(
            []ReferenceNullabilityKind{ReferenceNullabilityKind.NotNull, ReferenceNullabilityKind.Nullable},
            nullablePair.GetElementPositions().Select((element TypeSymbol) -> element.ReferenceNullability)
        )
    }

    @Fact
    func SymbolicReceiver_Preserves_Substituted_Array_And_Tuple_Arguments() {
        using let scope_ = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
        let receiver = Receiver(typeof(Surface[string]), NullableTypeSymbol.Get(TypeSymbol.String))
        let clr = typeof(Surface[string])
        let genericArray = MemberLookup.GetClrPropertyTypeSymbol(receiver, RequiredProperty(clr, "GenericArray"))
        Assert.Equal(
            ReferenceNullabilityKind.Nullable,
            Assert.Single(genericArray.GetElementPositions()).ReferenceNullability
        )
        let genericTuple = MemberLookup.GetClrPropertyTypeSymbol(receiver, RequiredProperty(clr, "GenericTuple"))
        Assert.Equal(
            []ReferenceNullabilityKind{ReferenceNullabilityKind.Nullable, ReferenceNullabilityKind.Nullable},
            genericTuple.GetElementPositions().Select((element TypeSymbol) -> element.ReferenceNullability)
        )
        let valueReceiver = Receiver(typeof(Surface[int32]), TypeSymbol.Int32)
        let valueArray = MemberLookup.GetClrPropertyTypeSymbol(
            valueReceiver,
            RequiredProperty(typeof(Surface[int32]), "GenericArray")
        )
        Assert.Same(TypeSymbol.Int32, Assert.Single(valueArray.GetElementPositions()))
    }

    @Fact
    func NetStandard20_SymbolicReceiver_Reads_Platform_Array_And_Element() {
        using let scope_ = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
        let refDirectory = typeof(Issue4402ConcreteNullabilityMergeTests)
            .Assembly
            .GetCustomAttributes[AssemblyMetadataAttribute]()
            .Single((attribute AssemblyMetadataAttribute) -> attribute.Key == "NetStandard20ReferenceDirectory")
            .Value ??
            throw XunitException("prerequisite missing: NetStandard20ReferenceDirectory")
        Assert.True(Directory.Exists(refDirectory), "prerequisite missing: '$refDirectory'")
        using let resolver = ReferenceResolver.WithReferences(Directory.EnumerateFiles(refDirectory, "*.dll"))
        Assert.True(resolver.TryResolveType("System.Threading.Tasks.TaskFactory`1", out var factoryDefinition))
        Assert.True(resolver.TryResolveType("System.String", out var stringType))
        let closedFactory = factoryDefinition.MakeGenericType(stringType)
        let continueWhenAll = closedFactory.GetMethods().Single(
            (method MethodInfo) -> method.Name == "ContinueWhenAll" && method.GetParameters() is [var tasks, _] &&
                tasks
                .ParameterType
                .IsArray &&
                tasks
                .ParameterType
                .GetElementType()
                ?.FullName == "System.Threading.Tasks.Task"
        )
        let receiver = ImportedTypeSymbol.GetConstructed(
            closedFactory,
            factoryDefinition,
            ImmutableArray.Create[TypeSymbol](TypeSymbol.String)
        )
        let tasks = MemberLookup.GetClrMethodParameterTypeSymbol(receiver, continueWhenAll, 0)
        Assert.Equal(ReferenceNullabilityKind.Platform, tasks.ReferenceNullability)
        Assert.Equal(ReferenceNullabilityKind.Platform, Assert.Single(tasks.GetElementPositions()).ReferenceNullability)
    }

    private class Surface[T] {
        init() {
            ConcreteArray = Array.Empty[KeyValuePair[string, object?]]()
            Nested = List[[]KeyValuePair[string, object?]]()
            GenericArray = Array.Empty[T]()
        }

        prop ConcreteArray[]KeyValuePair[string, object?] {
            get;
        }

        prop ConcreteTuple(string, object?) {
            get;
        }

        prop NullableTuple(string, object?)? {
            get;
        }

        prop Nested List[[]KeyValuePair[string, object?]] {
            get;
        }

        prop NullablePair KeyValuePair[string, object?]? {
            get;
        }

        prop GenericArray[]T {
            get;
        }

        prop GenericTuple(T, object?) {
            get;
        }

        func Add(value T, tags[]KeyValuePair[string, object?]) { }

        func Mutate(ref tags[]KeyValuePair[string, object?]) { }
    }

    shared {
        private func Receiver(
            closedType Type,
            argument TypeSymbol
        ) ImportedTypeSymbol -> ImportedTypeSymbol.GetConstructed(
            closedType,
            typeof(Surface[_]),
            ImmutableArray.Create(argument)
        )

        private func RequiredMethod(type Type, name string) MethodInfo -> type.GetMethod(name) ??
            throw XunitException("$type.$name not found")

        private func RequiredProperty(type Type, name string) PropertyInfo -> type.GetProperty(name) ??
            throw XunitException("$type.$name not found")

        private func AssertConcretePairArray(array TypeSymbol) {
            Assert.Equal(ReferenceNullabilityKind.NotNull, array.ReferenceNullability)
            let pair = Assert.Single(array.GetElementPositions())
            Assert.Equal(ReferenceNullabilityKind.NotApplicable, pair.ReferenceNullability)
            Assert.Equal(
                []ReferenceNullabilityKind{ReferenceNullabilityKind.NotNull, ReferenceNullabilityKind.Nullable},
                pair.GetElementPositions().Select((element TypeSymbol) -> element.ReferenceNullability)
            )
        }
    }
}
