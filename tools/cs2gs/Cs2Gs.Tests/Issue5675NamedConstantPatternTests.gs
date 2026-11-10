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

    @Fact
    func SemanticNullConstants_DoNotInvokeUserEquality() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class C
    {
        public static int Calls;
        public static bool operator ==(C? left, C? right) { Calls++; return true; }
        public static bool operator !=(C? left, C? right) { Calls++; return false; }
        public override bool Equals(object? other) { Calls++; return true; }
        public override int GetHashCode() => 7;
    }
    public static class P
    {
        static bool Match(C? value) => value is default(C);
        static bool Not(C? value) => value is not default(C);
        static int Read(C? value) => value is not default(C) ? value.GetHashCode() : 0;
        public static string Run() =>
            Match(null) + " " + Match(new C()) + " " + Not(null) + " " + Not(new C()) + " " +
            Read(null) + " " + Read(new C()) + " " + C.Calls;
    }
}`, "True False False True 0 7 0")
    }

    @Fact
    func NamedClassNullConstant_NormalizesTheOperand() {
        let printed = LocalFunctionHoistTranslationTests.TranslateUnit(`
#nullable enable
namespace Demo
{
    public class C { }
    public static class P
    {
        const C? Nil = null;
        public static bool Match(C? value) => value is Nil;
    }
}`, roundTripOnlyReason: "#5825 blocks source-class null const declarations; this mapping-only test pins the operand.")
        Assert.Contains("object.Equals(nil, value)", printed)
    }

    @Fact
    func AndPatterns_ConvertConstantsToTheBoundLeafInput() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public static class P
    {
        const int K = 3;
        static bool Long(object? value) => value is long and K;
        static bool Byte(object? value) => value is byte and K;
        static bool Double(object? value) => value is double and K;
        static bool Nested(object? value) => value is long and (K or 4);
        static int Loop(ref string? text, object? value)
        {
            if (text == null) return 0;
            for (int i = 0; i < 1; i++) { if (value is long and K) return text.Length; }
            return 0;
        }
        public static string Run()
        {
            string? text = "abc";
            return Long(3L) + " " + Long(4L) + " " + Long(3) + " " + Long(null) + " " +
                Byte((byte)3) + " " + Byte((byte)4) + " " +
                Double(3.0) + " " + Double(4.0) + " " + Double(3) + " " +
                Nested(4L) + " " + Nested(null) + " " + Loop(ref text, 3L) + " " + Loop(ref text, 3);
        }
    }
}`, "True False False False True False True False False True False 3 0")
    }

    @Fact
    func NestedTypedNaNPattern_CapturesTheGetterOnce() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class B { public double Number; }
    public class Holder
    {
        readonly object child;
        public int Reads;
        public Holder(object child) { this.child = child; }
        public object Child { get { Reads++; return child; } }
    }
    public static class P
    {
        static bool Match(Holder value) => value is { Child: B { Number: double.NaN } };
        static string Test(object child)
        {
            var value = new Holder(child);
            bool hit = Match(value);
            return hit + " " + value.Reads;
        }
        public static string Run() => Test(new B { Number = double.NaN }) + " / " +
            Test(new B { Number = 1.0 }) + " / " + Test(new object());
    }
}`, "True 1 / False 1 / False 1")
    }

    @Fact
    func InterfaceAndGenericConstants_PreserveBoxedTypesAndNil() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public static class P
    {
        const int K = 3;
        const string Key = "key";
        static bool Interface(IConvertible? value) => value is K;
        static bool Either(IConvertible? value) => value is K or 4;
        static bool Generic<T>(T value) => value is K;
        static bool GenericEither<T>(T value) => value is K or 4;
        static bool Text(IComparable? value) => value is Key;
        public static string Run() =>
            Interface(3) + " " + Interface(4) + " " + Interface(3L) + " " + Interface(null) + " " +
            Either(3) + " " + Either(4) + " " + Either(3L) + " " + Either(null) + " " +
            Generic(3) + " " + Generic(4) + " " + Generic(3L) + " " + Generic<int?>(3) + " " + Generic<int?>(null) + " " +
            GenericEither(4) + " " + GenericEither(3L) + " " + GenericEither<string?>(null) + " " +
            Text(new string(new[] { 'k', 'e', 'y' })) + " " + Text(3) + " " + Text(null);
    }
}`, "True False False False True True False False True False False True False True False False True False False")
    }

    @Fact
    func NullableListFallback_RejectsNilBeforeReadingElements() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int reads;
        static object[]? Read(object[]? value) { reads++; return value; }
        static string Test(object[]? value)
        {
            reads = 0;
            bool hit = Read(value) is [3];
            return hit + " " + reads;
        }
        public static string Run() => Test(null) + " / " + Test(new object[0]) + " / " +
            Test(new object[] { 3 }) + " / " + Test(new object[] { 3L });
    }
}`, "False 1 / False 1 / True 1 / False 1")
    }

    @Fact
    func UnqualifiedPropertyCombinator_ReadsTheScrutineeOnce() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class Probe
    {
        public int Reads;
        public object Value { get { Reads++; return Reads == 1 ? 4 : 3; } }
        public bool Match() => Value is 3 or 4;
    }
    public static class P
    {
        public static string Run()
        {
            var value = new Probe();
            bool hit = value.Match();
            return hit + " " + value.Reads;
        }
    }
}`, "True 1")
    }

    @Fact
    func MixedFallback_CapturesUnstableSiblingInputs() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class Holder
    {
        public int Reads;
        public int P { get { Reads++; return Reads == 1 ? 2 : 0; } }
        public object Q = 3;
    }
    public static class P
    {
        static int reads;
        static Holder Read(Holder value) { reads++; return value; }
        static bool Match(Holder value) => Read(value) is { P: 1 or 2, Q: 3 };
        public static string Run()
        {
            var value = new Holder();
            bool hit = Match(value);
            return hit + " " + value.Reads + " " + reads;
        }
    }
}`, "True 1 1")
    }

    @Fact
    func NegatedAndConstants_UseTheBoundLeafInput() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public static class P
    {
        const int K = 3;
        static bool Match(object? value) => value is long and not K;
        static bool Nested(object? value) => value is long and not (K or 4);
        public static string Run() => Match(3L) + " " + Match(4L) + " " + Match(3) + " " + Match(null) + " " +
            Nested(5L) + " " + Nested(3L) + " " + Nested(4L) + " " + Nested(null);
    }
}`, "False True False False True False False False")
    }

    @Fact
    func NegatedNestedGuard_SnapshotsImplicitGetter() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class Row
    {
        public object Tag => 3;
        public object Item => 7;
    }
    public class Probe
    {
        public int Reads;
        public Row Value { get { Reads++; return new Row(); } }
        public int Match()
        {
            if (Value is not { Tag: 3, Item: int item }) return -1;
            return item;
        }
    }
    public static class P
    {
        public static string Run()
        {
            var value = new Probe();
            return value.Match() + " " + value.Reads;
        }
    }
}`, "7 1")
    }

    @Fact
    func ListFallback_SnapshotsTypedElementsAndMutatedSlots() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class B
    {
        public double Number => double.NaN;
    }
    public class C
    {
        public object[] Slots = new object[0];
        public object A { get { Slots[0] = new object(); return 1; } }
        public object B => 3;
    }
    public static class P
    {
        static object[] Read() => new object[] { new B() };
        public static string Run()
        {
            var child = new C();
            child.Slots = new object[] { child };
            bool typed = Read() is [B { Number: double.NaN }];
            bool changed = child.Slots is [C { A: 1, B: 3 }];
            return typed + " " + changed;
        }
    }
}`, "True True")
    }

    @Fact
    func PatternSnapshot_PreservesEagerOperandAndArgumentOrder() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class Probe
    {
        object current = 0;
        public string Log = "";
        object Value { get { Log += "V"; return current; } }
        bool Advance() { Log += "A"; current = 4; return true; }
        static bool Both(bool left, bool right) => left & right;
        public bool Eager() => Advance() & (Value is 3 or 4);
        public bool Argument() => Both(Advance(), Value is 3 or 4);
    }
    public static class P
    {
        public static string Run()
        {
            var first = new Probe();
            var second = new Probe();
            return first.Eager() + " " + first.Log + " " + second.Argument() + " " + second.Log;
        }
    }
}`, "True AV True AV")
    }

    @Fact
    func TypedSwitch_ExtendedVarLeafReusesEarlierSharedPrefix() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class Child
    {
        public object X => 3;
        public object Y = 4;
    }
    public class Holder
    {
        public int Reads;
        public Child Child { get { Reads++; return new Child { Y = Reads == 1 ? 4 : 9 }; } }
    }
    public static class P
    {
        static int Match(object value) => value switch
        {
            Holder { Child.X: 3, Child.Y: var y } => (int)y,
            _ => -1,
        };
        public static string Run()
        {
            var value = new Holder();
            return Match(value) + " " + value.Reads;
        }
    }
}`, "4 1")
    }

    @Fact
    func SharedPrefixCaptures_OutliveEarlierBindingStorageBlocks() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class Q
    {
        public object X => 3;
        public object Y => 4;
    }
    public class Middle { public Q Q = new Q(); }
    public class Row { public Middle? P = new Middle(); }
    public static class P
    {
        public static string Run()
        {
            var value = new Row();
            if (value is { P.Q.X: int x, P.Q.Y: 4 }) return x.ToString();
            return "-1";
        }
    }
}`, "3")
    }

    @Fact
    func SharedPrefixCaptures_OutliveRootSnapshotAndEscapeToConditionalArm() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class Q
    {
        public static int Reads;
        public object X => 3;
        public object Y { get { Reads++; return 4; } }
    }
    public class Middle { public Q Q = new Q(); }
    public class Row { public Middle? P = new Middle(); }
    public static class P
    {
        static Row Read() => new Row();
        public static string Run() =>
            (Read() is { P.Q.X: 3, P.Q.Y: int y } ? y : -1) + " " + Q.Reads;
    }
}`, "4 1")
    }

    @Fact
    func ExtendedPropertyFallback_ReusesCommonGetterPrefix() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class Child
    {
        public object X => 3;
        public object Y => 4;
    }
    public class Holder
    {
        public int Reads;
        public Child? Child { get { Reads++; return Reads == 1 ? new Child() : null; } }
    }
    public static class P
    {
        static Holder Read(Holder value) => value;
        public static string Run()
        {
            var value = new Holder();
            return (Read(value) is { Child.X: 3, Child.Y: 4 }) + " " + value.Reads;
        }
    }
}`, "True 1")
    }

    @Fact
    func NestedTypedFallback_ClosureAssignedSubjectMatchesCSharp() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public class B
    {
        public Action? OnRead;
        public int A { get { OnRead?.Invoke(); return 1; } }
    }
    public class Row
    {
        public object Child = new B();
        public object Tag = 3;
    }
    public static class P
    {
        public static string Run()
        {
            var current = new Row();
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Tag = 0 }; };
            if (current is { Child: B { A: 1 }, Tag: 3 })
            {
                return "True " + current.Tag;
            }
            return "False " + current.Tag;
        }
    }
}`, "False 0")
    }

    @Fact
    func BindingPatternSnapshot_PreservesEagerOperandAndArgumentOrder() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class Row
    {
        public object Tag;
        public object Item;
        public Row(int value) { Tag = value; Item = 7; }
    }
    public class Probe
    {
        Row current = new Row(0);
        public string Log = "";
        Row Value { get { Log += "V"; return current; } }
        bool Advance() { Log += "A"; current = new Row(3); return true; }
        static bool Both(bool left, bool right) => left & right;
        public bool Eager() => Advance() & (Value is { Tag: 3, Item: int n });
        public bool Argument() => Both(Advance(), Value is { Tag: 3, Item: int n });
    }
    public static class P
    {
        public static string Run()
        {
            var first = new Probe();
            var second = new Probe();
            return first.Eager() + " " + first.Log + " " + second.Argument() + " " + second.Log;
        }
    }
}`, "True AV True AV")
    }

    @Fact
    func NestedFallback_SnapshotsMutableAutoProperty() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public class Holder
    {
        public Child Child { get; set; } = new Child();
    }
    public class Child
    {
        public Holder? Owner;
        public object Value = 3;
        public object A
        {
            get
            {
                if (Owner != null) Owner.Child = new Child { Value = 0 };
                return 1;
            }
        }
        public object B => Value;
    }
    public static class P
    {
        static Holder Read(Holder value) => value;
        public static string Run()
        {
            var value = new Holder();
            value.Child.Owner = value;
            return (Read(value) is { Child: { A: 1, B: 3 } }) + " " + value.Child.Value;
        }
    }
}`, "True 0")
    }

    @Fact
    func ObliviousListFallback_GuardsPromotedNullableReceiver() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable disable
