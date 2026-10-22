// <copyright file="Issue5123ReflectionProbeExceptionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Runtime.ExceptionServices
import Xunit

/// Issue #5123: reflection probes used a thrown and caught exception as their
/// "not applicable" answer, about 4,700 per Core compile. Each probe now tests the
/// condition it is asking about (a `TypeBuilderInstantiation`, a
/// `MetadataLoadContext` method, a runtime type handed to `TypeBuilder.GetMethod`)
/// before calling, so the common case raises no first-chance exception.
///
/// Every test counts first-chance exceptions on the calling thread across the probe
/// and asserts none were raised, and also asserts the answer the probe gave before
/// the change. The types under test are created per test so no memoized result can
/// hide a thrown exception.
///
/// RED before the change: the probe throws and catches, so the count is not zero.
open class Issue5123ReflectionProbeExceptionTests {
    @Fact
    func IsEnumSafe_TypeBuilderInstantiation_ReturnsFalseWithoutThrowing() {
        let instantiation = BuildTypeBuilderInstantiation()
        var answer = true
        let thrown = CountFirstChanceExceptions(
            func () {
                answer = instantiation.IsEnumSafe()
            }
        )
        Assert.False(answer)
        Assert.Empty(thrown)
    }

    @Fact
    func IsByRefLike_TypeBuilderInstantiation_ReturnsFalseWithoutThrowing() {
        let instantiation = BuildTypeBuilderInstantiation()
        var answer = true
        let thrown = CountFirstChanceExceptions(
            func () {
                answer = ClrTypeUtilities.IsByRefLike(instantiation)
            }
        )
        Assert.False(answer)
        Assert.Empty(thrown)
    }

    @Fact
    func GetMethodSafe_TypeBuilderInstantiation_ReturnsNullWithoutThrowing() {
        let instantiation = BuildTypeBuilderInstantiation()
        var byName MethodInfo? = nil
        var bySignature MethodInfo? = nil
        let thrown = CountFirstChanceExceptions(
            func () {
                byName = instantiation.GetMethodSafe("Accept")
                bySignature = instantiation.GetMethodSafe("Accept", []Type{typeof(int32)})
            }
        )
        Assert.Null(byName)
        Assert.Null(bySignature)
        Assert.Empty(thrown)
    }

    @Fact
    func IsAssignableByName_TypeBuilderInstantiationTarget_FallsBackToNameWalkWithoutThrowing() {
        let instantiation = BuildTypeBuilderInstantiation()
        let sibling = DefineSiblingInSameAssembly(instantiation)
        var answer = true
        let thrown = CountFirstChanceExceptions(
            func () {
                answer = ClrTypeUtilities.IsAssignableByName(instantiation, sibling)
            }
        )
        Assert.False(answer)
        Assert.Empty(thrown)
    }

    @Fact
    func SafeGetInterfaces_TypeBuilderInstantiation_ReturnsEmptyWithoutThrowing() {
        let instantiation = BuildTypeBuilderInstantiation()
        var interfaces[]Type = []Type{typeof(object)}
        let thrown = CountFirstChanceExceptions(
            func () {
                interfaces = ClrTypeUtilities.SafeGetInterfaces(instantiation)
            }
        )
        Assert.Empty(interfaces)
        Assert.Empty(thrown)
    }

    @Fact
    func MakeGenericTypeIsRejectedAcrossContexts_HostArgumentOverMetadataLoadContextDefinition() {
        let trusted = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
            .Split(Path.PathSeparator)
            .Where((p string) -> !string.IsNullOrEmpty(p))
            .ToArray()
        let mlc = MetadataLoadContext(PathAssemblyResolver(trusted), coreAssemblyName: "System.Private.CoreLib")
        try {
            let core = mlc.CoreAssembly!!
            let contextList = core.GetType("System.Collections.Generic.List`1", true)!!
            let contextInt = core.GetType("System.Int32", true)!!
            // The host int32 cannot close a definition loaded by the context: the call throws.
            Assert.True(ClrTypeUtilities.MakeGenericTypeIsRejectedAcrossContexts(contextList, []Type{typeof(int32)}))
            Assert.Throws[ArgumentException](
                func () {
                    contextList.MakeGenericType(typeof(int32))
                }
            )
            // The context's own int32 closes it, and so does a host definition over host arguments.
            Assert.False(ClrTypeUtilities.MakeGenericTypeIsRejectedAcrossContexts(contextList, []Type{contextInt}))
            Assert.NotNull(contextList.MakeGenericType(contextInt))
            Assert.False(
                ClrTypeUtilities.MakeGenericTypeIsRejectedAcrossContexts(
                    typeof(List[int32]).GetGenericTypeDefinition(),
                    []Type{typeof(int32)}
                )
            )
        } finally {
            mlc.Dispose()
        }
    }

