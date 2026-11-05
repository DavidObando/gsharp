// <copyright file="ClrTypeUtilitiesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Text.RegularExpressions
import Xunit

/// Issue #338: the per-overload metadata-load tolerance introduced for #321 is
/// generalized to every CLR member enumeration site. These tests build a
/// (cref:System.Reflection.MetadataLoadContext) over a curated reference
/// set that deliberately omits `System.Text.RegularExpressions`. The
/// (cref:Fixture338) type below has one "good" and one "bad" member of
/// each kind (property, field, event, method, constructor); the bad members'
/// signatures reference (cref:Regex) / (cref:MatchEvaluator),
/// which live in the omitted assembly, so touching their signatures throws a
/// load failure under the MLC — exactly the situation the binder hits under
/// `/r:`. The `ClrTypeUtilities.SafeGet*` helpers must skip only the
/// offending member and keep every usable sibling.
open class ClrTypeUtilitiesTests {
    @Theory
    @InlineData(typeof(FileNotFoundException))
    @InlineData(typeof(FileLoadException))
    @InlineData(typeof(TypeLoadException))
    @InlineData(typeof(BadImageFormatException))
    @InlineData(typeof(MissingMethodException))
    @InlineData(typeof(MissingMemberException))
    @InlineData(typeof(NotSupportedException))
    func IsMetadataLoadFailure_ClassifiesLoadExceptions(exceptionType Type) {
        let ex Exception? = cast[Exception](Activator.CreateInstance(exceptionType))
        Assert.True(ClrTypeUtilities.IsMetadataLoadFailure(ex!!))
    }

    @Theory
    @InlineData(typeof(InvalidOperationException))
    @InlineData(typeof(ArgumentException))
    @InlineData(typeof(NullReferenceException))
    func IsMetadataLoadFailure_DoesNotSwallowUnrelatedExceptions(exceptionType Type) {
        let ex Exception? = cast[Exception](Activator.CreateInstance(exceptionType))
        Assert.False(ClrTypeUtilities.IsMetadataLoadFailure(ex!!))
    }

    @Fact
    func SafeGetProperties_SkipsUnloadableMember_KeepsUsableSiblings() {
        let fixture Type? = LoadFixtureUnderIncompleteContext()
        let names = ClrTypeUtilities
            .SafeGetProperties(fixture!!, InstanceFlags)
            .Select((p PropertyInfo) -> p.Name)
            .ToArray()
        Assert.Contains("GoodProperty", names)
        Assert.DoesNotContain("BadProperty", names)
        // Sanity check: the raw reflection call genuinely throws on the bad
        // member, proving the helper had something to tolerate.
        let rawBad = fixture!!.GetProperties(InstanceFlags).Single((p PropertyInfo) -> p.Name == "BadProperty")
        Assert.False(ClrTypeUtilities.CanLoadSignature(rawBad))
        Assert.Throws[FileNotFoundException](
            func () object? {
                return rawBad.PropertyType
            }
        )
    }

    @Fact
    func SafeGetFields_SkipsUnloadableMember_KeepsUsableSiblings() {
        let fixture Type? = LoadFixtureUnderIncompleteContext()
        let names = ClrTypeUtilities.SafeGetFields(fixture!!, InstanceFlags).Select((f FieldInfo) -> f.Name).ToArray()
        Assert.Contains("GoodField", names)
        Assert.DoesNotContain("BadField", names)
    }

    @Fact
    func SafeGetEvents_SkipsUnloadableMember_KeepsUsableSiblings() {
        let fixture Type? = LoadFixtureUnderIncompleteContext()
        let names = ClrTypeUtilities.SafeGetEvents(fixture!!, InstanceFlags).Select((e EventInfo) -> e.Name).ToArray()
        Assert.Contains("GoodEvent", names)
        Assert.DoesNotContain("BadEvent", names)
    }

    @Fact
    func SafeGetMethods_SkipsUnloadableMembers_KeepsUsableSiblings() {
        let fixture Type? = LoadFixtureUnderIncompleteContext()
        let names = ClrTypeUtilities.SafeGetMethods(fixture!!, InstanceFlags).Select((m MethodInfo) -> m.Name).ToArray()
        Assert.Contains("GoodMethod", names)
        Assert.DoesNotContain("BadParameterMethod", names)
        Assert.DoesNotContain("BadReturnMethod", names)
    }

