// <copyright file="Issue5676NullableNumericCoercionTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Xunit

class Issue5676NullableNumericCoercionTests {
    @Fact
    func NullableNumericConstants_PreserveTheIssueValues() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class Box { public long? F; public byte? B; }
    public static class P
    {
        static int A(Box b) { if (b.F is 3) { return 1; } return 0; }
        static int B(long? v) { if (v == 3) { return 1; } return 0; }
        static int C(Box b) { if (b.B is 11) { return 1; } return 0; }
        static int E(long? v) { if (v is > 2) { return 1; } return 0; }
        public static string Run() => A(new Box { F = 3 }) + " " + B(3) + " " + C(new Box { B = 11 }) + " " + E(3);
    }
}`, "1 1 1 1")
    }

    @Theory
    @InlineData("long")
    @InlineData("byte")
    @InlineData("double")
    @InlineData("decimal")
    func NullableNumericComparisons_PreserveValuesAndNull(numberType string) {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class Box
    {
        public NUMBER? Value;
        public int Reads;
        public NUMBER? Read { get { Reads++; return Value; } }
    }
    public static class P
    {
        const int K = 3;
        static string Test(NUMBER? v) =>
            (v is 3) + " " + (v is K) + " " + (v is not 3) + " " +
            (v is > 2) + " " + (v is >= 3) + " " + (v is < 4) + " " + (v is <= 3) + " " +
            (v == 3) + " " + (v != 3) + " " + (v > 2) + " " + (v >= 3) + " " + (v < 4) + " " + (v <= 3) + " " +
            (3 == v) + " " + (3 != v) + " " + (2 < v) + " " + (3 <= v) + " " + (4 > v) + " " + (3 >= v);
        static string Member(NUMBER? value)
        {
            var box = new Box { Value = value };
            bool result = box.Read is 3;
            return result + " " + box.Reads;
        }
        public static string Run() => Test(null) + " / " + Test(2) + " / " + Test(3) + " / " + Test(4) + " / " + Member(3) + " / " + Member(null);
    }
}`.Replace("NUMBER", numberType))
    }

    @Fact
    func NumericCoercionCallers_LiftValuesRatherThanDowncastBoxes() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static T Identity<T>(T value) => value;
        static long? Arm(int value, bool flag) => flag switch { true => value, false => (long?)null };
        static string Calculate(long? value, int? other, int plain)
        {
            return (value + other) + " " + (value + plain) + " " + (value == plain);
        }
        public static string Run() =>
            Identity<long?>(3) + " " + Arm(4, true) + " " + (Arm(4, false) == null) + " / " +
            Calculate(3, 4, 3) + " / " + Calculate(null, 4, 3) + " / " + Calculate(3, null, 3);
    }
}`, "3 4 True / 7 6 True /   False /  6 True")
    }

    @Fact
    func NullableNumericConversionCalls_KeepByReferenceReadsSound() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public static class P
    {
        const int K = 3;
        static T Identity<T>(T value) => value;
        static int Binary(ref string? text, long? v) => text != null && v == 3 ? text.Length : 0;
        static int Pattern(ref string? text, long? v) => text != null && v is > 2 ? text.Length : 0;
        static int Named(ref string? text, long? v) => text != null && v is K ? text.Length : 0;
        static int Argument(ref string? text, int v)
        {
            if (text == null) return 0;
            var value = Identity<long?>(v);
            return text.Length + (value == v ? 1 : 0);
        }
        static int Arm(ref string? text, int v)
        {
            if (text == null) return 0;
            long? value = v switch { 0 => (long?)null, _ => v };
            return text.Length + (value == v ? 1 : 0);
        }
        public static string Run()
        {
            string? text = "abc";
            return Binary(ref text, 3) + " " + Binary(ref text, null) + " " +
                Pattern(ref text, 3) + " " + Named(ref text, 3) + " " +
                Argument(ref text, 3) + " " + Arm(ref text, 3);
        }
    }
}`, "3 0 3 3 4 4")
    }
}
