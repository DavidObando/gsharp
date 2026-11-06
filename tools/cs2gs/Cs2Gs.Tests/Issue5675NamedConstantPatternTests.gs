// <copyright file="Issue5675NamedConstantPatternTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Xunit

class Issue5675NamedConstantPatternTests {
    @Fact
    func NamedConstants_TestValuesRatherThanTheirTypes() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public enum Color { Red, Green }
    public static class P
    {
        const string K = "k";
        static int E(Color? c) { if (c is Color.Green) { return 7; } return 0; }
        static int F(Color c) { if (c is Color.Green) { return 7; } return 0; }
        static int S(string? s) { if (s is K) { return 7; } return 0; }
        static int Q(string? s) { if (s is P.K) { return 7; } return 0; }
        public static string Run() =>
            E(Color.Red) + " " + F(Color.Red) + " " + S("x") + " " + Q("x") + " / " +
            E(Color.Green) + " " + F(Color.Green) + " " + S("k") + " " + Q("k") + " / " +
            E(null) + " " + S(null) + " " + Q(null);
    }
}`, "0 0 0 0 / 7 7 7 7 / 0 0 0")
    }

    @Theory
    @InlineData("enable")
    @InlineData("disable")
    func NamedConstants_InConditionsKeepNullableReadsAndEvaluateOnce(nullableMode string) {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable NULLABLE_MODE
namespace Demo
{
    public static class P
    {
        const string K = "key";
        const int N = 3;
        static int reads;
        static string? Read(string? value) { reads++; return value; }
        static int If(string? s) { if (s is K) { return s.Length; } return 0; }
        static int And(string? s) => s is P.K && s.Length > 0 ? s.Length : 0;
        static int Conditional(string? s) => s is K ? s.Length : 0;
        static int Local(string? s) { const string LocalK = "key"; if (s is LocalK) { return s.Length; } return 0; }
        static bool Number(int? value) { const int Local = 3; return value is N && value is P.N && value is Local; }
        static bool Once(string? s) => Read(s) is K;
        public static string Run() =>
            If("key") + " " + If("no") + " " + If(null) + " " +
            And("key") + " " + And("no") + " " + And(null) + " " +
            Conditional("key") + " " + Conditional(null) + " " + Local("key") + " " + Local("no") + " " +
            Number(3) + " " + Number(2) + " " + Number(null) + " " +
            Once("key") + " " + Once("no") + " " + Once(null) + " " + reads;
    }
}`.Replace("NULLABLE_MODE", nullableMode)
                .Replace(
                "string?",
                if nullableMode == "disable" {
                    "string"
                } else {
                    "string?"
                }
            ), "3 0 0 3 0 0 3 0 3 0 True False False True False False 3")
    }

    @Fact
    func ObjectConstants_PreserveBoxedTypesAndGuardedReads() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class Key { }
    public enum Color { Red, Green }
    public static class P
    {
        const string K = "key";
        const int N = 3;
        const string? Nil = null;
        const Color C = Color.Green;
        static int String(object? value) { if (value is K) return value.ToString()!.Length; return 0; }
        static bool Number(object? value) => value is P.N;
        static bool Long(object? value) { const long Local = 3; return value is Local; }
        static bool Byte(object? value) { const byte Local = 3; return value is Local; }
        static bool Double(object? value) { const double Local = 3; return value is Local; }
        static bool Decimal(object? value) { const decimal Local = 3; return value is Local; }
        static bool Enum(object? value) => value is C;
        static bool Null(object? value) => value is Nil;
        static bool Type(object? value) => value is Key;
        static bool Bool(object? value) => value is true;
        public static string Run() =>
            String("key") + " " + String("no") + " " + String(null) + " " +
            Number(3) + " " + Number(4) + " " + Number(3L) + " " +
            Long(3L) + " " + Long(3) + " " + Byte((byte)3) + " " + Byte(3) + " " +
            Double(3.0) + " " + Double(3) + " " + Decimal(3m) + " " + Decimal(3) + " " +
            Enum(Color.Green) + " " + Enum(Color.Red) + " " + Enum(1) + " " +
            Null(null) + " " + Null("key") + " " + Type(new Key()) + " " + Type("key") + " " +
            Bool(true) + " " + Bool(false) + " " + Bool(null);
    }
}`, "3 0 0 True False False True False True False True False True False True False False True False True False True False False")
    }

    @Fact
    func ObjectConstantGuard_HandlesAnEscapedClosureAssignment() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public static class P
    {
        const int K = 3;
        static Action? saved;
        static int Match(object? seed)
        {
            object? current = seed;
            saved = () => current = null;
            if (current is K) return current.GetHashCode();
            return 0;
        }
        public static string Run() => Match(3) + " " + Match(4) + " " + Match(null);
    }
}`, "3 0 0")
    }

    @Fact
    func ObjectConstantInLoop_KeepsByReferenceReadsSound() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public static class P
    {
        const long K = 3;
        static int Binary(ref string? text, object? value)
        {
            if (text == null) return 0;
            for (int i = 0; i < 1; i++) { if (value is K) return text.Length; }
            return 0;
        }
        static int Pattern(ref string? text, object? value)
        {
            if (text == null) return 0;
            for (int i = 0; i < 1; i++) { if (value is not (not K)) return text.Length; }
            return 0;
        }
        public static string Run()
        {
            string? text = "abc";
            return Binary(ref text, 3L) + " " + Binary(ref text, 3) + " " +
                Pattern(ref text, 3L) + " " + Pattern(ref text, null);
        }
    }
}`, "3 0 3 0")
    }

    @Fact
    func ObjectDecimalConstants_PreserveRangeAndPrecision() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public static class P
    {
        const decimal Max = 79228162514264337593543950335m;
        const decimal Min = -79228162514264337593543950335m;
        const decimal Fraction = 0.1234567890123456789012345678m;
        static bool MatchMax(object? value) => value is Max;
        static bool MatchMin(object? value) => value is Min;
        static bool MatchFraction(object? value) => value is Fraction;
        public static string Run() =>
            MatchMax(decimal.MaxValue) + " " + MatchMax(decimal.MinValue) + " " +
            MatchMin(decimal.MinValue) + " " + MatchMin(null) + " " +
            MatchFraction(Fraction) + " " + MatchFraction(0.1234567890123456789012345679m) + " " +
            MatchFraction(0.12345678901234568);
    }
}`, "True False True False True False False")
    }

    @Fact
    func NaNPatterns_PreserveNullableBoxedAndSingleEvaluationSemantics() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public sealed class Pretender
    {
        public static int Calls;
        public override bool Equals(object? other) { Calls++; return true; }
        public override int GetHashCode() => 0;
    }
    public static class P
    {
        const double D = double.NaN;
        const float F = float.NaN;
        static int reads;
        static double? Read(double? value) { reads++; return value; }
        static bool Double(double value) => value is D;
        static bool Float(float value) => value is F;
        static bool NullableDouble(double? value) => value is D;
        static bool NullableFloat(float? value) => value is F;
        static bool Not(double? value) => value is not D;
        static bool Either(double? value) => value is D or 1.0;
        static bool Wide(double? value) => value is F;
        static bool NotWide(double? value) => value is not F;
        static bool BoxDouble(object? value) => value is D;
        static bool BoxFloat(object? value) => value is F;
        static bool Once(double? value) => Read(value) is D;
        public static string Run() =>
            Double(D) + " " + Double(1) + " " + Float(F) + " " + Float(1f) + " " +
            NullableDouble(D) + " " + NullableDouble(null) + " " + NullableFloat(F) + " " + NullableFloat(null) + " " +
            Not(D) + " " + Not(1) + " " + Not(null) + " " +
            BoxDouble(D) + " " + BoxDouble(F) + " " + BoxFloat(F) + " " + BoxFloat(D) + " " +
            BoxDouble(new Pretender()) + " " + Pretender.Calls + " " + Once(D) + " " + Once(null) + " " + reads + " " +
            Either(D) + " " + Either(1.0) + " " + Either(null) + " " +
            Wide(D) + " " + Wide(null) + " " + NotWide(D) + " " + NotWide(null);
    }
}`, "True False True False True False True False False True True True False True False False 0 True False 2 True True False True False False True")
    }
}
