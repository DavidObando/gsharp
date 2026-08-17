// <copyright file="ClrTypeUtilitiesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Text.RegularExpressions;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #338: the per-overload metadata-load tolerance introduced for #321 is
/// generalized to every CLR member enumeration site. These tests build a
/// <see cref="System.Reflection.MetadataLoadContext"/> over a curated reference
/// set that deliberately omits <c>System.Text.RegularExpressions</c>. The
/// <see cref="Fixture338"/> type below has one "good" and one "bad" member of
/// each kind (property, field, event, method, constructor); the bad members'
/// signatures reference <see cref="Regex"/> / <see cref="MatchEvaluator"/>,
/// which live in the omitted assembly, so touching their signatures throws a
/// load failure under the MLC — exactly the situation the binder hits under
/// <c>/r:</c>. The <c>ClrTypeUtilities.SafeGet*</c> helpers must skip only the
/// offending member and keep every usable sibling.
/// </summary>
public class ClrTypeUtilitiesTests
{
    private const BindingFlags InstanceFlags = BindingFlags.Public | BindingFlags.Instance;

    [Theory]
    [InlineData(typeof(FileNotFoundException))]
    [InlineData(typeof(FileLoadException))]
    [InlineData(typeof(TypeLoadException))]
    [InlineData(typeof(BadImageFormatException))]
    [InlineData(typeof(MissingMethodException))]
    [InlineData(typeof(MissingMemberException))]
    [InlineData(typeof(NotSupportedException))]
    public void IsMetadataLoadFailure_ClassifiesLoadExceptions(Type exceptionType)
    {
        var ex = (Exception)Activator.CreateInstance(exceptionType);
        Assert.True(ClrTypeUtilities.IsMetadataLoadFailure(ex));
    }

    [Theory]
    [InlineData(typeof(InvalidOperationException))]
    [InlineData(typeof(ArgumentException))]
    [InlineData(typeof(NullReferenceException))]
    public void IsMetadataLoadFailure_DoesNotSwallowUnrelatedExceptions(Type exceptionType)
    {
        var ex = (Exception)Activator.CreateInstance(exceptionType);
        Assert.False(ClrTypeUtilities.IsMetadataLoadFailure(ex));
    }

    [Fact]
    public void SafeGetProperties_SkipsUnloadableMember_KeepsUsableSiblings()
    {
        var fixture = LoadFixtureUnderIncompleteContext();

        var names = ClrTypeUtilities.SafeGetProperties(fixture, InstanceFlags)
            .Select(p => p.Name)
            .ToArray();

        Assert.Contains(nameof(Fixture338.GoodProperty), names);
        Assert.DoesNotContain(nameof(Fixture338.BadProperty), names);

        // Sanity check: the raw reflection call genuinely throws on the bad
        // member, proving the helper had something to tolerate.
        var rawBad = fixture.GetProperties(InstanceFlags).Single(p => p.Name == nameof(Fixture338.BadProperty));
        Assert.False(ClrTypeUtilities.CanLoadSignature(rawBad));
        Assert.Throws<FileNotFoundException>(() => _ = rawBad.PropertyType);
    }

    [Fact]
    public void SafeGetFields_SkipsUnloadableMember_KeepsUsableSiblings()
    {
        var fixture = LoadFixtureUnderIncompleteContext();

        var names = ClrTypeUtilities.SafeGetFields(fixture, InstanceFlags)
            .Select(f => f.Name)
            .ToArray();

        Assert.Contains(nameof(Fixture338.GoodField), names);
        Assert.DoesNotContain(nameof(Fixture338.BadField), names);
    }

    [Fact]
    public void SafeGetEvents_SkipsUnloadableMember_KeepsUsableSiblings()
    {
        var fixture = LoadFixtureUnderIncompleteContext();

        var names = ClrTypeUtilities.SafeGetEvents(fixture, InstanceFlags)
            .Select(e => e.Name)
            .ToArray();

        Assert.Contains(nameof(Fixture338.GoodEvent), names);
        Assert.DoesNotContain(nameof(Fixture338.BadEvent), names);
    }

    [Fact]
    public void SafeGetMethods_SkipsUnloadableMembers_KeepsUsableSiblings()
    {
        var fixture = LoadFixtureUnderIncompleteContext();

        var names = ClrTypeUtilities.SafeGetMethods(fixture, InstanceFlags)
            .Select(m => m.Name)
            .ToArray();

        Assert.Contains(nameof(Fixture338.GoodMethod), names);
        Assert.DoesNotContain(nameof(Fixture338.BadParameterMethod), names);
        Assert.DoesNotContain(nameof(Fixture338.BadReturnMethod), names);
    }

