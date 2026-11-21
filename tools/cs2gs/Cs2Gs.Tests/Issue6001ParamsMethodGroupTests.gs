// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

class Issue6001ParamsMethodGroupTests {
    @Fact
    func ExactRepro_ParamsListMethodGroupField_RunsLikeCSharpAndVerifiesStrictIl() {
        Issue5581ExpandedParamsNullElementsTests.WithTranslation(`
#nullable enable
using System;
using System.Collections.Generic;
public static class P
{
    static int Count(params List<string> items) => items.Count;
    static readonly Func<List<string>, int> callback = Count;
    public static void Main() => Console.Write(callback(new List<string> { "x" }));
}
`, (
                directory string,
                printed string,
                compiled ProcessRunResult
            ) -> {
                Issue5581ExpandedParamsNullElementsTests.AssertSuccessfulTarget(
                    directory,
                    compiled,
                    "1"
                )
                Assert.Contains(
                    "private func Count(items ...List[string]) int32 -> items.Count",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "private let callback(List[string]) -> int32 = Count",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.DoesNotContain(
                    "List[string?]",
                    printed,
                    StringComparison.Ordinal
                )
            }, "1")
    }

    @Fact
    func ParamsCarriers_MethodGroupFieldLocalArgAndExpandedCalls_MatchCSharpAndVerifyStrictIl() {
        Issue5581ExpandedParamsNullElementsTests.WithTranslation(`
#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;

public sealed class Host
{
    private readonly int bias;
    public Host(int bias) => this.bias = bias;
    public int Count(params List<string> items) => bias + items.Count;
}

public static class P
{
    static int CountList(params List<string> items) => items.Count;
    static int CountArr(params int[] items) => items.Length;
    static int CountEnum(params IEnumerable<string> items) => items.Count();
    static int CountGeneric<T>(params List<T> items) => items.Count;
    static int CountOverload(params List<string> items) => items.Count;
    static int CountOverload(int value) => value * 10;

    static readonly Func<List<string>, int> fieldList = CountList;
    static readonly Func<int[], int> fieldArr = CountArr;
    static readonly Func<IEnumerable<string>, int> fieldEnum = CountEnum;
    static readonly Func<List<string>, int> fieldGeneric = CountGeneric<string>;
    static readonly Func<List<string>, int> fieldOverload = CountOverload;

    static int ApplyList(Func<List<string>, int> f) => f(new List<string> { "a", "b" });
    static int ApplyArr(Func<int[], int> f) => f(new[] { 1, 2, 3 });
    static int ApplyEnum(Func<IEnumerable<string>, int> f) => f(new[] { "a", "b", "c", "d" });

    public static void Main()
    {
        Func<List<string>, int> localList = CountList;
        Func<int[], int> localArr = CountArr;
        Func<IEnumerable<string>, int> localEnum = CountEnum;
        Func<List<string>, int> localGeneric = CountGeneric;
        var host = new Host(10);
        Func<List<string>, int> instGroup = host.Count;

        Console.Write(
            fieldList(new List<string> { "x" }) + "," +
            localList(new List<string> { "x", "y" }) + "," +
            ApplyList(CountList) + "," +
            CountList("a", "b") + "," +
            CountList() + "|" +
            fieldArr(new[] { 1 }) + "," +
            localArr(new[] { 1, 2 }) + "," +
            ApplyArr(CountArr) + "," +
            CountArr(1, 2, 3, 4) + "," +
            CountArr() + "|" +
            fieldEnum(new[] { "x" }) + "," +
            localEnum(new[] { "x", "y" }) + "," +
            ApplyEnum(CountEnum) + "," +
            CountEnum("a", "b") + "," +
            CountEnum() + "|" +
            fieldGeneric(new List<string> { "x" }) + "," +
            localGeneric(new List<string> { "x", "y" }) + "|" +
            fieldOverload(new List<string> { "x" }) + "," +
            CountOverload(5) + "|" +
            instGroup(new List<string> { "x" }) + "," +
            ApplyList(host.Count)
        );
    }
}
`, (
                directory string,
                printed string,
                compiled ProcessRunResult
            ) -> {
                let expected = "1,2,2,2,0|1,2,3,4,0|1,2,4,2,0|1,2|1,50|11,12"
                Issue5581ExpandedParamsNullElementsTests.AssertSuccessfulTarget(
                    directory,
                    compiled,
                    expected
                )
                let compact = Regex.Replace(
                    printed,
                    `\s+`,
                    string.Empty
                )
                Assert.Contains(
                    "private let fieldList(List[string]) -> int32 = CountList",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "private let fieldArr([]int32) -> int32 = CountArr",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "private let fieldEnum(IEnumerable[string]) -> int32 = CountEnum",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "ApplyList(CountList)",
                    compact,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "ApplyArr(CountArr)",
                    compact,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "ApplyEnum(CountEnum)",
                    compact,
                    StringComparison.Ordinal
                )
                Assert.DoesNotContain(
                    "List[string?]",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.DoesNotContain(
                    "IEnumerable[string?]",
                    printed,
                    StringComparison.Ordinal
                )
            }, "1,2,2,2,0|1,2,3,4,0|1,2,4,2,0|1,2|1,50|11,12")
    }

    @Fact
    func UnknownMethodGroupConsumer_DoesNotAuthorizeNullableElementWidening() {
        Issue5581ExpandedParamsNullElementsTests.WithTranslation(`
#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;

public static class P
{
    static int CountList(params List<string> items) => items.Count;
    static int ForwardList(string value) => CountList(value);
    static readonly Func<List<string>, int> cbList = CountList;

    static int CountArr(params string[] items) => items.Length;
    static int ForwardArr(string value) => CountArr(value);
    static readonly Func<string[], int> cbArr = CountArr;

    static int CountEnum(params IEnumerable<string> items) => items.Count();
    static int ForwardEnum(string value) => CountEnum(value);
    static readonly Func<IEnumerable<string>, int> cbEnum = CountEnum;

    static int ApplyList(Func<List<string>, int> f) => f(new List<string> { "a" });
    static int ApplyArr(Func<string[], int> f) => f(new[] { "a" });
    static int ApplyEnum(Func<IEnumerable<string>, int> f) => f(new[] { "a" });

    public static void Main()
    {
        Console.Write(
            cbList(new List<string> { "x" }) + "," + ApplyList(CountList) + "," + ForwardList(null!) + "|" +
            cbArr(new[] { "x" }) + "," + ApplyArr(CountArr) + "," + ForwardArr(null!) + "|" +
            cbEnum(new[] { "x" }) + "," + ApplyEnum(CountEnum) + "," + ForwardEnum(null!)
        );
    }
}
`, (
                directory string,
                printed string,
                compiled ProcessRunResult
            ) -> {
                Assert.False(
                    compiled.TimedOut,
                    compiled.Output
                )
                Assert.NotEqual(
                    0,
                    compiled.ExitCode
                )
                Assert.False(
                    File.Exists(Path.Combine(directory, "Target.dll"))
                )
                let diagnostics = Regex
                    .Matches(compiled.Output, `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`)
                    .Select(
                    (match_ Match) -> string.Join(
                        ",",
                        Enumerable.Range(1, 5).Select((index int32) -> match_.Groups[index].Value)
                    )
                )
                    .ToArray()
                Assert.NotEmpty(
                    diagnostics
                )
                let expected = []string{"ForwardList", "ForwardArr", "ForwardEnum"}
                    .Select((method string) -> NilRange(printed, method))
                    .ToArray()
                Assert.Equal(
                    expected,
                    diagnostics
                )
                Assert.Contains(
                    "CountList(items ...List[string])",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "CountArr(items ...string)",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "CountEnum(items ...IEnumerable[string])",
                    printed,
                    StringComparison.Ordinal
                )
            })
    }

    @Fact
    func ObliviousMethodGroupConsumers_KeepNonNullElementsAndVerifyStrictIl() {
        Issue5581ExpandedParamsNullElementsTests.WithTranslation(`
#nullable disable
using System;
using System.Collections.Generic;
using System.Linq;

public static class P
{
    static int PureList(params List<string> items) => items.Count;
    static readonly Func<List<string>, int> cbPureList = PureList;

    static int PureArr(params string[] items) => items.Length;
    static readonly Func<string[], int> cbPureArr = PureArr;

    static int PureEnum(params IEnumerable<string> items) => items.Count();
    static readonly Func<IEnumerable<string>, int> cbPureEnum = PureEnum;

    static int ApplyList(Func<List<string>, int> f) => f(new List<string> { "a" });
    static int ApplyArr(Func<string[], int> f) => f(new[] { "a" });
    static int ApplyEnum(Func<IEnumerable<string>, int> f) => f(new[] { "a" });

    public static void Main()
    {
        Console.Write(
            cbPureList(new List<string> { "x" }) + "," + ApplyList(PureList) + "," + PureList("a", "b") + "|" +
            cbPureArr(new[] { "x" }) + "," + ApplyArr(PureArr) + "," + PureArr("a", "b") + "|" +
            cbPureEnum(new[] { "x" }) + "," + ApplyEnum(PureEnum) + "," + PureEnum("a", "b")
        );
    }
}
`, (
                directory string,
                printed string,
                compiled ProcessRunResult
            ) -> {
                Issue5581ExpandedParamsNullElementsTests.AssertSuccessfulTarget(
                    directory,
                    compiled,
                    "1,1,2|1,1,2|1,1,2"
                )
                Assert.Contains(
                    "PureList(items ...List[string])",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "PureArr(items ...string)",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "PureEnum(items ...IEnumerable[string])",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.DoesNotContain(
                    "string?",
                    printed,
                    StringComparison.Ordinal
                )
            }, "1,1,2|1,1,2|1,1,2")
    }

    shared {
        private func NilRange(printed string, method string) string {
            let match_ = Regex.Match(printed, Regex.Escape(method) + `\(\s*(nil)\s*\)`)
            Assert.True(match_.Success, printed)
            let nilIndex = match_.Groups[1].Index
            let before = printed.Substring(0, nilIndex)
            let line = before.Count((value char) -> value == '\n') + 1
            let column = nilIndex - before.LastIndexOf('\n')
            return "$line,$column,$line,${column + 3},GS0154"
        }
    }
}
