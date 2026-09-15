// <copyright file="Issue4214MetadataParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace Cs2Gs.Tests;

public class Issue4214MetadataParityTests
{
    [Theory]
    [InlineData("1L", "Int64:1")]
    [InlineData("1U", "UInt32:1")]
    [InlineData("1UL", "UInt64:1")]
    [InlineData("(byte)2", "Byte:2")]
    [InlineData("(short)2", "Int16:2")]
    [InlineData("(sbyte)2", "SByte:2")]
    [InlineData("(ushort)2", "UInt16:2")]
    [InlineData("long.MinValue", "Int64:-9223372036854775808")]
    [InlineData("ulong.MaxValue", "UInt64:18446744073709551615")]
    [InlineData("(sbyte)-2", "SByte:-2")]
    [InlineData("-1", "Int32:-1")]
    [InlineData("int.MinValue", "Int32:-2147483648")]
    [InlineData("-559038737", "Int32:-559038737")]
    public void AttributeObjectArgument_KeepsBoxedNumericType(string value, string expected)
    {
        Verify($$"""
            using System;
            namespace Demo
            {
                public sealed class ValueAttribute : Attribute
                {
                    public ValueAttribute(object value) { Value = value; }
                    public object Value { get; }
                }
                [Value({{value}})]
                public class C
                {
                    public void Run()
                    {
                        var a = (ValueAttribute)Attribute.GetCustomAttribute(typeof(C), typeof(ValueAttribute));
                        Console.WriteLine(a.Value.GetType().Name + ":" + a.Value);
                    }
                }
            }
            """, expected);
    }

    [Fact]
    public void SingletonValueTuple_RemainsGenericValueType()
    {
        Verify("""
            namespace Demo
            {
                public class C
                {
                    public void Run()
                    {
                        var type = typeof(System.ValueTuple<string>);
                        System.Console.WriteLine(type.IsValueType + ":" + type.IsGenericType);
                    }
                }
            }
            """, "True:True");
    }

    [Fact]
    public void AttributeArrayAndEnumArguments_PreserveTheirBoxedTypes()
    {
        Verify("""
            using System;
            namespace Demo
            {
                public enum Kind : byte { First = 7 }
                public sealed class ValueAttribute : Attribute
                {
                    public ValueAttribute(object value) { Value = value; }
                    public object Value { get; }
                }
                [Value(new object[] { (byte)2, 1L, Kind.First })]
                public class C
                {
                    public void Run()
                    {
                        var a = (ValueAttribute)Attribute.GetCustomAttribute(typeof(C), typeof(ValueAttribute));
                        var values = (object[])a.Value;
                        Console.WriteLine(values[0].GetType().Name + ":" + values[0]);
                        Console.WriteLine(values[1].GetType().Name + ":" + values[1]);
                        Console.WriteLine(values[2].GetType().Name + ":" + values[2]);
                    }
                }
            }
            """, "Byte:2\nInt64:1\nKind:First");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AttributeObjectArgument_PreservesSymbolicEnumArrayType(bool empty)
    {
        var argument = empty ? "new Kind[] { }" : "new Kind[] { Kind.First }";
        Verify($$"""
            using System;
            namespace Demo
            {
                public enum Kind : byte { First = 7 }
                public sealed class ValueAttribute : Attribute
                {
                    public ValueAttribute(object value) { Value = value; }
                    public object Value { get; }
                }
                [Value({{argument}})]
                public class C
                {
                    public void Run()
                    {
                        var attribute = (ValueAttribute)Attribute.GetCustomAttribute(typeof(C), typeof(ValueAttribute));
                        var values = (Array)attribute.Value;
                        Console.WriteLine(values.GetType().Name + ":" + values.Length);
                        if (values.Length > 0) Console.WriteLine(values.GetValue(0));
                    }
                }
            }
            """, empty ? "Kind[]:0" : "Kind[]:1\nFirst");
    }

    [Fact]
    public void CallerArgumentExpression_UsesRoslynCallSiteValue()
    {
        Verify("""
            using System;
            using System.Runtime.CompilerServices;
            namespace Demo
            {
                public class C
                {
                    static string Capture(object value, [CallerArgumentExpression("value")] string expression = null)
                        => expression;
                    public void Run()
                    {
                        object someDeclaringType = null;
                        Console.WriteLine(Capture(someDeclaringType));
                        Console.WriteLine(Capture(someDeclaringType, "explicit"));
                    }
                }
            }
            """, "someDeclaringType\nexplicit");
    }

    [Theory]
    [InlineData("List<int>", "Count")]
    [InlineData("ReadOnlySpan<int>", "Length")]
    public void CallerInformation_WithParamsCollection_PreservesDefaultAndExplicitValues(string carrier, string size)
    {
        Verify($$"""
            using System;
            using System.Collections.Generic;
            using System.Runtime.CompilerServices;
            namespace Demo
            {
                public class C
                {
                    static string Capture([CallerMemberName] string caller = "", params {{carrier}} values)
                        => caller + ":" + values.{{size}};
                    public void Run()
                    {
                        Console.WriteLine(Capture());
                        Console.WriteLine(Capture("explicit", 1, 2));
                    }
                }
            }
            """, "Run:0\nexplicit:2");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NullableAnnotations_PreserveNullCollectionValuesAndSelectors(bool warningsEnabled)
    {
        var directives = warningsEnabled
            ? "#nullable enable\n"
            : "#nullable disable\n#nullable enable annotations\n";
        var source = directives + """
            using System;
            using System.Collections.Generic;
            using System.Linq;
            namespace Demo
            {
                public class C
                {
                    static object? Lookup(object value) => null;
                    public void Run()
                    {
                        var values = new Dictionary<string, object?>();
                        values["x"] = Lookup(this);
                        var array = new object?[1];
                        array[0] = Lookup(this);
                        var projected = new object[] { this }.Select(value => Lookup(value)).ToArray();
                        Console.WriteLine(values["x"] is null);
                        Console.WriteLine(array[0] is null);
                        Console.WriteLine(projected[0] is null);
                    }
                }
            }
            """;
        var printed = LocalFunctionHoistTranslationTests.TranslateUnit(source);
        Assert.DoesNotContain("Lookup(this)!!", printed);
        Assert.DoesNotContain("Lookup(value)!!", printed);
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "C().Run()", "True\nTrue\nTrue");
    }

    private static void Verify(string source, string expected)
    {
        var printed = LocalFunctionHoistTranslationTests.TranslateUnit(source);
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "C().Run()", expected);
    }
}