    @Fact
    func SafeGetConstructors_SkipsUnloadableOverload_KeepsUsableSiblings() {
        let fixture Type? = LoadFixtureUnderIncompleteContext()
        let ctors = ClrTypeUtilities.SafeGetConstructors(fixture!!, InstanceFlags)
        Assert.Contains(ctors, (c ConstructorInfo) -> c.GetParameters().Length == 0)
        Assert.DoesNotContain(ctors, (c ConstructorInfo) -> c.GetParameters().Length == 1)
    }

    @Fact
    func SafeGetProperty_ByName_ReturnsUsableMember_NullForUnloadable() {
        let fixture Type? = LoadFixtureUnderIncompleteContext()
        Assert.NotNull(ClrTypeUtilities.SafeGetProperty(fixture!!, "GoodProperty", InstanceFlags))
        Assert.Null(ClrTypeUtilities.SafeGetProperty(fixture!!, "BadProperty", InstanceFlags))
    }

    @Fact
    func SafeGetField_ByName_ReturnsUsableMember_NullForUnloadable() {
        let fixture Type? = LoadFixtureUnderIncompleteContext()
        Assert.NotNull(ClrTypeUtilities.SafeGetField(fixture, "GoodField", InstanceFlags))
        Assert.Null(ClrTypeUtilities.SafeGetField(fixture, "BadField", InstanceFlags))
    }

    @Fact
    func SafeGetEvent_ByName_ReturnsUsableMember_NullForUnloadable() {
        let fixture Type? = LoadFixtureUnderIncompleteContext()
        Assert.NotNull(ClrTypeUtilities.SafeGetEvent(fixture!!, "GoodEvent", InstanceFlags))
        Assert.Null(ClrTypeUtilities.SafeGetEvent(fixture!!, "BadEvent", InstanceFlags))
    }

    @Fact
    func GetMethodSafe_TypeBuilderConstructedGeneric_ResolvesParameterType() {
        let assembly = AssemblyBuilder.DefineDynamicAssembly(
            AssemblyName("GetMethodSafeTypeBuilder"),
            AssemblyBuilderAccess.Run
        )
        let module = assembly.DefineDynamicModule("GetMethodSafeTypeBuilder")
        let argument = module.DefineType("Argument", TypeAttributes.Public)
        let constructed = typeof(TypeBuilderMethodFixture[_]).MakeGenericType(argument)
        Assert.Equal("TypeBuilderInstantiation", constructed.GetType().Name)
        Assert.Throws[NotSupportedException](
            func () object? {
                return constructed.GetMethod("Accept", []Type{argument})
            }
        )
        let method MethodInfo? = ClrTypeInspector.GetMethodSafe(constructed, "Accept", []Type{argument})
        Assert.NotNull(method)
        Assert.Equal("Accept", method!!.Name)
    }

    @Fact
    func GetMethodSafe_TypeBuilderConstructedGeneric_ResolvesNestedParameterTypes() {
        let assembly = AssemblyBuilder.DefineDynamicAssembly(
            AssemblyName("GetMethodSafeNestedTypeBuilder"),
            AssemblyBuilderAccess.Run
        )
        let module = assembly.DefineDynamicModule("GetMethodSafeNestedTypeBuilder")
        let argument = module.DefineType("Argument", TypeAttributes.Public)
        let constructed = typeof(TypeBuilderMethodFixture[_]).MakeGenericType(argument)
        let cases = [](string, Type){
            ("AcceptList", typeof(List[_]).MakeGenericType(argument)),
            ("AcceptArray", argument.MakeArrayType()),
            ("AcceptFunc", typeof(Func[_]).MakeGenericType(argument)),
            ("AcceptByRef", argument.MakeByRefType())
        }
        for (name, parameterType) in cases {
            Assert.Throws[NotSupportedException](
                func () object? {
                    return constructed.GetMethod(name, []Type{parameterType})
                }
            )
            Assert.NotNull(ClrTypeInspector.GetMethodSafe(constructed, name, []Type{parameterType}))
        }
    }