    [Fact]
    public void SafeGetConstructors_SkipsUnloadableOverload_KeepsUsableSiblings()
    {
        var fixture = LoadFixtureUnderIncompleteContext();

        var ctors = ClrTypeUtilities.SafeGetConstructors(fixture, InstanceFlags);

        Assert.Contains(ctors, c => c.GetParameters().Length == 0);
        Assert.DoesNotContain(ctors, c => c.GetParameters().Length == 1);
    }

    [Fact]
    public void SafeGetProperty_ByName_ReturnsUsableMember_NullForUnloadable()
    {
        var fixture = LoadFixtureUnderIncompleteContext();

        Assert.NotNull(ClrTypeUtilities.SafeGetProperty(fixture, nameof(Fixture338.GoodProperty), InstanceFlags));
        Assert.Null(ClrTypeUtilities.SafeGetProperty(fixture, nameof(Fixture338.BadProperty), InstanceFlags));
    }

    [Fact]
    public void SafeGetField_ByName_ReturnsUsableMember_NullForUnloadable()
    {
        var fixture = LoadFixtureUnderIncompleteContext();

        Assert.NotNull(ClrTypeUtilities.SafeGetField(fixture, nameof(Fixture338.GoodField), InstanceFlags));
        Assert.Null(ClrTypeUtilities.SafeGetField(fixture, nameof(Fixture338.BadField), InstanceFlags));
    }

    [Fact]
    public void SafeGetEvent_ByName_ReturnsUsableMember_NullForUnloadable()
    {
        var fixture = LoadFixtureUnderIncompleteContext();

        Assert.NotNull(ClrTypeUtilities.SafeGetEvent(fixture, nameof(Fixture338.GoodEvent), InstanceFlags));
        Assert.Null(ClrTypeUtilities.SafeGetEvent(fixture, nameof(Fixture338.BadEvent), InstanceFlags));
    }

    [Fact]
    public void GetMethodSafe_TypeBuilderConstructedGeneric_ResolvesParameterType()
    {
        var assembly = AssemblyBuilder.DefineDynamicAssembly(
            new AssemblyName("GetMethodSafeTypeBuilder"),
            AssemblyBuilderAccess.Run);
        var module = assembly.DefineDynamicModule("GetMethodSafeTypeBuilder");
        var argument = module.DefineType("Argument", TypeAttributes.Public);
        var constructed = typeof(TypeBuilderMethodFixture<>).MakeGenericType(argument);

        Assert.Equal("TypeBuilderInstantiation", constructed.GetType().Name);
        Assert.Throws<NotSupportedException>(() => constructed.GetMethod(
            nameof(TypeBuilderMethodFixture<object>.Accept),
            [argument]));

        var method = ClrTypeInspector.GetMethodSafe(
            constructed,
            nameof(TypeBuilderMethodFixture<object>.Accept),
            [argument]);

        Assert.NotNull(method);
        Assert.Equal(nameof(TypeBuilderMethodFixture<object>.Accept), method.Name);
    }

    [Fact]
    public void GetMethodSafe_TypeBuilderConstructedGeneric_ResolvesNestedParameterTypes()
    {
        var assembly = AssemblyBuilder.DefineDynamicAssembly(
            new AssemblyName("GetMethodSafeNestedTypeBuilder"),
            AssemblyBuilderAccess.Run);
        var module = assembly.DefineDynamicModule("GetMethodSafeNestedTypeBuilder");
        var argument = module.DefineType("Argument", TypeAttributes.Public);
        var constructed = typeof(TypeBuilderMethodFixture<>).MakeGenericType(argument);
        var cases = new[]
        {
            (nameof(TypeBuilderMethodFixture<object>.AcceptList), typeof(List<>).MakeGenericType(argument)),
            (nameof(TypeBuilderMethodFixture<object>.AcceptArray), argument.MakeArrayType()),
            (nameof(TypeBuilderMethodFixture<object>.AcceptFunc), typeof(Func<>).MakeGenericType(argument)),
            (nameof(TypeBuilderMethodFixture<object>.AcceptByRef), argument.MakeByRefType()),
        };

        foreach (var (name, parameterType) in cases)
        {
            Assert.Throws<NotSupportedException>(() => constructed.GetMethod(name, [parameterType]));
            Assert.NotNull(ClrTypeInspector.GetMethodSafe(constructed, name, [parameterType]));
        }
    }