namespace Demo
{
    public static class P
    {
        static object[] Read() => null;
        public static string Run() => (Read() is [3]).ToString();
    }
}`, "False")
    }

    @Fact
    func MixedNativeBindingCondition_DoesNotHoistSkippedFallback() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public class Probe
    {
        public int Reads;
        object Value { get { Reads++; throw new InvalidOperationException("unexpected getter"); } }
        public bool Match(bool guard, object other) => guard && (Value is 3 or 4) && other is int n && n > 0;
    }
    public static class P
    {
        public static string Run()
        {
            var value = new Probe();
            return value.Match(false, 1) + " " + value.Reads;
        }
    }
}`, "False 0")
    }

    @Fact
    func PropertySnapshots_StayBehindShortCircuitGuards() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public class Probe
    {
        public int Reads;
        public object Value { get { Reads++; throw new InvalidOperationException("unexpected getter"); } }
        public bool And(bool guard) => guard && (Value is 3 or 4);
        public bool Or(bool guard) => guard || (Value is 3 or 4);
    }
    public static class P
    {
        public static string Run()
        {
            var value = new Probe();
            bool first = value.And(false);
            bool second = value.Or(true);
            return first + " " + second + " " + value.Reads;
        }
    }
}`, "False True 0")
    }

    @Fact
    func Issue5837_ExactRepro_UnusedDesignationClosureAssignedSubject_MatchesCSharpOracle() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public class B
    {
        public Action? OnRead;
        public int A { get { OnRead?.Invoke(); return 1; } }
    }
    public class Row
    {
        public object Child = new B();
        public object Tag = 3;
    }
    public static class P
    {
        public static string Run()
        {
            var current = new Row();
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Tag = 0 }; };
            if (current is { Child: B { A: 1 }, Tag: 3 } matched)
                return "True " + current.Tag;
            return "False " + current.Tag;
        }
    }
}`, "False 0", rejectRedundantAssertions: true)
    }

    @Fact
    func Issue5837_ClosureAssignedSubjectWithPatternDesignation_MatchesCSharpOracle() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public class B
    {
        public Action? OnRead;
        public int A { get { OnRead?.Invoke(); return 1; } }
    }
    public class BaseRow
    {
        public int Id = 1;
    }
    public class Row : BaseRow
    {
        public object Child = new B();
        public object Tag = 3;
        public int IntTag = 3;
    }
    public static class P
    {
        static string UnusedObjectDesignation()
        {
            var current = new Row();
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Tag = 0 }; };
            if (current is { Child: B { A: 1 }, Tag: 3 } matched)
                return "True " + current.Tag;
            return "False " + current.Tag;
        }
        static string UsedObjectDesignation(int nextTag, bool mutateInBody)
        {
            var current = new Row { Id = 1, Tag = 3 };
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Id = 2, Tag = nextTag }; };
            if (current is { Child: B { A: 1 }, Tag: 3 } matched)
            {
                if (mutateInBody) current = new Row { Id = 99, Tag = 99 };
                return "True " + current.Id + " " + matched.Id;
            }
            return "False " + current.Tag;
        }
        static string IntMemberPatterns(int nextTag, bool useBinder)
        {
            var current = new Row { Id = 1, IntTag = 3 };
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Id = 2, IntTag = nextTag }; };
            if (!useBinder)
            {
                if (current is { Child: B { A: 1 }, IntTag: 3 })
                    return "True " + current.IntTag;
                return "False " + current.IntTag;
            }
            if (current is { Child: B { A: 1 }, IntTag: 3 } matched)
                return "True " + current.Id + " " + matched.Id;
            return "False " + current.IntTag;
        }
        static string TypedSameStaticType(int nextTag)
        {
            var current = new Row { Id = 1, Tag = 3 };
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Id = 2, Tag = nextTag }; };
            if (current is Row { Child: B { A: 1 }, Tag: 3 } matched)
            {
                current = new Row { Id = 99, Tag = 99 };
                return "True " + current.Id + " " + matched.Id;
            }
            return "False " + current.Tag;
        }
        static string TypedDowncastFromBase()
        {
            var initial = new Row { Id = 1, Tag = 3 };
            var child = new B();
            initial.Child = child;
            BaseRow current = initial;
            child.OnRead = () => { current = new Row { Id = 2, Tag = 0 }; };
            if (current is Row { Child: B { A: 1 }, Tag: 3 } matched)
                return "True " + current.Id + " " + matched.Id;
            return "False " + current.Id;
        }
        static string NullableSubject(int nextTag)
        {
            Row? current = new Row { Id = 1, Tag = 3 };
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Id = 2, Tag = nextTag }; };
            if (current is { Child: B { A: 1 }, Tag: 3 } matched)
                return "True " + current!.Id + " " + matched.Id;
            return "False " + current!.Tag;
        }
        public static string Run() =>
            UnusedObjectDesignation() + " / " +
            UsedObjectDesignation(0, false) + " / " +
            UsedObjectDesignation(3, false) + " / " +
            UsedObjectDesignation(3, true) + " / " +
            IntMemberPatterns(0, false) + " / " +
            IntMemberPatterns(0, true) + " / " +
            IntMemberPatterns(3, true) + " / " +
            TypedSameStaticType(0) + " / " +
            TypedSameStaticType(3) + " / " +
            TypedDowncastFromBase() + " / " +
            NullableSubject(0) + " / " +
            NullableSubject(3);
    }
}`, "False 0 / False 0 / True 2 2 / True 99 2 / False 0 / False 0 / True 2 2 / False 0 / True 99 2 / True 2 1 / False 0 / True 2 2", rejectRedundantAssertions: true)
    }

    @Fact
    func Issue5837_ClosureAssignedSubjectAcrossControlFlowAndSwitchSurfaces_MatchesCSharpOracle() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public class Expected { }
    public class B
    {
        public Action? OnRead;
        public int A { get { OnRead?.Invoke(); return 1; } }
    }
    public class Row
    {
        public int Id = 1;
        public object Child = new B();
        public object Tag = 3;
    }
    public static class P
    {
        const int Expected = 3;
        static Row ReadRow() => new Row { Id = 7, Tag = 3 };
        static string NegatedGuard(int nextTag)
        {
            var current = new Row { Id = 1, Tag = 3 };
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Id = 2, Tag = nextTag }; };
            if (current is not { Child: B { A: 1 }, Tag: 3 } matched)
                return "NotMatched " + current.Tag;
            return "Matched " + current.Id + " " + matched.Id;
        }
        static string Conditional(int nextTag)
        {
            var current = new Row { Id = 1, Tag = 3 };
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Id = 2, Tag = nextTag }; };
            return current is { Child: B { A: 1 }, Tag: 3 } matched
                ? "True " + current.Id + " " + matched.Id
                : "False " + current.Tag;
        }
        static string Loop(int nextTag)
        {
            var current = new Row { Id = 1, Tag = 3 };
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Id = 2, Tag = nextTag }; };
            while (current is { Child: B { A: 1 }, Tag: 3 } matched)
                return "True " + current.Id + " " + matched.Id;
            return "False " + current.Tag;
        }
        static string SwitchExpr(int nextTag)
        {
            var current = new Row { Id = 1, Tag = 3 };
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Id = 2, Tag = nextTag }; };
            return current switch
            {
                { Child: B { A: 1 }, Tag: 3 } matched => "True " + current.Id + " " + matched.Id,
                _ => "False " + current.Tag,
            };
        }
        static string NamedConstResidual(int nextTag)
        {
            var current = new Row { Id = 1, Tag = 3 };
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Id = 2, Tag = nextTag }; };
            if (current is { Child: B { A: 1 }, Tag: Expected } matched)
                return "Const " + current.Id + " " + matched.Id;
            return "None " + current.Tag;
        }
        public static string Run() =>
            NegatedGuard(0) + " / " +
            NegatedGuard(3) + " / " +
            Conditional(0) + " / " +
            Conditional(3) + " / " +
            Loop(0) + " / " +
            Loop(3) + " / " +
            SwitchExpr(0) + " / " +
            SwitchExpr(3) + " / " +
            NamedConstResidual(0) + " / " +
            NamedConstResidual(3);
    }
}`, "NotMatched 0 / Matched 2 2 / False 0 / True 2 2 / False 0 / True 2 2 / False 0 / True 2 2 / None 0 / Const 2 2", rejectRedundantAssertions: true)
    }

    @Fact
    func Issue5837_LoopDowncastNullableClearedStructAndSwitchWhenGuard_MatchCSharpOracle() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public class B
    {
        public Action? OnRead;
        public int A { get { OnRead?.Invoke(); return 1; } }
    }
    public interface IExplicitRow
    {
        int ExplicitA { get; }
        object Tag { get; }
    }
    public class BaseRow
    {
        public int Id = 1;
    }
    public class Row : BaseRow, IExplicitRow
    {
        public Action? OnRead;
        public int A { get { OnRead?.Invoke(); return 1; } }
        int IExplicitRow.ExplicitA { get { OnRead?.Invoke(); return 1; } }
        public object Child = new B();
        public B TypedChild = new B();
        public object Tag = 3;
        public object BaseTag { get => Tag; set => Tag = value; }
        object IExplicitRow.Tag => Tag;
    }
    public class DerivedRow : Row
    {
        public new object Tag = 99;
    }
    public struct StructRow
    {
        public int Id;
        public object Child;
        public object Tag;
    }
    public static class P
    {
        static string LoopTypedDowncast()
        {
            var initial = new Row { Id = 1, Tag = 3 };
            var child = new B();
            initial.Child = child;
            BaseRow current = initial;
            child.OnRead = () => { current = new Row { Id = 2, Tag = 0 }; };
            while (current is Row { Child: B { A: 1 }, Tag: 3 } matched)
                return "True " + current.Id + " " + matched.Id;
            return "False " + current.Id;
        }
        static string LoopNullableSubject()
        {
            Row? current = new Row { Id = 1, Tag = 3 };
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Id = 2, Tag = 3 }; };
            while (current is { Child: B { A: 1 }, Tag: 3 } matched)
                return "True " + current!.Id + " " + matched.Id;
            return "False";
        }
        static string NullableSubjectClearedOnSingleProperty()
        {
            Row? current = new Row { Id = 1 };
            current.OnRead = () => { current = null; };
            if (current is { A: 1 } matched)
                return "True " + (matched == null ? "null" : matched.Id.ToString());
            return "False";
        }
        static string NullableSubjectClearedOnLastProperty()
        {
            Row? current = new Row { Id = 1, Tag = 3 };
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = null; };
            if (current is { Tag: 3, Child: B { A: 1 } } matched)
                return "True " + (matched == null ? "null" : matched.Id.ToString());
            return "False";
        }
        static string NullableStructSubject()
        {
            var child = new B();
            StructRow? current = new StructRow { Id = 1, Child = child, Tag = 3 };
            child.OnRead = () => { current = new StructRow { Id = 2, Child = child, Tag = 0 }; };
            if (current is { Child: B { A: 1 }, Tag: 3 } matched)
                return "True " + current.Value.Tag + " " + matched.Id;
            return "False " + current.Value.Tag;
        }
        static string NonNullableStructSubject()
        {
            var child = new B();
            StructRow current = new StructRow { Id = 1, Child = child, Tag = 3 };
            child.OnRead = () => { current = new StructRow { Id = 2, Child = child, Tag = 0 }; };
            if (current is { Child: B { A: 1 }, Tag: 3 } matched)
                return "True " + current.Tag + " " + matched.Id;
            return "False " + current.Tag;
        }
        static string SwitchExprWithWhenGuard()
        {
            var current = new Row { Id = 2, Tag = 3 };
            var child = new B();
            current.Child = child;
            bool ResetCurrent() { current = new Row { Id = 99, Tag = 99 }; return true; }
            return current switch
            {
                { Child: B { A: 1 }, Tag: 3 } matched when matched.Id == 2 && ResetCurrent() => "True " + current.Id + " " + matched.Id,
                _ => "False",
            };
        }
        static bool NegatedGuardClearedToNull()
        {
            Row? current = new Row { Id = 1 };
            current.OnRead = () => { current = null; };
            if (current is not { A: 1 } matched)
                return false;
            return object.ReferenceEquals(matched, null);
        }
        static string BinaryAndLeftTypeCapture()
        {
            var initial = new Row { Id = 1, Tag = 3 };
            BaseRow current = initial;
            initial.OnRead = () => { current = new Row { Id = 2, Tag = 0 }; };
            if (current is Row matched and { A: 1, Tag: 3 })
                return "True " + current.Id + " " + matched.Id;
            return "False " + current.Id;
        }
        static string ParenthesizedSwitchSubjectWithWhenGuard()
        {
            var current = new Row { Id = 2, Tag = 3 };
            var child = new B();
            current.Child = child;
            bool ResetCurrent() { current = new Row { Id = 99, Tag = 99 }; return true; }
            return (current) switch
            {
                { Child: B { A: 1 }, Tag: 3 } matched when matched.Id == 2 && ResetCurrent() => "True " + current.Id + " " + matched.Id,
                _ => "False",
            };
        }
        static int SwitchArmNullableClearedReassigned()
        {
            Row? current = new Row { Id = 1 };
            current.OnRead = () => { current = null; };
            return current switch
            {
                { A: 1 } matched => (matched = new Row { Id = 7 }).Id,
                _ => -1,
            };
        }
        static string LoopBinaryAndLeftTypeCapture()
        {
            var initial = new Row { Id = 1, Tag = 3 };
            BaseRow current = initial;
            initial.OnRead = () => { current = new Row { Id = 2, Tag = 0 }; };
            while (current is Row matched and { A: 1, Tag: 3 })
                return "True " + current.Id + " " + matched.Id;
            return "False " + current.Id;
        }
        static string BinaryAndParenthesizedLeftTypeCapture()
        {
            var initial = new Row { Id = 1, Tag = 3 };
            BaseRow current = initial;
            initial.OnRead = () => { current = new Row { Id = 2, Tag = 0 }; };
            if (current is (Row matched) and { A: 1, Tag: 3 })
                return "True " + current.Id + " " + matched.Id;
            return "False " + current.Id;
        }
        static string BinaryAndChainedLeftTypeCapture()
        {
            var initial = new Row { Id = 1, Tag = 3 };
            BaseRow current = initial;
            initial.OnRead = () => { current = new Row { Id = 2, Tag = 0 }; };
            if (current is Row matched and { A: 1 } and { Tag: 3 })
                return "True " + current.Id + " " + matched.Id;
            return "False " + current.Id;
        }
        static string ParenthesizedSubjectUnusedDesignation()
        {
            var current = new Row();
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Tag = 0 }; };
            if ((current) is { Child: B { A: 1 }, Tag: 3 } matched)
                return "True " + current.Tag;
            return "False " + current.Tag;
        }
        static string ExplicitInterfaceRecursive(int nextTag)
        {
            var current = new Row { Id = 1, Tag = 3 };
            current.OnRead = () => { current = new Row { Id = 2, Tag = nextTag }; };
            if (current is IExplicitRow { ExplicitA: 1, Tag: 3 } matched)
                return "True " + current.Id + " " + ((Row)matched).Id;
            return "False " + current.Id;
        }
        static string ExplicitInterfaceAnd(int nextTag)
        {
            var current = new Row { Id = 1, Tag = 3 };
            current.OnRead = () => { current = new Row { Id = 2, Tag = nextTag }; };
            if (current is IExplicitRow matched and { ExplicitA: 1, Tag: 3 })
                return "True " + current.Id + " " + ((Row)matched).Id;
            return "False " + current.Id;
        }
        static string CompoundOrAndConversionCapture()
        {
            var initial = new Row { Id = 1, Tag = 3 };
            BaseRow current = initial;
            initial.OnRead = () => { current = new Row { Id = 9, Tag = 0 }; };
            if (current is (Row { Id: 1 } or Row { Id: 2 }) and { A: 1, Tag: 3 } matched)
                return "True " + current.Id + " " + matched.Id;
            return "False " + current.Id;
        }
        static string LoopTypedNullableSubjectClearedInConjunction()
        {
            Row? current = new Row { Id = 1 };
            current.OnRead = () => { current = null; };
            while (current is Row { A: 1 } matched && matched == null)
                return "True";
            return "False";
        }
        static string LoopMultipleWholeValueBindersClearedToNull()
        {
            Row? current = new Row { Id = 1 };
            current.OnRead = () => { current = null; };
            while (current is { A: 1 } first and var second)
                return "True " + (first == null ? "null" : first.Id.ToString()) + " " + (second == null ? "null" : second.Id.ToString());
            return "False";
        }
        static string SuppressedSubjectUnusedDesignation()
        {
            var current = new Row();
            var child = new B();
            current.Child = child;
            child.OnRead = () => { current = new Row { Tag = 0 }; };
            if (current! is { Child: B { A: 1 }, Tag: 3 } matched)
                return "True " + current.Tag;
            return "False " + current.Tag;
        }
        static string IfTypedNullableSubjectClearedInConjunction()
        {
            Row? current = new Row { Id = 1 };
            current.OnRead = () => { current = null; };
            if (current is Row { A: 1 } matched && matched == null)
                return "True";
            return "False";
        }
        static string HiddenBaseRecursive(int nextBaseTag)
        {
            var current = new DerivedRow { Id = 1, Tag = 99 };
            current.BaseTag = 3;
            current.OnRead = () =>
            {
                var next = new DerivedRow { Id = 2, Tag = 3 };
                next.BaseTag = nextBaseTag;
                current = next;
            };
            if (current is Row { A: 1, Tag: 3 } matched)
                return "True " + current.Id + " " + matched.Id + " " + matched.Tag + " " + current.Tag;
            return "False " + current.Id + " " + current.BaseTag + " " + current.Tag;
        }
        static string HiddenBaseAnd(int nextBaseTag)
        {
            var current = new DerivedRow { Id = 1, Tag = 99 };
            current.BaseTag = 3;
            current.OnRead = () =>
            {
                var next = new DerivedRow { Id = 2, Tag = 3 };
                next.BaseTag = nextBaseTag;
                current = next;
            };
            if (current is Row matched and { A: 1, Tag: 3 })
                return "True " + current.Id + " " + matched.Id + " " + matched.Tag + " " + current.Tag;
            return "False " + current.Id + " " + current.BaseTag + " " + current.Tag;
        }
        static string DowncastThenBaseRecursive(int initialBaseTag, int nextBaseTag)
        {
            var initial = new DerivedRow { Id = 1, Tag = 99 };
            initial.BaseTag = initialBaseTag;
            BaseRow current = initial;
            initial.OnRead = () =>
            {
                var next = new DerivedRow { Id = 2, Tag = 99 };
                next.BaseTag = nextBaseTag;
                current = next;
            };
            if (current is DerivedRow and Row { A: 1, Tag: 3 } matched)
                return "True " + current.Id + " " + matched.Id + " " + matched.Tag;
            return "False " + current.Id;
        }
        static Row refSlot = new Row();
        static string MatchRefSubject(ref Row current)
        {
            if (current is { Child: B { A: 1 }, Tag: 3 } matched)
                return "True " + current.Id + " " + matched.Id;
            return "False " + current.Tag;
        }
        static string RefParameterSubject(int nextTag)
        {
            refSlot = new Row { Id = 1, Tag = 3 };
            var child = new B();
            refSlot.Child = child;
            child.OnRead = () => { refSlot = new Row { Id = 2, Tag = nextTag }; };
            return MatchRefSubject(ref refSlot);
        }
        static string NullableClearedBeforeAndNotNull()
        {
            Row? first = new Row { Id = 1 };
            first.OnRead = () => { first = null; };
            Row? second = new Row { Id = 1 };
            second.OnRead = () => { second = null; };
            Row? third = new Row { Id = 1 };
            third.OnRead = () => { third = null; };
            Row? fourth = new Row { Id = 1 };
            fourth.OnRead = () => { fourth = null; };
            return (first is { A: 1 } and not null) + " " + (second is { A: 1 } and not (null)) + " " + (third is { A: 1 } and not (null or null)) + " " + (fourth is { A: 1 } and DerivedRow);
        }
        static string HiddenBaseTypedAndTyped(int nextBaseTag)
        {
            var current = new DerivedRow { Id = 1, Tag = 99 };
            current.BaseTag = 3;
            current.OnRead = () =>
            {
                var next = new DerivedRow { Id = 2, Tag = 3 };
                next.BaseTag = nextBaseTag;
                current = next;
            };
            if (current is Row matched and Row { A: 1, Tag: 3 })
                return "True " + current.Id + " " + matched.Id + " " + matched.Tag + " " + current.Tag;
            return "False " + current.Id + " " + current.BaseTag + " " + current.Tag;
        }
        static int SwitchMultiArmClearedToNull()
        {
            Row? current = new Row { Id = 1 };
            current.OnRead = () => { current = null; };
            return current switch
            {
                { A: 0 } => 0,
                { A: 1 } => 1,
                _ => -1,
            };
        }
        static string DelayedCompoundOrAndConversionCapture()
        {
            var initial = new Row { Id = 1, Tag = 3 };
            BaseRow current = initial;
            initial.OnRead = () => { current = new BaseRow { Id = 9 }; };
            if (current is ((not null and Row { A: 1 }) or Row { A: 2 }) and { Tag: 3 } matched)
                return "True " + current.Id + " " + matched.Id;
            return "False " + current.Id;
        }
        static int SwitchTypedMultiArmReplaced()
        {
            var initial = new Row { Id = 1 };
            BaseRow current = initial;
            initial.OnRead = () => { current = new BaseRow { Id = 9 }; };
            return current switch
            {
                Row { A: 0 } => 0,
                Row { A: 1 } => 1,
                _ => -1,
            };
        }
        static int SwitchExtendedPropertyClearedToNull()
        {
            var child = new B();
            Row? current = new Row { Id = 1, TypedChild = child };
            child.OnRead = () => { current = null; };
            return current switch
            {
                { TypedChild.A: 0 } => 0,
                { TypedChild.A: 1 } => 1,
                _ => -1,
            };
        }
        static string BareTypeLeafInDelayedCompoundCapture()
        {
            var initial = new Row { Id = 1, Tag = 3 };
            BaseRow current = initial;
            initial.OnRead = () => { current = new BaseRow { Id = 9 }; };
            if (current is ((not null and DerivedRow { A: 0 }) or Row) and { Tag: 3 } matched)
                return "True " + current.Id + " " + matched.Id;
            return "False " + current.Id;
        }
        static string SwitchCacheSuspendedInWhenAndBody()
        {
            var current = new Row { Id = 1, Tag = 3 };
            var other = new Row { Id = 2, Tag = 0 };
            current.OnRead = () => { current = new Row { Id = 9, Tag = 3 }; };
            return current switch
            {
                { A: 1, Tag: 3 } when other is { Tag: 3 } => "WhenWrong",
                { A: 1, Tag: 3 } => (other is { Tag: 3 }).ToString(),
                _ => "Default",
            };
        }
        static int SwitchAsStatementClearedToNull()
        {
            int recorded = -2;
            int Record(int v) { recorded = v; return v; }
            Row? current = new Row { Id = 1 };
            current.OnRead = () => { current = null; };
            _ = current switch
            {
                { A: 0 } => Record(0),
                { A: 1 } => Record(1),
                _ => Record(-1),
            };
            return recorded;
        }
        public static string Run() =>
            LoopTypedDowncast() + " / " +
            LoopNullableSubject() + " / " +
            NullableSubjectClearedOnSingleProperty() + " / " +
            NullableSubjectClearedOnLastProperty() + " / " +
            NullableStructSubject() + " / " +
            NonNullableStructSubject() + " / " +
            SwitchExprWithWhenGuard() + " / " +
            NegatedGuardClearedToNull() + " / " +
            BinaryAndLeftTypeCapture() + " / " +
            ParenthesizedSwitchSubjectWithWhenGuard() + " / " +
            SwitchArmNullableClearedReassigned() + " / " +
            LoopBinaryAndLeftTypeCapture() + " / " +
            BinaryAndParenthesizedLeftTypeCapture() + " / " +
            BinaryAndChainedLeftTypeCapture() + " / " +
            ParenthesizedSubjectUnusedDesignation() + " / " +
            ExplicitInterfaceRecursive(0) + " / " +
            ExplicitInterfaceRecursive(3) + " / " +
            ExplicitInterfaceAnd(0) + " / " +
            ExplicitInterfaceAnd(3) + " / " +
            CompoundOrAndConversionCapture() + " / " +
            LoopTypedNullableSubjectClearedInConjunction() + " / " +
            LoopMultipleWholeValueBindersClearedToNull() + " / " +
            SuppressedSubjectUnusedDesignation() + " / " +
            IfTypedNullableSubjectClearedInConjunction() + " / " +
            HiddenBaseRecursive(0) + " / " +
            HiddenBaseRecursive(3) + " / " +
            HiddenBaseAnd(0) + " / " +
            HiddenBaseAnd(3) + " / " +
            DowncastThenBaseRecursive(3, 0) + " / " +
            DowncastThenBaseRecursive(0, 3) + " / " +
            RefParameterSubject(0) + " / " +
            RefParameterSubject(3) + " / " +
            NullableClearedBeforeAndNotNull() + " / " +
            HiddenBaseTypedAndTyped(0) + " / " +
            HiddenBaseTypedAndTyped(3) + " / " +
            SwitchMultiArmClearedToNull() + " / " +
            DelayedCompoundOrAndConversionCapture() + " / " +
            SwitchTypedMultiArmReplaced() + " / " +
            SwitchExtendedPropertyClearedToNull() + " / " +
            BareTypeLeafInDelayedCompoundCapture() + " / " +
            SwitchCacheSuspendedInWhenAndBody() + " / " +
            SwitchAsStatementClearedToNull();
    }
}`, "True 2 1 / True 2 2 / True null / True null / True 0 1 / False 0 / True 99 2 / True / True 2 1 / True 99 2 / 7 / True 2 1 / True 2 1 / True 2 1 / False 0 / False 2 / True 2 1 / False 2 / True 2 1 / True 9 1 / True / True null null / False 0 / True / False 2 0 3 / True 2 1 3 3 / False 2 0 3 / True 2 1 3 3 / True 2 1 3 / False 2 / True 2 1 / True 2 1 / True True True False / False 2 0 3 / True 2 1 3 3 / 1 / True 9 1 / 1 / 1 / True 1 1 / False / 1", rejectRedundantAssertions: true)
    }
}