    @Fact
    func GetMethodSafe_TypeBuilderConstructedGeneric_ResolvesPointerParameterType() {
        let assembly = AssemblyBuilder.DefineDynamicAssembly(
            AssemblyName("GetMethodSafePointerTypeBuilder"),
            AssemblyBuilderAccess.Run
        )
        let module = assembly.DefineDynamicModule("GetMethodSafePointerTypeBuilder")
        let argument = module.DefineType("Argument", TypeAttributes.Public | TypeAttributes.Sealed, typeof(ValueType))
        let constructed = typeof(TypeBuilderPointerMethodFixture[_]).MakeGenericType(argument)
        let parameterType = argument.MakePointerType()
        Assert.Throws[NotSupportedException](
            func () object? {
                return constructed.GetMethod("AcceptPointer", []Type{parameterType})
            }
        )
        Assert.NotNull(ClrTypeInspector.GetMethodSafe(constructed, "AcceptPointer", []Type{parameterType}))
    }

    @Fact
    func GetMethodSafe_TypeBuilderConstructedGeneric_MapsDuplicateArgumentsByPosition() {
        let assembly = AssemblyBuilder.DefineDynamicAssembly(
            AssemblyName("GetMethodSafeDuplicateTypeBuilder"),
            AssemblyBuilderAccess.Run
        )
        let module = assembly.DefineDynamicModule("GetMethodSafeDuplicateTypeBuilder")
        let argument = module.DefineType("Argument", TypeAttributes.Public)
        let constructed = typeof(TypeBuilderPairMethodFixture[_, _]).MakeGenericType(argument, argument)
        Assert.Throws[NotSupportedException](
            func () object? {
                return constructed.GetMethod("Second", []Type{argument})
            }
        )
        Assert.Throws[NotSupportedException](
            func () object? {
                return constructed.GetMethod("Both", []Type{argument, argument})
            }
        )
        let first MethodInfo? = ClrTypeInspector.GetMethodSafe(constructed, "First", []Type{argument})
        let second MethodInfo? = ClrTypeInspector.GetMethodSafe(constructed, "Second", []Type{argument})
        let both MethodInfo? = ClrTypeInspector.GetMethodSafe(constructed, "Both", []Type{argument, argument})
        Assert.NotNull(first)
        Assert.NotNull(second)
        Assert.NotNull(both)
        Assert.Equal(0, first!!.GetParameters()[0].ParameterType.GenericParameterPosition)
        Assert.Equal(1, second!!.GetParameters()[0].ParameterType.GenericParameterPosition)
        Assert.Equal(
            []int32{0, 1},
            both!!
                .GetParameters()
                .Select((parameter ParameterInfo) -> parameter.ParameterType.GenericParameterPosition)
                .ToArray()
        )
        let ambiguous = typeof(TypeBuilderAmbiguousMethodFixture[_, _]).MakeGenericType(argument, argument)
        Assert.Throws[AmbiguousMatchException](
            func () object? {
                return ClrTypeInspector.GetMethodSafe(ambiguous, "Accept", []Type{argument})
            }
        )
    }

    @Fact
    func GetMethodSafe_TypeBuilderConstructedGeneric_ResolvesInheritedParameterType() {
        let assembly = AssemblyBuilder.DefineDynamicAssembly(
            AssemblyName("GetMethodSafeInheritedTypeBuilder"),
            AssemblyBuilderAccess.Run
        )
        let module = assembly.DefineDynamicModule("GetMethodSafeInheritedTypeBuilder")
        let argument = module.DefineType("Argument", TypeAttributes.Public)
        let constructed = typeof(TypeBuilderDerivedMethodFixture[_]).MakeGenericType(argument)
        Assert.Throws[NotSupportedException](
            func () object? {
                return constructed.GetMethod("Accept", []Type{argument})
            }
        )
        Assert.NotNull(ClrTypeInspector.GetMethodSafe(constructed, "Accept"))
        Assert.NotNull(ClrTypeInspector.GetMethodSafe(constructed, "Accept", []Type{argument}))
    }

