// <copyright file="Issue4214MetadataParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Xunit

open class Issue4214MetadataParityTests {
    @Theory
    @InlineData("1L", "Int64:1")
    @InlineData("1U", "UInt32:1")
    @InlineData("1UL", "UInt64:1")
    @InlineData("(byte)2", "Byte:2")
    @InlineData("(short)2", "Int16:2")
    @InlineData("(sbyte)2", "SByte:2")
    @InlineData("(ushort)2", "UInt16:2")
    @InlineData("long.MinValue", "Int64:-9223372036854775808")
    @InlineData("ulong.MaxValue", "UInt64:18446744073709551615")
    @InlineData("(sbyte)-2", "SByte:-2")
    @InlineData("-1", "Int32:-1")
    @InlineData("int.MinValue", "Int32:-2147483648")
    @InlineData("-559038737", "Int32:-559038737")
    func AttributeObjectArgument_KeepsBoxedNumericType(value string, expected string) {
        Verify((`using System;
namespace Demo
{
    public sealed class ValueAttribute : Attribute
    {
        public ValueAttribute(object value) { Value = value; }
        public object Value { get; }
    }
    [Value(` + "$value" + `)]
    public class C
    {
        public void Run()
        {
            var a = (ValueAttribute)Attribute.GetCustomAttribute(typeof(C), typeof(ValueAttribute));
            Console.WriteLine(a.Value.GetType().Name + ":" + a.Value);
        }
    }
}`), expected)
    }

    @Fact
    func SingletonValueTuple_RemainsGenericValueType() {
        Verify(`namespace Demo
{
    public class C
    {
        public void Run()
        {
            var type = typeof(System.ValueTuple<string>);
            System.Console.WriteLine(type.IsValueType + ":" + type.IsGenericType);
        }
    }
}`, "True:True")
    }

    @Fact
    func AttributeArrayAndEnumArguments_PreserveTheirBoxedTypes() {
        Verify(`using System;
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
}`, `Byte:2
Int64:1
Kind:First`)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func AttributeObjectArgument_PreservesSymbolicEnumArrayType(empty bool) {
        let argument = if empty {
            "new Kind[] { }"
        } else {
            "new Kind[] { Kind.First }"
        }
        Verify((`using System;
namespace Demo
{
    public enum Kind : byte { First = 7 }
    public sealed class ValueAttribute : Attribute
    {
        public ValueAttribute(object value) { Value = value; }
        public object Value { get; }
    }
    [Value(` + "$argument" + `)]
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
}`), if empty {
                "Kind[]:0"
            } else {
                "Kind[]:1\nFirst"
            })
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func AttributeObjectArray_PreservesNestedEnumArrayType(empty bool, additionalObjectArray bool) {
        var argument = if empty {
            "new Kind[] { }"
        } else {
            "new Kind[] { Kind.First }"
        }
        argument = "new object[] { " + argument + " }"
        if additionalObjectArray {
            argument = "new object[] { " + argument + " }"
        }
        Verify((`using System;
namespace Demo
{
    public enum Kind { First = 7 }
    public sealed class ValueAttribute : Attribute
    {
        public ValueAttribute(object value) { Value = value; }
        public object Value { get; }
    }
    [Value(` + "$argument" + `)]
    public class C
    {
        public void Run()
        {
            var attribute = (ValueAttribute)Attribute.GetCustomAttribute(typeof(C), typeof(ValueAttribute));
            var values = (Array)attribute.Value;
            while (values is object[] objects) values = (Array)objects[0];
            Console.WriteLine(values.GetType().Name + ":" + values.Length);
            if (values.Length > 0) Console.WriteLine(values.GetValue(0));
        }
    }
}`), if empty {
                "Kind[]:0"
            } else {
                "Kind[]:1\nFirst"
            })
    }

    @Fact
    func AttributeObjectArray_PreservesImportedEnumAndPrimitiveArrayTypes() {
        Verify(`using System;
namespace Demo
{
    public sealed class ValueAttribute : Attribute
    {
        public ValueAttribute(object value) { Value = value; }
        public object Value { get; }
    }
    [Value(new object[] { new DayOfWeek[] { DayOfWeek.Monday }, new int[] { 7 } })]
    public class C
    {
        public void Run()
        {
            var attribute = (ValueAttribute)Attribute.GetCustomAttribute(typeof(C), typeof(ValueAttribute));
            foreach (Array values in (object[])attribute.Value)
                Console.WriteLine(values.GetType().Name + ":" + values.GetValue(0));
        }
    }
}`, "DayOfWeek[]:Monday\nInt32[]:7")
    }

    @Fact
    func CallerArgumentExpression_UsesRoslynCallSiteValue() {
        Verify(`using System;
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
}`, "someDeclaringType\nexplicit")
    }

    @Theory
    @InlineData("List<int>", "Count")
    @InlineData("ReadOnlySpan<int>", "Length")
    func CallerInformation_WithParamsCollection_PreservesDefaultAndExplicitValues(carrier string, size string) {
        Verify((`using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
namespace Demo
{
    public class C
    {
        static string Capture([CallerMemberName] string caller = "", params ` + "$carrier" + ` values)
            => caller + ":" + values.` + "$size" + `;
        public void Run()
        {
            Console.WriteLine(Capture());
            Console.WriteLine(Capture("explicit", 1, 2));
        }
    }
}`), "Run:0\nexplicit:2")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NullableAnnotations_PreserveNullCollectionValuesAndSelectors(warningsEnabled bool) {
        let directives = if warningsEnabled {
            "#nullable enable\n"
        } else {
            `#nullable disable
#nullable enable annotations
`
        }
        let source = directives + `using System;
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
}`
        let printed = LocalFunctionHoistTranslationTests.TranslateUnit(source)
        Assert.DoesNotContain("Lookup(this)!!", printed)
        Assert.DoesNotContain("Lookup(value)!!", printed)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "C().Run()", `True
True
True`)
    }

    shared {
        private func Verify(source string, expected string) {
            let printed = LocalFunctionHoistTranslationTests.TranslateUnit(source)
            LocalFunctionHoistTranslationTests.CompileAndRun(printed, "C().Run()", expected)
        }
    }
}
