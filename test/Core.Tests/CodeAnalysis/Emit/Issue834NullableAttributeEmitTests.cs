// <copyright file="Issue834NullableAttributeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #834: a G# extension function whose parameter is typed as
/// <c>T?</c> for a reference (or class-constrained generic) type must emit
/// per-parameter <c>System.Runtime.CompilerServices.NullableAttribute(2)</c>
/// so a C# consumer using <c>nullable enable</c> sees the parameter as
/// annotated (CS8602 silenced). When all reference positions share the
/// same nullability flag, the emitter collapses them into a single
/// <c>NullableContextAttribute(b)</c> on the MethodDef and skips matching
/// per-position rows — exactly what Roslyn does for the equivalent C#
/// source.
/// </summary>
public class Issue834NullableAttributeEmitTests
{
    [Fact]
    public void ExtensionParameter_OnNullableGeneric_StampsNullableAttribute()
    {
        const string Source = @"package Issue834.Map

import System

func (self T?) Map[T class, U class](f (T) -> U) U? {
    if f == nil {
        throw ArgumentNullException(""f"")
    }

    if self == nil {
        return nil
    }

    return f(self!!)
}
";
        var asm = CompileToAssembly(Source, "Issue834.Map");
        var programType = asm.GetTypes().Single(t => t.Name == "<Program>");
        var map = programType.GetMethod("Map", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(map);

        var parameters = map!.GetParameters();
        Assert.Equal(2, parameters.Length);

        // Either the per-method NullableContextAttribute = 2 collapses the
        // shape (both the `T?` self parameter, the `(T) -> U` reference
        // function, and the `U?` return all converge), or the receiver carries
        // its own NullableAttribute(2). Allow either compaction.
        var selfNullable = GetNullableAttributeValue(parameters[0]);
        var methodContext = GetNullableContextAttributeValue(map);
        Assert.True(
            selfNullable == 2 || methodContext == 2,
            $"Map's `self` parameter must report nullable: selfNullable={selfNullable}, methodContext={methodContext}");
    }

    [Fact]
    public void ExtensionFunction_UniformNullableShape_StampsNullableContextAttribute()
    {
        const string Source = @"package Issue834.UniformContext

import System

func (self T?) Filter[T class](predicate (T) -> bool) T? {
    if predicate == nil {
        throw ArgumentNullException(""predicate"")
    }

    if self == nil {
        return nil
    }

    if predicate(self!!) {
        return self
    }

    return nil
}
";
        var asm = CompileToAssembly(Source, "Issue834.UniformContext");
        var programType = asm.GetTypes().Single(t => t.Name == "<Program>");
        var filter = programType.GetMethod("Filter", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(filter);

        var methodContext = GetNullableContextAttributeValue(filter!);
        // The most common byte across (T? return) + (T? self) + (Func<T, bool> predicate)
        // is `2` (annotated) — Roslyn collapses to NullableContextAttribute(2).
        Assert.Equal((byte)2, methodContext);

        // With method-level default 2, the predicate parameter (single
        // NotAnnotated byte for the delegate ref slot) needs its own
        // NullableAttribute(1).
        var predicate = filter!.GetParameters()[1];
        var predicateAttr = GetNullableAttributeValue(predicate);
        Assert.Equal((byte)1, predicateAttr);
    }

    [Fact]
    public void ExtensionFunction_OnNullableReferenceType_StampsAnnotated()
    {
        // T? where the receiver is a concrete reference type (no generic).
        const string Source = @"package Issue834.StringMap

import System

func (self string?) MaybeShout() string? {
    if self == nil {
        return nil
    }

    return self + ""!""
}
";
        var asm = CompileToAssembly(Source, "Issue834.StringMap");
        var programType = asm.GetTypes().Single(t => t.Name == "<Program>");
        var shout = programType.GetMethod("MaybeShout", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(shout);

        var selfParam = shout!.GetParameters().Single();
        // Per-parameter annotation OR uniform method context.
        var selfAttr = GetNullableAttributeValue(selfParam);
        var methodContext = GetNullableContextAttributeValue(shout);
        Assert.True(
            selfAttr == 2 || methodContext == 2,
            $"selfAttr={selfAttr}, methodContext={methodContext}");
    }

    [Fact]
    public void NonNullableReferenceParameter_RelyOnAssemblyDefault()
    {
        // No `?` anywhere — the assembly-level NullableContextAttribute(1)
        // suffices, so we should emit NO per-parameter NullableAttribute and
        // NO per-method NullableContextAttribute. Verifies we do not bloat
        // metadata for the non-nullable case.
        const string Source = @"package Issue834.Plain

import System

func Echo(s string) string {
    return s
}
";
        var asm = CompileToAssembly(Source, "Issue834.Plain");
        var programType = asm.GetTypes().Single(t => t.Name == "<Program>");
        var echo = programType.GetMethod("Echo", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(echo);

        Assert.Null(GetNullableContextAttributeValue(echo!));
        Assert.Null(GetNullableAttributeValue(echo!.GetParameters()[0]));
    }

    [Fact]
    public void ValueTypeParameter_EmitsNoNullableAttribute()
    {
        const string Source = @"package Issue834.ValueParam

import System

func Add(x int32, y int32) int32 {
    return x + y
}
";
        var asm = CompileToAssembly(Source, "Issue834.ValueParam");
        var programType = asm.GetTypes().Single(t => t.Name == "<Program>");
        var add = programType.GetMethod("Add", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(add);

        Assert.Null(GetNullableContextAttributeValue(add!));
        foreach (var p in add!.GetParameters())
        {
            Assert.Null(GetNullableAttributeValue(p));
        }
    }

    [Fact]
    public void GenericIEnumerableNullableReceiver_StampsNullableAttribute()
    {
        // Receiver is `IEnumerable[T]?` over a generic T — exactly the
        // repro shape from the issue.
        const string Source = @"package Issue834.SliceFromNullable

import System
import System.Collections.Generic

func (source IEnumerable[T]?) ToSliceOrEmpty[T]() []T {
    if source == nil {
        return []T{}
    }

    var list = List[T]()
    for item in source!! {
        list.Add(item)
    }

    return list.ToArray()
}
";
        var asm = CompileToAssembly(Source, "Issue834.SliceFromNullable");
        var programType = asm.GetTypes().Single(t => t.Name == "<Program>");
        var toSlice = programType.GetMethod("ToSliceOrEmpty", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(toSlice);

        var sourceParam = toSlice!.GetParameters().Single();

        // The receiver carries either a per-parameter NullableAttribute or a
        // method-level NullableContextAttribute that lifts it to annotated.
        var perParam = GetNullableAttributeArrayValue(sourceParam);
        var methodContext = GetNullableContextAttributeValue(toSlice);

        // Either way, the OUTER position for `source` must reflect "annotated".
        byte outerByte;
        if (perParam.Length > 0)
        {
            outerByte = perParam[0];
        }
        else if (methodContext is byte ctx)
        {
            outerByte = ctx;
        }
        else
        {
            outerByte = 0;
        }

        Assert.Equal((byte)2, outerByte);
    }

    [Fact]
    public void NullableContextDecidedByMajority_NonNullParamsDefaultStaysOne()
    {
        // 1 nullable position, 2 non-nullable → majority is 1, so the
        // assembly default wins and NO NullableContextAttribute is needed
        // on the method. The single `s2` nullable parameter still requires
        // a per-parameter NullableAttribute(2).
        const string Source = @"package Issue834.Mixed

import System

func Compose(s1 string, s2 string?, s3 string) string {
    if s2 == nil {
        return s1 + s3
    }

    return s1 + s2!! + s3
}
";
        var asm = CompileToAssembly(Source, "Issue834.Mixed");
        var programType = asm.GetTypes().Single(t => t.Name == "<Program>");
        var compose = programType.GetMethod("Compose", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(compose);

        Assert.Null(GetNullableContextAttributeValue(compose!));

        var parameters = compose!.GetParameters();
        Assert.Null(GetNullableAttributeValue(parameters[0]));
        Assert.Equal((byte)2, GetNullableAttributeValue(parameters[1]));
        Assert.Null(GetNullableAttributeValue(parameters[2]));
    }

    [Fact]
    public void StructConstrainedNullable_LowersToValueTypeNullableT_NoNullableAttribute()
    {
        // For `T?` over a `struct`-constrained TP, the signature lowers to
        // `Nullable<T>` (a value type) — no NullableAttribute is needed on
        // the receiver because there are no reference-typed positions.
        const string Source = @"package Issue834.ValueOptional

import System

func (self T?) OrZero[T struct](defaultValue T) T {
    if !self.HasValue {
        return defaultValue
    }

    return self.Value
}
";
        var asm = CompileToAssembly(Source, "Issue834.ValueOptional");
        var programType = asm.GetTypes().Single(t => t.Name == "<Program>");
        var orZero = programType.GetMethod("OrZero", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(orZero);

        // No NullableAttribute on any value-type position.
        foreach (var p in orZero!.GetParameters())
        {
            Assert.Null(GetNullableAttributeValue(p));
        }

        // And no method-level NullableContextAttribute either — there are
        // no reference positions at all to bias.
        Assert.Null(GetNullableContextAttributeValue(orZero!));
    }

    private static byte? GetNullableAttributeValue(ParameterInfo parameter)
    {
        foreach (var ad in parameter.GetCustomAttributesData())
        {
            if (ad.AttributeType?.FullName != "System.Runtime.CompilerServices.NullableAttribute"
                || ad.ConstructorArguments.Count != 1)
            {
                continue;
            }

            var arg = ad.ConstructorArguments[0];
            if (arg.Value is byte b)
            {
                return b;
            }

            if (arg.Value is System.Collections.ObjectModel.ReadOnlyCollection<System.Reflection.CustomAttributeTypedArgument> arr
                && arr.Count > 0
                && arr[0].Value is byte first)
            {
                return first;
            }
        }

        return null;
    }

    private static byte[] GetNullableAttributeArrayValue(ParameterInfo parameter)
    {
        foreach (var ad in parameter.GetCustomAttributesData())
        {
            if (ad.AttributeType?.FullName != "System.Runtime.CompilerServices.NullableAttribute"
                || ad.ConstructorArguments.Count != 1)
            {
                continue;
            }

            var arg = ad.ConstructorArguments[0];
            if (arg.Value is byte b)
            {
                return new[] { b };
            }

            if (arg.Value is System.Collections.ObjectModel.ReadOnlyCollection<System.Reflection.CustomAttributeTypedArgument> arr)
            {
                var result = new byte[arr.Count];
                for (int i = 0; i < arr.Count; i++)
                {
                    if (arr[i].Value is byte ab)
                    {
                        result[i] = ab;
                    }
                }

                return result;
            }
        }

        return Array.Empty<byte>();
    }

    private static byte? GetNullableContextAttributeValue(MethodInfo method)
    {
        foreach (var ad in method.GetCustomAttributesData())
        {
            if (ad.AttributeType?.FullName != "System.Runtime.CompilerServices.NullableContextAttribute"
                || ad.ConstructorArguments.Count != 1)
            {
                continue;
            }

            if (ad.ConstructorArguments[0].Value is byte b)
            {
                return b;
            }
        }

        return null;
    }

    private static Assembly CompileToAssembly(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: false);
        return loadContext.LoadFromStream(peStream);
    }
}