    @Fact
    func IsSameAs_OpenGenericParameters_DistinguishesPositionsOwnersAndConstructedShapes() {
        let methodParams = typeof(OpenGenericIdentityFixture).GetMethod("Generic")!!.GetGenericArguments()
        let otherMethodParams = typeof(OpenGenericIdentityFixture).GetMethod("Other")!!.GetGenericArguments()
        let overloadedMethods = typeof(OpenGenericIdentityFixture)
            .GetMethods()
            .Where((m MethodInfo) -> m.Name == "Overloaded")
            .OrderBy((m MethodInfo) -> m.GetParameters()[0].ParameterType.Name, StringComparer.Ordinal)
            .ToArray()
        let overloadedIntParam = overloadedMethods[0].GetGenericArguments()[0]
        let overloadedStringParam = overloadedMethods[1].GetGenericArguments()[0]
        let typeParams = typeof(TypeBuilderPairMethodFixture[_, _]).GetGenericArguments()
        let singleTypeParam = typeof(TypeBuilderMethodFixture[_]).GetGenericArguments()[0]
        let otherSingleTypeParam = typeof(TypeBuilderBaseMethodFixture[_]).GetGenericArguments()[0]
        Assert.Equal(2, methodParams.Length)
        Assert.Null(methodParams[0].FullName)
        Assert.Null(methodParams[1].FullName)
        // Issue #5018 repro: distinct method generic parameters must not compare equal.
        Assert.False(ClrTypeInspector.IsSameAs(methodParams[0], methodParams[1]))
        Assert.False(ClrTypeInspector.IsSameAs(methodParams[1], methodParams[0]))
        Assert.True(ClrTypeInspector.IsSameAs(methodParams[0], methodParams[0]))
        Assert.True(ClrTypeInspector.IsSameAs(methodParams[1], methodParams[1]))
        // Distinct type generic parameters on the same generic type definition.
        Assert.False(ClrTypeInspector.IsSameAs(typeParams[0], typeParams[1]))
        Assert.True(ClrTypeInspector.IsSameAs(typeParams[0], typeParams[0]))
        // Method vs type generic parameter at position 0 with the same name ("T").
        Assert.False(ClrTypeInspector.IsSameAs(methodParams[0], singleTypeParam))
        Assert.False(ClrTypeInspector.IsSameAs(singleTypeParam, methodParams[0]))
        // Type generic parameters at position 0 from different types.
        Assert.False(ClrTypeInspector.IsSameAs(singleTypeParam, otherSingleTypeParam))
        // Method generic parameters at position 0 from different methods or overloads.
        Assert.False(ClrTypeInspector.IsSameAs(methodParams[0], otherMethodParams[0]))
        Assert.False(ClrTypeInspector.IsSameAs(overloadedIntParam, overloadedStringParam))
        // Constructed open generic, array, by-ref, and pointer shapes over T vs U.
        let listT = typeof(List[_]).MakeGenericType(methodParams[0])
        let listU = typeof(List[_]).MakeGenericType(methodParams[1])
        let arrayT = methodParams[0].MakeArrayType()
        let arrayU = methodParams[1].MakeArrayType()
        let byRefT = methodParams[0].MakeByRefType()
        let byRefU = methodParams[1].MakeByRefType()
        let pointerT = methodParams[0].MakePointerType()
        let pointerU = methodParams[1].MakePointerType()
        Assert.Null(listT.FullName)
        Assert.Null(arrayT.FullName)
        Assert.False(ClrTypeInspector.IsSameAs(listT, listU))
        Assert.True(ClrTypeInspector.IsSameAs(listT, typeof(List[_]).MakeGenericType(methodParams[0])))
        Assert.False(ClrTypeInspector.IsSameAs(arrayT, arrayU))
        Assert.True(ClrTypeInspector.IsSameAs(arrayT, methodParams[0].MakeArrayType()))
        Assert.False(ClrTypeInspector.IsSameAs(byRefT, byRefU))
        Assert.True(ClrTypeInspector.IsSameAs(byRefT, methodParams[0].MakeByRefType()))
        Assert.False(ClrTypeInspector.IsSameAs(pointerT, pointerU))
        Assert.True(ClrTypeInspector.IsSameAs(pointerT, methodParams[0].MakePointerType()))
        Assert.False(ClrTypeInspector.IsSameAs(arrayT, methodParams[0]))
        Assert.False(ClrTypeInspector.IsSameAs(arrayT, byRefT))
        Assert.False(ClrTypeInspector.IsSameAs(listT, methodParams[0]))
    }

