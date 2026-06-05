// <copyright file="DataStructSynthesizedMembersTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #410 / ADR-0029: validates the seven synthesized members emitted for
/// every <c>data struct</c> — <c>Equals(Name)</c>, <c>Equals(object)</c>,
/// <c>GetHashCode</c>, <c>ToString</c>, <c>op_Equality</c>,
/// <c>op_Inequality</c>, and <c>Deconstruct</c>. These tests exercise the
/// generated IL via reflection to ensure structural value semantics work both
/// from G# and from cross-language consumers.
/// </summary>
public class DataStructSynthesizedMembersTests
{
    [Fact]
    public void DataStruct_EmitsSevenSynthesizedMethods_PlusCtor()
    {
        var source = """
            package MyLib
            import System

            type Point data struct {
                X int32
                Y int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var point = assembly.GetTypes().Single(t => t.Name == "Point");

        Assert.NotNull(point.GetMethod("Equals", new[] { typeof(object) }));
        Assert.NotNull(point.GetMethod("Equals", new[] { point }));
        Assert.NotNull(point.GetMethod("GetHashCode", Type.EmptyTypes));
        Assert.NotNull(point.GetMethod("ToString", Type.EmptyTypes));
        Assert.NotNull(point.GetMethod("op_Equality", new[] { point, point }));
        Assert.NotNull(point.GetMethod("op_Inequality", new[] { point, point }));
        Assert.NotNull(point.GetMethod("Deconstruct", BindingFlags.Public | BindingFlags.Instance));
    }

    [Fact]
    public void DataStruct_EqualsTyped_ReturnsTrueForEqualValues_FalseOtherwise()
    {
        var source = """
            package MyLib
            import System

            type Point data struct {
                X int32
                Y int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var point = assembly.GetTypes().Single(t => t.Name == "Point");

        var a = MakePoint(point, 3, 4);
        var b = MakePoint(point, 3, 4);
        var c = MakePoint(point, 3, 5);

        var equalsTyped = point.GetMethod("Equals", new[] { point });
        Assert.NotNull(equalsTyped);
        Assert.True((bool)equalsTyped!.Invoke(a, new[] { b })!);
        Assert.False((bool)equalsTyped.Invoke(a, new[] { c })!);
    }

    [Fact]
    public void DataStruct_EqualsObject_HandlesNullWrongTypeAndCorrectType()
    {
        var source = """
            package MyLib
            import System

            type Point data struct {
                X int32
                Y int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var point = assembly.GetTypes().Single(t => t.Name == "Point");

        var a = MakePoint(point, 1, 2);
        var b = MakePoint(point, 1, 2);

        var equalsObject = point.GetMethod("Equals", new[] { typeof(object) });
        Assert.NotNull(equalsObject);
        Assert.True((bool)equalsObject!.Invoke(a, new[] { b })!);
        Assert.False((bool)equalsObject.Invoke(a, new object[] { null! })!);
        Assert.False((bool)equalsObject.Invoke(a, new object[] { "not a Point" })!);
    }

    [Fact]
    public void DataStruct_GetHashCode_IsStableForEqualValues()
    {
        var source = """
            package MyLib
            import System

            type Point data struct {
                X int32
                Y int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var point = assembly.GetTypes().Single(t => t.Name == "Point");

        var a = MakePoint(point, 13, 27);
        var b = MakePoint(point, 13, 27);
        var c = MakePoint(point, 13, 28);

        var getHashCode = point.GetMethod("GetHashCode", Type.EmptyTypes);
        Assert.NotNull(getHashCode);
        var ha = (int)getHashCode!.Invoke(a, null)!;
        var hb = (int)getHashCode.Invoke(b, null)!;
        var hc = (int)getHashCode.Invoke(c, null)!;
        Assert.Equal(ha, hb);
        Assert.NotEqual(ha, hc); // not guaranteed by contract, but extremely likely for HashCode.Combine
    }

    [Fact]
    public void DataStruct_ToString_FormatsAsNameWithFieldEqualsValuePairs()
    {
        var source = """
            package MyLib
            import System

            type Point data struct {
                X int32
                Y int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var point = assembly.GetTypes().Single(t => t.Name == "Point");

        var p = MakePoint(point, 3, 4);
        var toString = point.GetMethod("ToString", Type.EmptyTypes);
        Assert.NotNull(toString);
        var actual = (string)toString!.Invoke(p, null)!;
        Assert.Equal("Point(X=3, Y=4)", actual);
    }

    [Fact]
    public void DataStruct_ToString_NullReferenceField_DoesNotThrow()
    {
        var source = """
            package MyLib
            import System

            type Pair data struct {
                Name string
                Count int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var pair = assembly.GetTypes().Single(t => t.Name == "Pair");

        var instance = Activator.CreateInstance(pair)!;
        // leave Name null, set Count to 0 (default)
        var toString = pair.GetMethod("ToString", Type.EmptyTypes);
        Assert.NotNull(toString);
        var actual = (string)toString!.Invoke(instance, null)!;
        // Convert.ToString(null, InvariantCulture) returns string.Empty (not "null").
        Assert.Equal("Pair(Name=, Count=0)", actual);
    }

    [Fact]
    public void DataStruct_OpEquality_AndInequality_RoundTrip()
    {
        var source = """
            package MyLib
            import System

            type Point data struct {
                X int32
                Y int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var point = assembly.GetTypes().Single(t => t.Name == "Point");

        var a = MakePoint(point, 5, 6);
        var b = MakePoint(point, 5, 6);
        var c = MakePoint(point, 5, 7);

        var opEq = point.GetMethod("op_Equality", new[] { point, point });
        var opNe = point.GetMethod("op_Inequality", new[] { point, point });
        Assert.NotNull(opEq);
        Assert.NotNull(opNe);

        Assert.True((bool)opEq!.Invoke(null, new[] { a, b })!);
        Assert.False((bool)opEq.Invoke(null, new[] { a, c })!);
        Assert.False((bool)opNe!.Invoke(null, new[] { a, b })!);
        Assert.True((bool)opNe.Invoke(null, new[] { a, c })!);
    }

    [Fact]
    public void DataStruct_Deconstruct_AssignsAllFields()
    {
        var source = """
            package MyLib
            import System

            type Point data struct {
                X int32
                Y int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var point = assembly.GetTypes().Single(t => t.Name == "Point");

        var p = MakePoint(point, 11, 22);
        var deconstruct = point.GetMethod("Deconstruct", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(deconstruct);

        var args = new object[] { 0, 0 };
        deconstruct!.Invoke(p, args);
        Assert.Equal(11, args[0]);
        Assert.Equal(22, args[1]);
    }

    [Fact]
    public void DataStruct_Deconstruct_MixedFieldTypes()
    {
        var source = """
            package MyLib
            import System

            type Pair data struct {
                Name string
                Count int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var pair = assembly.GetTypes().Single(t => t.Name == "Pair");

        var instance = Activator.CreateInstance(pair)!;
        pair.GetField("Name")!.SetValue(instance, "abc");
        pair.GetField("Count")!.SetValue(instance, 42);

        var deconstruct = pair.GetMethod("Deconstruct", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(deconstruct);
        var args = new object[] { null!, 0 };
        deconstruct!.Invoke(instance, args);
        Assert.Equal("abc", args[0]);
        Assert.Equal(42, args[1]);
    }

    [Fact]
    public void DataStruct_GetHashCode_FoldPath_For9Fields()
    {
        // ADR-0029: ≤8 fields → HashCode.Combine; >8 fields → fold via
        // HashCode.Add + ToHashCode. Exercise the fold path with 9 fields.
        var source = """
            package MyLib
            import System

            type Big data struct {
                A int32
                B int32
                C int32
                D int32
                E int32
                F int32
                G int32
                H int32
                I int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var big = assembly.GetTypes().Single(t => t.Name == "Big");

        var instance1 = Activator.CreateInstance(big)!;
        var instance2 = Activator.CreateInstance(big)!;
        foreach (var fname in new[] { "A", "B", "C", "D", "E", "F", "G", "H", "I" })
        {
            big.GetField(fname)!.SetValue(instance1, 7);
            big.GetField(fname)!.SetValue(instance2, 7);
        }

        var getHashCode = big.GetMethod("GetHashCode", Type.EmptyTypes);
        Assert.NotNull(getHashCode);
        var h1 = (int)getHashCode!.Invoke(instance1, null)!;
        var h2 = (int)getHashCode.Invoke(instance2, null)!;
        Assert.Equal(h1, h2);

        // Change the last field; hash should (almost certainly) differ.
        big.GetField("I")!.SetValue(instance2, 8);
        var h3 = (int)getHashCode.Invoke(instance2, null)!;
        Assert.NotEqual(h1, h3);

        // Equals(Name) on the modified instance should now return false.
        var equalsTyped = big.GetMethod("Equals", new[] { big });
        Assert.NotNull(equalsTyped);
        Assert.False((bool)equalsTyped!.Invoke(instance1, new[] { instance2 })!);
    }

    [Fact]
    public void DataStruct_EqualsTyped_MixedFieldTypes()
    {
        var source = """
            package MyLib
            import System

            type Pair data struct {
                Name string
                Count int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var pair = assembly.GetTypes().Single(t => t.Name == "Pair");

        var a = Activator.CreateInstance(pair)!;
        pair.GetField("Name")!.SetValue(a, "abc");
        pair.GetField("Count")!.SetValue(a, 1);

        var b = Activator.CreateInstance(pair)!;
        pair.GetField("Name")!.SetValue(b, "abc");
        pair.GetField("Count")!.SetValue(b, 1);

        var c = Activator.CreateInstance(pair)!;
        pair.GetField("Name")!.SetValue(c, "abc");
        pair.GetField("Count")!.SetValue(c, 2);

        var d = Activator.CreateInstance(pair)!;
        pair.GetField("Name")!.SetValue(d, null);
        pair.GetField("Count")!.SetValue(d, 1);

        var equalsTyped = pair.GetMethod("Equals", new[] { pair });
        Assert.NotNull(equalsTyped);
        Assert.True((bool)equalsTyped!.Invoke(a, new[] { b })!);
        Assert.False((bool)equalsTyped.Invoke(a, new[] { c })!);
        Assert.False((bool)equalsTyped.Invoke(a, new[] { d })!);
    }

    [Fact]
    public void DataStruct_EqualsObject_DispatchesThroughOverride_NotValueTypeReflection()
    {
        // Sanity check: the override is marked virtual + final, and instance
        // dispatch through System.ValueType's slot must land on the emitted
        // override rather than reflection-based ValueType.Equals.
        var source = """
            package MyLib
            import System

            type Point data struct {
                X int32
                Y int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var point = assembly.GetTypes().Single(t => t.Name == "Point");
        var equalsObject = point.GetMethod("Equals", new[] { typeof(object) })!;
        Assert.True(equalsObject.IsVirtual);
        Assert.True(equalsObject.IsFinal);
    }

    [Fact]
    public void GenericDataStruct_EqualsAndHashCode_WorkOverErasedFields()
    {
        var source = """
            package MyLib
            import System

            type Box[T any] data struct {
                Value T
            }
            """;

        var assembly = CompileToAssembly(source);
        var box = assembly.GetTypes().Single(t => t.Name == "Box");

        var a = Activator.CreateInstance(box)!;
        var b = Activator.CreateInstance(box)!;
        var c = Activator.CreateInstance(box)!;
        // T is type-erased to object; the field's CLR type is System.Object.
        box.GetField("Value")!.SetValue(a, 42);
        box.GetField("Value")!.SetValue(b, 42);
        box.GetField("Value")!.SetValue(c, 43);

        var equalsTyped = box.GetMethod("Equals", new[] { box });
        Assert.NotNull(equalsTyped);
        Assert.True((bool)equalsTyped!.Invoke(a, new[] { b })!);
        Assert.False((bool)equalsTyped.Invoke(a, new[] { c })!);

        var getHashCode = box.GetMethod("GetHashCode", Type.EmptyTypes);
        Assert.NotNull(getHashCode);
        var ha = (int)getHashCode!.Invoke(a, null)!;
        var hb = (int)getHashCode.Invoke(b, null)!;
        Assert.Equal(ha, hb);
    }

    private static object MakePoint(Type pointType, int x, int y)
    {
        var instance = Activator.CreateInstance(pointType)!;
        pointType.GetField("X")!.SetValue(instance, x);
        pointType.GetField("Y")!.SetValue(instance, y);
        return instance;
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_datastruct_synth_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        IlVerifier.Verify(outPath);

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