    @Fact
    func SafeIsOverride_MetadataLoadContextMethods_ReadTheMetadataBitsWithoutThrowing() {
        let trusted = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
            .Split(Path.PathSeparator)
            .Where((p string) -> !string.IsNullOrEmpty(p))
            .ToArray()
        let mlc = MetadataLoadContext(PathAssemblyResolver(trusted), coreAssemblyName: "System.Private.CoreLib")
        try {
            let core = mlc.CoreAssembly!!
            // `Object.ToString` introduces its virtual slot; `Int32.ToString` overrides it.
            let introduced = core.GetType("System.Object", true)!!.GetMethod("ToString", Type.EmptyTypes)
            let overridden = core.GetType("System.Int32", true)!!.GetMethod("ToString", Type.EmptyTypes)
            Assert.NotNull(introduced)
            Assert.NotNull(overridden)
            var introducedAnswer = true
            var overriddenAnswer = false
            let thrown = CountFirstChanceExceptions(
                func () {
                    introducedAnswer = ClrTypeUtilities.SafeIsOverride(introduced)
                    overriddenAnswer = ClrTypeUtilities.SafeIsOverride(overridden)
                }
            )
            Assert.False(introducedAnswer)
            Assert.True(overriddenAnswer)
            Assert.Empty(thrown)
        } finally {
            mlc.Dispose()
        }
    }

    @Fact
    func SafeGetMethodsIncludingSelfAndInterfaces_RuntimeConstructedType_DoesNotAskTypeBuilderToMapMethods() {
        // A constructed type over a type nothing else in the process closes List<T> over, so
        // the memoized candidate lookup has not seen it.
        let receiver = typeof(List[Issue5123Marker])
        var methods IReadOnlyList[MethodInfo]? = nil
        let thrown = CountFirstChanceExceptions(
            func () {
                methods = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(receiver, "Add")
            }
        )
        Assert.Empty(thrown)
        let found = methods!!
        Assert.Contains(found, (m MethodInfo) -> m.Name == "Add" && m.DeclaringType == receiver)
    }

    shared {
        /// Runs [`probe`](paramref) and returns the type name of every first-chance
        /// exception raised on the calling thread while it ran.
        private func CountFirstChanceExceptions(probe Action) List[string] {
            let thrown = List[string]()
            let thread = Environment.CurrentManagedThreadId
            let handler = func (sender object?, args FirstChanceExceptionEventArgs) {
                if Environment.CurrentManagedThreadId == thread {
                    thrown.Add(args.Exception.GetType().Name)
                }
            }
            AppDomain.CurrentDomain.FirstChanceException += handler
            try {
                probe()
            } finally {
                AppDomain.CurrentDomain.FirstChanceException -= handler
            }
            return thrown
        }

        /// Builds a fresh `Bus<int>` instantiation of a generic type still being defined.
        private func BuildTypeBuilderInstantiation() Type {
            let assemblyBuilder = AssemblyBuilder.DefineDynamicAssembly(
                AssemblyName("Issue5123DynamicAssembly" + Guid.NewGuid().ToString("N")),
                AssemblyBuilderAccess.Run
            )
            let moduleBuilder = assemblyBuilder.DefineDynamicModule("Issue5123Module")
            let definition = moduleBuilder.DefineType("Bus`1", TypeAttributes.Public | TypeAttributes.Class)
            definition.DefineGenericParameters("T")
            let instantiation = definition.MakeGenericType(typeof(int32))
            Assert.Equal("TypeBuilderInstantiation", instantiation.GetType().Name)
            return instantiation
        }

        /// Defines a second type in the same dynamic module as [`instantiation`](paramref), so
        /// the same-assembly fast path of `IsAssignableByName` is taken.
        private func DefineSiblingInSameAssembly(instantiation Type) Type {
            let module = instantiation.GetGenericTypeDefinition().Module as ModuleBuilder
            return module!!.DefineType("Consumer", TypeAttributes.Public | TypeAttributes.Class)
        }
    }
}

/// Type argument that only this test closes `List<T>` over.
internal class Issue5123Marker { }