    @Fact
    func IsSameAs_OpenGenericParameters_MatchesSameParameterAcrossMetadataLoadContext() {
        let paths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
            .Split(Path.PathSeparator)
            .Where((p string) -> !string.IsNullOrEmpty(p))
            .Append(typeof(ClrTypeUtilitiesTests).Assembly.Location)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray()
        using let mlc = MetadataLoadContext(PathAssemblyResolver(paths), coreAssemblyName: "System.Private.CoreLib")
        let mlcAssembly = mlc.LoadFromAssemblyPath(typeof(ClrTypeUtilitiesTests).Assembly.Location)
        let mlcCoreAssembly = mlc.CoreAssembly!!
        let mlcFixture = mlcAssembly.GetType(typeof(OpenGenericIdentityFixture).FullName!!, throwOnError: true)!!
        let mlcPairFixture = mlcAssembly.GetType(
            typeof(TypeBuilderPairMethodFixture[_, _]).FullName!!,
            throwOnError: true
        )!!
        let mlcListDef = mlcCoreAssembly.GetType("System.Collections.Generic.List`1", throwOnError: true)!!
        let hostMethodParams = typeof(OpenGenericIdentityFixture).GetMethod("Generic")!!.GetGenericArguments()
        let mlcMethodParams = mlcFixture.GetMethod("Generic")!!.GetGenericArguments()
        let mlcOtherParams = mlcFixture.GetMethod("Other")!!.GetGenericArguments()
        let hostOverloads = typeof(OpenGenericIdentityFixture)
            .GetMethods()
            .Where((m MethodInfo) -> m.Name == "Overloaded")
            .OrderBy((m MethodInfo) -> m.GetParameters()[0].ParameterType.Name, StringComparer.Ordinal)
            .ToArray()
        let mlcOverloads = mlcFixture
            .GetMethods()
            .Where((m MethodInfo) -> m.Name == "Overloaded")
            .OrderBy((m MethodInfo) -> m.GetParameters()[0].ParameterType.Name, StringComparer.Ordinal)
            .ToArray()
        let hostTypeParams = typeof(TypeBuilderPairMethodFixture[_, _]).GetGenericArguments()
        let mlcTypeParams = mlcPairFixture.GetGenericArguments()
        Assert.False(object.ReferenceEquals(hostMethodParams[0], mlcMethodParams[0]))
        Assert.True(ClrTypeInspector.IsSameAs(hostMethodParams[0], mlcMethodParams[0]))
        Assert.True(ClrTypeInspector.IsSameAs(hostMethodParams[1], mlcMethodParams[1]))
        Assert.False(ClrTypeInspector.IsSameAs(hostMethodParams[0], mlcMethodParams[1]))
        Assert.False(ClrTypeInspector.IsSameAs(hostMethodParams[0], mlcOtherParams[0]))
        Assert.True(ClrTypeInspector.IsSameAs(hostTypeParams[0], mlcTypeParams[0]))
        Assert.True(ClrTypeInspector.IsSameAs(hostTypeParams[1], mlcTypeParams[1]))
        Assert.False(ClrTypeInspector.IsSameAs(hostTypeParams[0], mlcTypeParams[1]))
        Assert.False(ClrTypeInspector.IsSameAs(hostTypeParams[0], mlcMethodParams[0]))
        Assert.True(
            ClrTypeInspector.IsSameAs(
                hostOverloads[0].GetGenericArguments()[0],
                mlcOverloads[0].GetGenericArguments()[0]
            )
        )
        Assert.False(
            ClrTypeInspector.IsSameAs(
                hostOverloads[0].GetGenericArguments()[0],
                mlcOverloads[1].GetGenericArguments()[0]
            )
        )
        Assert.True(
            ClrTypeInspector.IsSameAs(
                typeof(List[_]).MakeGenericType(hostMethodParams[0]),
                mlcListDef.MakeGenericType(mlcMethodParams[0])
            )
        )
        Assert.False(
            ClrTypeInspector.IsSameAs(
                typeof(List[_]).MakeGenericType(hostMethodParams[0]),
                mlcListDef.MakeGenericType(mlcMethodParams[1])
            )
        )
        Assert.True(ClrTypeInspector.IsSameAs(hostMethodParams[0].MakeArrayType(), mlcMethodParams[0].MakeArrayType()))
        Assert.False(ClrTypeInspector.IsSameAs(hostMethodParams[0].MakeArrayType(), mlcMethodParams[1].MakeArrayType()))
        Assert.True(ClrTypeInspector.IsSameAs(hostMethodParams[0].MakeByRefType(), mlcMethodParams[0].MakeByRefType()))
        Assert.False(ClrTypeInspector.IsSameAs(hostMethodParams[0].MakeByRefType(), mlcMethodParams[1].MakeByRefType()))
        // Function-pointer types have FullName == nil and IsPointer == false; verify structural identity across contexts.
        let hostIntToIntPtr = typeof(OpenGenericIdentityFixture).GetMethod("AcceptFnPtrInt")!!
            .GetParameters()[0]
            .ParameterType
        let hostManagedIntToIntPtr = typeof(OpenGenericIdentityFixture).GetMethod("AcceptManagedFnPtrInt")!!
            .GetParameters()[0]
            .ParameterType
        let hostIntToLongPtr = typeof(OpenGenericIdentityFixture).GetMethod("AcceptFnPtrLong")!!
            .GetParameters()[0]
            .ParameterType
        let mlcIntToIntPtr = mlcFixture.GetMethod("AcceptFnPtrInt")!!.GetParameters()[0].ParameterType
        let mlcManagedIntToIntPtr = mlcFixture.GetMethod("AcceptManagedFnPtrInt")!!.GetParameters()[0].ParameterType
        let mlcIntToLongPtr = mlcFixture.GetMethod("AcceptFnPtrLong")!!.GetParameters()[0].ParameterType
        Assert.True(hostIntToIntPtr.IsFunctionPointer)
        Assert.Null(hostIntToIntPtr.FullName)
        Assert.True(ClrTypeInspector.IsSameAs(hostIntToIntPtr, mlcIntToIntPtr))
        Assert.True(ClrTypeInspector.IsSameAs(hostManagedIntToIntPtr, mlcManagedIntToIntPtr))
        Assert.False(ClrTypeInspector.IsSameAs(hostIntToIntPtr, hostManagedIntToIntPtr))
        Assert.False(ClrTypeInspector.IsSameAs(hostIntToIntPtr, mlcManagedIntToIntPtr))
        Assert.False(ClrTypeInspector.IsSameAs(hostIntToIntPtr, hostIntToLongPtr))
        Assert.False(ClrTypeInspector.IsSameAs(hostIntToIntPtr, mlcIntToLongPtr))
        Assert.False(ClrTypeInspector.IsSameAs(hostIntToIntPtr, hostMethodParams[0]))
        // ModuleVersionId + MetadataToken match across runtime and incomplete MetadataLoadContext without loading missing parameter types.
        let incompleteFixture = LoadFixtureUnderIncompleteContext()!!
        let hostBadGenericParam = typeof(Fixture338).GetMethod("BadGenericMethod")!!.GetGenericArguments()[0]
        let mlcBadGenericParam = incompleteFixture.GetMethod("BadGenericMethod")!!.GetGenericArguments()[0]
        let mlcOtherBadGenericParam = incompleteFixture.GetMethod("OtherBadGenericMethod")!!.GetGenericArguments()[0]
        Assert.True(ClrTypeInspector.IsSameAs(hostBadGenericParam, mlcBadGenericParam))
        Assert.False(ClrTypeInspector.IsSameAs(hostBadGenericParam, mlcOtherBadGenericParam))
        // SafeGetMethodsIncludingInterfaces hides a base generic interface method when a derived interface redeclares it with a renamed method type parameter.
        let derivedInterfaceMethods = ClrTypeUtilities
            .SafeGetMethodsIncludingInterfaces(typeof(IDerivedGenericMethodFixture), InstanceFlags)
            .Where((m MethodInfo) -> m.Name == "Echo")
            .ToArray()
        let singleEcho = Assert.Single(derivedInterfaceMethods)
        Assert.Equal(typeof(IDerivedGenericMethodFixture), singleEcho.DeclaringType)
    }