    [Fact]
    public void GetMethodSafe_TypeBuilderConstructedGeneric_ResolvesPointerParameterType()
    {
        var assembly = AssemblyBuilder.DefineDynamicAssembly(
            new AssemblyName("GetMethodSafePointerTypeBuilder"),
            AssemblyBuilderAccess.Run);
        var module = assembly.DefineDynamicModule("GetMethodSafePointerTypeBuilder");
        var argument = module.DefineType(
            "Argument",
            TypeAttributes.Public | TypeAttributes.Sealed,
            typeof(ValueType));
        var constructed = typeof(TypeBuilderPointerMethodFixture<>).MakeGenericType(argument);
        var parameterType = argument.MakePointerType();

        Assert.Throws<NotSupportedException>(() => constructed.GetMethod(
            nameof(TypeBuilderPointerMethodFixture<int>.AcceptPointer),
            [parameterType]));
        Assert.NotNull(ClrTypeInspector.GetMethodSafe(
            constructed,
            nameof(TypeBuilderPointerMethodFixture<int>.AcceptPointer),
            [parameterType]));
    }

    [Fact]
    public void GetMethodSafe_TypeBuilderConstructedGeneric_MapsDuplicateArgumentsByPosition()
    {
        var assembly = AssemblyBuilder.DefineDynamicAssembly(
            new AssemblyName("GetMethodSafeDuplicateTypeBuilder"),
            AssemblyBuilderAccess.Run);
        var module = assembly.DefineDynamicModule("GetMethodSafeDuplicateTypeBuilder");
        var argument = module.DefineType("Argument", TypeAttributes.Public);
        var constructed = typeof(TypeBuilderPairMethodFixture<,>).MakeGenericType(argument, argument);

        Assert.Throws<NotSupportedException>(() => constructed.GetMethod(
            nameof(TypeBuilderPairMethodFixture<object, object>.Second),
            [argument]));
        Assert.Throws<NotSupportedException>(() => constructed.GetMethod(
            nameof(TypeBuilderPairMethodFixture<object, object>.Both),
            [argument, argument]));

        var first = ClrTypeInspector.GetMethodSafe(
            constructed,
            nameof(TypeBuilderPairMethodFixture<object, object>.First),
            [argument]);
        var second = ClrTypeInspector.GetMethodSafe(
            constructed,
            nameof(TypeBuilderPairMethodFixture<object, object>.Second),
            [argument]);
        var both = ClrTypeInspector.GetMethodSafe(
            constructed,
            nameof(TypeBuilderPairMethodFixture<object, object>.Both),
            [argument, argument]);

        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.NotNull(both);
        Assert.Equal(0, first.GetParameters()[0].ParameterType.GenericParameterPosition);
        Assert.Equal(1, second.GetParameters()[0].ParameterType.GenericParameterPosition);
        Assert.Equal(
            [0, 1],
            both.GetParameters()
                .Select(parameter => parameter.ParameterType.GenericParameterPosition)
                .ToArray());

        var ambiguous = typeof(TypeBuilderAmbiguousMethodFixture<,>)
            .MakeGenericType(argument, argument);
        Assert.Throws<AmbiguousMatchException>(() => ClrTypeInspector.GetMethodSafe(
            ambiguous,
            nameof(TypeBuilderAmbiguousMethodFixture<object, string>.Accept),
            [argument]));
    }

    [Fact]
    public void GetMethodSafe_TypeBuilderConstructedGeneric_ResolvesInheritedParameterType()
    {
        var assembly = AssemblyBuilder.DefineDynamicAssembly(
            new AssemblyName("GetMethodSafeInheritedTypeBuilder"),
            AssemblyBuilderAccess.Run);
        var module = assembly.DefineDynamicModule("GetMethodSafeInheritedTypeBuilder");
        var argument = module.DefineType("Argument", TypeAttributes.Public);
        var constructed = typeof(TypeBuilderDerivedMethodFixture<>).MakeGenericType(argument);

        Assert.Throws<NotSupportedException>(() => constructed.GetMethod(
            nameof(TypeBuilderBaseMethodFixture<object>.Accept),
            [argument]));
        Assert.NotNull(ClrTypeInspector.GetMethodSafe(
            constructed,
            nameof(TypeBuilderBaseMethodFixture<object>.Accept)));
        Assert.NotNull(ClrTypeInspector.GetMethodSafe(
            constructed,
            nameof(TypeBuilderBaseMethodFixture<object>.Accept),
            [argument]));
    }

