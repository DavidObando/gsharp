// <copyright file="Issue3678SourceOpenGenericTypeOfTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3678: the explicit-arity open-generic <c>typeof(Name[_, …])</c>
/// spelling (#1989) only ever searched REFERENCED assemblies, so it could not
/// name a generic type declared in the compilation being built —
/// <c>typeof(Slot[_])</c> over a source <c>class Slot[T]</c> reported GS0113
/// "Type 'Slot`1' doesn't exist" even though the bare <c>typeof(Slot)</c> form
/// bound it. Separately, the <c>ldtoken</c> emitted for ANY open user generic
/// definition (either spelling) took the generic-reference TypeSpec path,
/// producing a <c>Slot&lt;!0&gt;</c> TypeSpec whose VAR slot has no binding in
/// that scope; the PE then failed to load with BadImageFormatException the
/// moment the <c>typeof</c> ran. Both halves are covered here — the tests
/// EXECUTE the emitted program, so a metadata regression fails as loudly as a
/// binder one.
/// </summary>
public class Issue3678SourceOpenGenericTypeOfTests
{
    [Fact]
    public void SourceGenericClass_ExplicitArityTypeOf_BindsAndEmitsOpenDefinition()
    {
        var source = @"
class Slot[T] {
    prop Value int32
}

typeof(Slot[_]).Name
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Slot`1", result.Value);
    }

    [Fact]
    public void SourceGenericClass_BareTypeOf_EmitsOpenDefinition()
    {
        var source = @"
class Slot[T] {
    prop Value int32
}

typeof(Slot).Name
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Slot`1", result.Value);
    }

    [Fact]
    public void SourceGenericInterface_ExplicitArityTypeOf_BindsAndEmitsOpenDefinition()
    {
        var source = @"
interface IQuery[T] {
}

typeof(IQuery[_]).Name
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("IQuery`1", result.Value);
    }

    [Fact]
    public void SourceGenericClass_TwoArityTypeOf_SelectsMatchingArity()
    {
        var source = @"
class Pair[A, B] {
    prop V int32
}

typeof(Pair[_, _]).GetGenericArguments().Length
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void SourceOpenGenericTypeOf_IsGenericTypeDefinition()
    {
        var source = @"
class Slot[T] {
    prop Value int32
}

typeof(Slot[_]).IsGenericTypeDefinition
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void SourceOpenGenericTypeOf_MakeGenericType_Constructs()
    {
        var source = @"
class Slot[T] {
    prop Value int32
}

typeof(Slot[_]).MakeGenericType(typeof(int32)).GetGenericArguments()[0].Name
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Int32", result.Value);
    }

    [Fact]
    public void SourceGenericClass_WrongArityTypeOf_StillReportsUndefinedTypeGS0113()
    {
        var source = @"
class Slot[T] {
    prop Value int32
}

class C {
    func run() {
        let t = typeof(Slot[_, _])
    }
}
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0113");
    }

    [Fact]
    public void ConstructedSourceGenericTypeOf_StaysConstructed()
    {
        var source = @"
class Slot[T] {
    prop Value int32
}

typeof(Slot[int32]).GetGenericArguments()[0].Name
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Int32", result.Value);
    }
}