    shared {
        private const InstanceFlags BindingFlags = BindingFlags.Public | BindingFlags.Instance

        /// Loads (cref:Fixture338) through a MetadataLoadContext whose
        /// reference set intentionally omits `System.Text.RegularExpressions`,
        /// so any signature referencing (cref:Regex) / (cref:MatchEvaluator)
        /// throws a (cref:FileNotFoundException) when touched.
        private func LoadFixtureUnderIncompleteContext() Type? {
            let trusted = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
                .Split(Path.PathSeparator)
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .ToList()
            // Drop the assembly that defines Regex / MatchEvaluator so the bad
            // members become unresolvable, mirroring a transitive assembly that was
            // not supplied via /r:.
            let paths = trusted
                .Where(
                (p string) -> !string.Equals(
                    Path.GetFileNameWithoutExtension(p),
                    "System.Text.RegularExpressions",
                    StringComparison.OrdinalIgnoreCase
                )
            )
                .Append(typeof(ClrTypeUtilitiesTests).Assembly.Location)
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            let resolver = PathAssemblyResolver(paths)
            let mlc = MetadataLoadContext(resolver, coreAssemblyName: "System.Private.CoreLib")
            let assembly = mlc.LoadFromAssemblyPath(typeof(ClrTypeUtilitiesTests).Assembly.Location)
            let fixture Type? = assembly.GetType(typeof(Fixture338).FullName!!, throwOnError: true)
            // Guard: the regex assembly really is absent from this context.
            Assert.DoesNotContain(
                mlc.GetAssemblies(),
                (a Assembly) -> string.Equals(
                    a.GetName().Name,
                    "System.Text.RegularExpressions",
                    StringComparison.OrdinalIgnoreCase
                )
            )
            return fixture
        }
    }
}

