// <copyright file="Issue2135TypeBuilderInstantiationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;
using System.Reflection.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #2135: <see cref="ClrTypeUtilities.IsAssignableByName(Type, Type)"/>
/// has a "same-context fast path" that calls <c>target.IsAssignableFrom(source)</c>
/// whenever the two types share a reflection assembly / kind. During emit the
/// target can be a <see cref="System.Reflection.Emit.TypeBuilderInstantiation"/>
/// — a generic instantiation of a type still being defined by the emit's
/// <see cref="TypeBuilder"/>s (e.g. a same-compilation generic user delegate
/// closed over a concrete type argument). Its <c>IsAssignableFrom</c> throws
/// <see cref="NotSupportedException"/>, which previously escaped all the way out
/// of <c>Compilation.Emit</c> and surfaced as <c>GS9998</c> while binding an
/// event subscription (<c>+=</c>).
///
/// The method is explicitly designed to fall through to a reference-context-
/// independent by-name walk whenever the fast path cannot answer (that is why
/// <see cref="InvalidOperationException"/> was already swallowed). This test
/// builds a genuine <c>TypeBuilderInstantiation</c> in a dynamic assembly and a
/// sibling type in the SAME assembly (so the same-context fast path fires) and
/// asserts the call no longer throws and instead returns the by-name answer.
///
/// RED before the fix: <see cref="NotSupportedException"/> propagates.
/// GREEN after: the exception is caught and the by-name walk decides.
/// </summary>
public class Issue2135TypeBuilderInstantiationTests
{
    [Fact]
    public void IsAssignableByName_TypeBuilderInstantiationTarget_DoesNotThrow()
    {
        var (instantiation, sibling) = BuildTypeBuilderInstantiationAndSibling();

        // The two types live in the same (dynamic) assembly, so the same-
        // context fast path is entered and IsAssignableFrom is invoked on the
        // TypeBuilderInstantiation target — the exact call that threw
        // NotSupportedException before the fix.
        Assert.True(ReferenceEquals(instantiation.Assembly, sibling.Assembly));
        Assert.IsAssignableFrom<TypeBuilder>(sibling);
        Assert.Equal("TypeBuilderInstantiation", instantiation.GetType().Name);

        var exception = Record.Exception(() => ClrTypeUtilities.IsAssignableByName(instantiation, sibling));

        Assert.Null(exception);
    }

    [Fact]
    public void IsAssignableByName_TypeBuilderInstantiationTarget_FallsThroughToByNameWalk()
    {
        var (instantiation, sibling) = BuildTypeBuilderInstantiationAndSibling();

        // `sibling` does not derive from / implement the constructed generic
        // definition, so the reference-context-independent by-name walk the
        // fast path falls through to correctly answers `false` (rather than
        // crashing).
        Assert.False(ClrTypeUtilities.IsAssignableByName(instantiation, sibling));
    }

    private static (Type Instantiation, Type Sibling) BuildTypeBuilderInstantiationAndSibling()
    {
        var assemblyName = new AssemblyName("Issue2135DynamicAssembly");
        var assemblyBuilder = AssemblyBuilder.DefineDynamicAssembly(assemblyName, AssemblyBuilderAccess.Run);
        var moduleBuilder = assemblyBuilder.DefineDynamicModule("Issue2135Module");

        // A generic type still under construction — its `.MakeGenericType(...)`
        // produces a TypeBuilderInstantiation whose IsAssignableFrom throws.
        var genericDefinition = moduleBuilder.DefineType(
            "Bus`1",
            TypeAttributes.Public | TypeAttributes.Class);
        genericDefinition.DefineGenericParameters("T");

        // A sibling type in the SAME dynamic assembly so the same-context fast
        // path (`ReferenceEquals(target.Assembly, source.Assembly)`) is taken.
        var sibling = moduleBuilder.DefineType(
            "Consumer",
            TypeAttributes.Public | TypeAttributes.Class);

        var instantiation = genericDefinition.MakeGenericType(typeof(int));
        return (instantiation, sibling);
    }
}
