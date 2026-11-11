// <copyright file="Issue5935NullableValueReceiverTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Xunit

class Issue5935NullableValueReceiverTests {
    @Theory
    @InlineData("", "97|0|97|0")
    @InlineData("'z'", "97|0|97|122")
    func ConditionalStringIndex_PreservesNullableMethodReceiver(argument string, expected string) {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static char Guarded(string? s)
        {
            if (s != null)
            {
                var c = s?[0];
                return c.GetValueOrDefault(ARGUMENT);
            }
            return '\0';
        }
        static char Read(string? s)
        {
            var c = s?[0];
            return c.GetValueOrDefault(ARGUMENT);
        }
        public static string Run() =>
            (int)Guarded("a") + "|" + (int)Guarded(null) + "|" + (int)Read("a") + "|" + (int)Read(null);
    }
}`.Replace("ARGUMENT", argument), expected, rejectRedundantAssertions: true)
    }

    @Fact
    func ConditionalListIndex_PreservesNullableMethodReceiver() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System.Collections.Generic;
namespace Demo
{
    public static class P
    {
        static int Read(List<int>? list)
        {
            var n = list?[0];
            return n.GetValueOrDefault();
        }
        public static string Run() => Read(new List<int> { 7 }) + "|" + Read(null);
    }
}`, "7|0", rejectRedundantAssertions: true)
    }

    @Theory
    @InlineData("value.GetValueOrDefault() + \"\"", "7|0")
    @InlineData("value.GetValueOrDefault(9) + \"\"", "7|9")
    @InlineData("value.HasValue + \"\"", "True|False")
    @InlineData("value.Value + \"\"", "7|empty")
    @InlineData("value.ToString() + \"\"", "7|")
    @InlineData("value.Equals(null) + \":\" + value.Equals(7)", "False:True|True:False")
    @InlineData("value.GetHashCode() + \"\"", "7|0")
    @InlineData("value.GetType().Name", "Int32|null")
    func NullableMembers_PreserveParameterLocalAndFieldSemantics(expression string, expectedPair string) {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
using System.Collections.Generic;
namespace Demo
{
    public static class P
    {
        static int? value;
        static string Parameter(int? value)
        {
            try { return EXPRESSION; }
            catch (InvalidOperationException) { return "empty"; }
            catch (NullReferenceException) { return "null"; }
        }
        static string Local(int? input)
        {
            List<int>? list = input.HasValue ? new List<int> { input.GetValueOrDefault() } : null;
            var value = list?[0];
            try { return EXPRESSION; }
            catch (InvalidOperationException) { return "empty"; }
            catch (NullReferenceException) { return "null"; }
        }
        static string Field(int? input)
        {
            value = input;
            try { return EXPRESSION; }
            catch (InvalidOperationException) { return "empty"; }
            catch (NullReferenceException) { return "null"; }
        }
        public static string Run() =>
            Parameter(7) + "|" + Parameter(null) + "/" +
            Local(7) + "|" + Local(null) + "/" +
            Field(7) + "|" + Field(null);
    }
}`.Replace(
                "EXPRESSION",
                expression
            ), expectedPair + "/" + expectedPair + "/" + expectedPair, rejectRedundantAssertions: true)
    }

    @Fact
    func ExtensionAndReferenceReceivers_KeepTheirDeclaredContracts() {
        Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System.Collections.Generic;
namespace Demo
{
    public static class Extensions
    {
        public static string Describe(this int value) => "unwrapped";
        public static string Describe(this int? value) => value.HasValue ? "present" : "missing";
        public static bool Missing<T>(this T value) => value is null;
        public static string Describe(this string? value) => value == null ? "missing" : value;
    }
    public class Box { public string? Text; }
    public static class P
    {
        static string Read(List<int>? list)
        {
            var n = list?[0];
            return n.Describe() + ":" + n.Missing();
        }
        static int Length(Box box)
        {
            if (box.Text != null) return box.Text.Length;
            return 0;
        }
        public static string Run()
        {
            string? text = null;
            return Read(new List<int> { 7 }) + "|" + Read(null) + "|" + text.Describe() + "|" +
                Length(new Box { Text = "abc" }) + "|" + Length(new Box());
        }
    }
}`, "present:False|missing:True|missing|3|0", rejectRedundantAssertions: true)
    }
}