/// Issue #338 reflection fixture. Each member kind has a "good" sibling whose
/// signature only touches core types and a "bad" sibling whose signature
/// references (cref:Regex) / (cref:MatchEvaluator) from the
/// deliberately-omitted `System.Text.RegularExpressions` assembly.
internal class Fixture338 {
    init() { }

    init(pattern Regex) { }

    event GoodEvent EventHandler
    event BadEvent MatchEvaluator
    var GoodField int32
    var BadField Regex
    prop GoodProperty int32
    prop BadProperty Regex

    func GoodMethod() int32 -> 0

    func BadParameterMethod(pattern Regex) { }

    func BadReturnMethod() Regex? -> nil

    func BadGenericMethod[T](pattern Regex) {
        let _ = pattern
    }

    func OtherBadGenericMethod[T](pattern Regex) {
        let _ = pattern
    }
}

internal class TypeBuilderMethodFixture[T] {
    func Accept(value T) { }

    func Accept(value int32) { }

    func AcceptList(value List[T]) { }

    func AcceptArray(value[]T) { }

    func AcceptFunc(value() -> T) { }

    func AcceptByRef(ref value T) {
        let _ = value
    }
}

internal class TypeBuilderPairMethodFixture[TFirst, TSecond] {
    func First(value TFirst) { }

    func Second(value TSecond) { }

    func Both(first TFirst, second TSecond) { }
}

internal unsafe class TypeBuilderPointerMethodFixture[T unmanaged] {
    func AcceptPointer(value *T) { }
}

internal class TypeBuilderAmbiguousMethodFixture[TFirst, TSecond] {
    func Accept(value TFirst) { }

    func Accept(value TSecond) { }
}

internal open class TypeBuilderBaseMethodFixture[T] {
    func Accept(value T) { }
}

internal class TypeBuilderDerivedMethodFixture[T] : TypeBuilderBaseMethodFixture[T] { }

internal unsafe class OpenGenericIdentityFixture {
    shared {
        func Generic[T, U]() { }

        func Other[T, U]() { }

        func Overloaded[T](first int32, second T) {
            let _ = first
            let _ = second
        }

        func Overloaded[T](first string, second T) {
            let _ = first
            let _ = second
        }

        func AcceptFnPtrInt(callback unmanaged[Cdecl](int32) -> int32) {
            let _ = callback
        }

        func AcceptManagedFnPtrInt(callback *func (int32) int32) {
            let _ = callback
        }

        func AcceptFnPtrLong(callback unmanaged[Cdecl](int32) -> int64) {
            let _ = callback
        }
    }
}

internal interface IBaseGenericMethodFixture {
    func Echo[T](value T) T;
}

internal interface IDerivedGenericMethodFixture : IBaseGenericMethodFixture {
    func Echo[U](value U) U;
}