    /// <summary>
    /// Loads <see cref="Fixture338"/> through a MetadataLoadContext whose
    /// reference set intentionally omits <c>System.Text.RegularExpressions</c>,
    /// so any signature referencing <see cref="Regex"/> / <see cref="MatchEvaluator"/>
    /// throws a <see cref="FileNotFoundException"/> when touched.
    /// </summary>
    private static Type LoadFixtureUnderIncompleteContext()
    {
        var trusted = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
            .Split(Path.PathSeparator)
            .Where(p => !string.IsNullOrEmpty(p))
            .ToList();

        // Drop the assembly that defines Regex / MatchEvaluator so the bad
        // members become unresolvable, mirroring a transitive assembly that was
        // not supplied via /r:.
        var paths = trusted
            .Where(p => !string.Equals(Path.GetFileNameWithoutExtension(p), "System.Text.RegularExpressions", StringComparison.OrdinalIgnoreCase))
            .Append(typeof(ClrTypeUtilitiesTests).Assembly.Location)
            .Where(p => !string.IsNullOrEmpty(p))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var resolver = new PathAssemblyResolver(paths);
        var mlc = new MetadataLoadContext(resolver, coreAssemblyName: "System.Private.CoreLib");
        var assembly = mlc.LoadFromAssemblyPath(typeof(ClrTypeUtilitiesTests).Assembly.Location);
        var fixture = assembly.GetType(typeof(Fixture338).FullName, throwOnError: true);

        // Guard: the regex assembly really is absent from this context.
        Assert.DoesNotContain(
            mlc.GetAssemblies(),
            a => string.Equals(a.GetName().Name, "System.Text.RegularExpressions", StringComparison.OrdinalIgnoreCase));

        return fixture;
    }
}

/// <summary>
/// Issue #338 reflection fixture. Each member kind has a "good" sibling whose
/// signature only touches core types and a "bad" sibling whose signature
/// references <see cref="Regex"/> / <see cref="MatchEvaluator"/> from the
/// deliberately-omitted <c>System.Text.RegularExpressions</c> assembly.
/// </summary>
#pragma warning disable CS0067 // event is never used; only its signature is reflected over.
#pragma warning disable CS0649 // field is never assigned; only its signature is reflected over.
file sealed class Fixture338
{
    public Fixture338()
    {
    }

    public Fixture338(Regex pattern)
    {
        _ = pattern;
    }

    public event EventHandler GoodEvent;

    public event MatchEvaluator BadEvent;

    public int GoodField;

    public Regex BadField;

    public int GoodProperty { get; set; }

    public Regex BadProperty { get; set; }

    public int GoodMethod() => 0;

    public void BadParameterMethod(Regex pattern) => _ = pattern;

    public Regex BadReturnMethod() => null;
}
#pragma warning restore CS0067
#pragma warning restore CS0649

file sealed class TypeBuilderMethodFixture<T>
{
    public void Accept(T value) => _ = value;

    public void Accept(int value) => _ = value;

    public void AcceptList(List<T> value) => _ = value;

    public void AcceptArray(T[] value) => _ = value;

    public void AcceptFunc(Func<T> value) => _ = value;

    public void AcceptByRef(ref T value) => _ = value;
}

file sealed class TypeBuilderPairMethodFixture<TFirst, TSecond>
{
    public void First(TFirst value) => _ = value;

    public void Second(TSecond value) => _ = value;

    public void Both(TFirst first, TSecond second)
    {
        _ = first;
        _ = second;
    }
}

file unsafe sealed class TypeBuilderPointerMethodFixture<T>
    where T : unmanaged
{
    public void AcceptPointer(T* value) => _ = value;
}

file sealed class TypeBuilderAmbiguousMethodFixture<TFirst, TSecond>
{
    public void Accept(TFirst value) => _ = value;

    public void Accept(TSecond value) => _ = value;
}

file class TypeBuilderBaseMethodFixture<T>
{
    public void Accept(T value) => _ = value;
}

file sealed class TypeBuilderDerivedMethodFixture<T> : TypeBuilderBaseMethodFixture<T>
{
}
