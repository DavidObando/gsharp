// <copyright file="Issue6011DictionaryIdentifierKeyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// Issue #6011: a generic collection initializer whose first element is a
/// keyed pair with an identifier key (`Dictionary[K, V]{ key: value }`) was
/// printed without `()`, so gsc's `BraceLooksLikeGenericCollectionInitializer`
/// parsed `Identifier:` as a struct-literal field (`GS0158: Cannot find member`
/// or a silent property write). Keeping `()` routes through
/// `LooksLikeCollectionInitializerBrace` (`Dictionary[K, V](){ key: value }`).
open class Issue6011DictionaryIdentifierKeyTests {
    @Fact
    func Dictionary_IdentifierKey_PreservesAddSemanticsAndMatchesCSharp() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
using System.Collections.Generic;

public static class Demo {
    public static string Run() {
        var key = "alpha";
        var d1 = new Dictionary<string, int> { { key, 1 } };
        Dictionary<string, int> d2 = new() { { key, 2 } };
        var threw = false;
        try {
            _ = new Dictionary<string, int> { { key, 1 }, { key, 2 } };
        } catch (ArgumentException) {
            threw = true;
        }
        return d1[key] + ":" + d2[key] + ":" + threw;
    }
}`, strictIl: true, expectedOutput: "1:2:True")
        Assert.Contains("Dictionary[string, int32](){ key: 1 }", printed, StringComparison.Ordinal)
        Assert.Contains("Dictionary[string, int32](){ key: 2 }", printed, StringComparison.Ordinal)
    }

    @Fact
    func Dictionary_MultiEntryAndSortedAndComparer_MatchesCSharp() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
using System.Collections.Generic;

public static class Demo {
    static string Next(string tag, List<string> log) {
        log.Add(tag);
        return tag;
    }

    public static string Run() {
        var log = new List<string>();
        var firstKey = "first";
        var secondKey = "second";
        var d1 = new Dictionary<string, int> { { firstKey, 10 }, { Next("lit", log), 20 }, { secondKey, 30 } };
        var d2 = new Dictionary<string, int> { { "a", 1 }, { secondKey, 2 } };
        var sorted = new SortedDictionary<string, int> { { firstKey, 5 }, { "b", 6 } };
        var ci = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase) { { firstKey, 7 } };
        return string.Join(",", log) + "|" + d1[firstKey] + ":" + d1["lit"] + ":" + d1[secondKey] + "|" +
            d2["a"] + ":" + d2[secondKey] + "|" + sorted[firstKey] + ":" + sorted["b"] + "|" + ci["FIRST"];
    }
}`, strictIl: true, expectedOutput: "lit|10:20:30|1:2|5:6|7")
        Assert.Contains("Dictionary[string, int32](){ firstKey: 10,", printed, StringComparison.Ordinal)
        Assert.Contains("Dictionary[string, int32]{ \"a\": 1, secondKey: 2 }", printed, StringComparison.Ordinal)
        Assert.Contains("SortedDictionary[string, int32](){ firstKey: 5, \"b\": 6 }", printed, StringComparison.Ordinal)
        Assert.Contains(
            "Dictionary[string, int32](StringComparer.OrdinalIgnoreCase){ firstKey: 7 }",
            printed,
            StringComparison.Ordinal
        )
    }

    @Fact
    func Dictionary_NonIdentifierKeysAndIndexedInitializer_KeepCanonicalForm() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
using System.Collections.Generic;

public sealed class Box {
    public string Key { get; set; } = "boxKey";
}

public static class Demo {
    static string GetKey() => "fnKey";

    public static string Run() {
        var k = "idx";
        var box = new Box();
        var d1 = new Dictionary<string, int> { { "lit", 1 } };
        var d2 = new Dictionary<string, int> { { GetKey(), 2 } };
        var d3 = new Dictionary<string, int> { { box.Key, 3 } };
        var d4 = new Dictionary<int, string> { { 1 + 2, "sum" } };
        var d5 = new Dictionary<string, int> { [k] = 4, [k] = 5 };
        return d1["lit"] + ":" + d2["fnKey"] + ":" + d3["boxKey"] + ":" + d4[3] + ":" + d5[k];
    }
}`, strictIl: true, expectedOutput: "1:2:3:sum:5")
        Assert.Contains("Dictionary[string, int32]{ \"lit\": 1 }", printed, StringComparison.Ordinal)
        Assert.Contains("Dictionary[string, int32]{ GetKey(): 2 }", printed, StringComparison.Ordinal)
        Assert.Contains("Dictionary[string, int32]{ box.Key: 3 }", printed, StringComparison.Ordinal)
        Assert.Contains("Dictionary[int32, string]{ 1 + 2: \"sum\" }", printed, StringComparison.Ordinal)
        Assert.Contains("Dictionary[string, int32]{ [k] = 4, [k] = 5 }", printed, StringComparison.Ordinal)
    }

    @Fact
    func CustomAddCollections_OneTwoAndThreeArgs_WithPropertyNameShadowingKey_MatchesCSharp() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;

public sealed class Bag<T> : IEnumerable {
    private readonly List<string> _items = new List<string>();
    public int Capacity { get; set; }
    public int Count => _items.Count;
    public void Add(int key, T value) => _items.Add(key + "=" + value);
    public string FirstItem => _items[0];
    public IEnumerator GetEnumerator() => _items.GetEnumerator();
}

public sealed class NonGenericBag : IEnumerable {
    private readonly List<string> _items = new List<string>();
    public int Capacity { get; set; }
    public int Count => _items.Count;
    public void Add(int key, int value) => _items.Add(key + "=" + value);
    public string FirstItem => _items[0];
    public IEnumerator GetEnumerator() => _items.GetEnumerator();
}

public sealed class SingleBag<T> : IEnumerable {
    private readonly List<T> _items = new List<T>();
    public void Add(T item) => _items.Add(item);
    public T FirstItem => _items[0];
    public IEnumerator GetEnumerator() => _items.GetEnumerator();
}

public sealed class TripleBag<T> : IEnumerable {
    private readonly List<string> _items = new List<string>();
    public void Add(int a, string b, T c) => _items.Add(a + ":" + b + ":" + c);
    public string FirstItem => _items[0];
    public IEnumerator GetEnumerator() => _items.GetEnumerator();
}

public static class Demo {
    public static string Run() {
        var Capacity = 42;
        var genericBag = new Bag<int> { { Capacity, 99 } };
        var nonGenericBag = new NonGenericBag { { Capacity, 88 } };
        var singleBare = new SingleBag<int> { Capacity };
        var singleComplex = new SingleBag<int> { { Capacity } };
        var triple = new TripleBag<bool> { { Capacity, "x", true } };
        return genericBag.Capacity + ":" + genericBag.Count + ":" + genericBag.FirstItem + "|" +
            nonGenericBag.Capacity + ":" + nonGenericBag.Count + ":" + nonGenericBag.FirstItem + "|" +
            singleBare.FirstItem + ":" + singleComplex.FirstItem + "|" + triple.FirstItem;
    }
}`, strictIl: true, expectedOutput: "0:1:42=99|0:1:42=88|42:42|42:x:True")
        Assert.Contains("Bag[int32](){ Capacity: 99 }", printed, StringComparison.Ordinal)
        Assert.Contains("NonGenericBag(){ Capacity: 88 }", printed, StringComparison.Ordinal)
    }

    @Fact
    func ObjectInitializerControls_RemainStructLiteralsAndMemberCollectionInitializers() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
using System.Collections.Generic;

public sealed class Box<T> {
    public T Value { get; set; } = default!;
}

public sealed class Holder {
    public Dictionary<string, int> Map { get; } = new Dictionary<string, int>();
}

public sealed class HolderWithCtor {
    public int Seed { get; }
    public Dictionary<string, int> Map { get; } = new Dictionary<string, int>();
    public HolderWithCtor(int seed) { Seed = seed; }
}

public static class Demo {
    public static string Run() {
        var k = "key";
        var box = new Box<int> { Value = 1 };
        var holder = new Holder { Map = { { k, 2 } } };
        var holderCtor = new HolderWithCtor(3) { Map = { { k, 4 } } };
        return box.Value + ":" + holder.Map[k] + ":" + holderCtor.Seed + ":" + holderCtor.Map[k];
    }
}`, strictIl: true, expectedOutput: "1:2:3:4")
        Assert.Contains("Box[int32]{Value: 1}", printed, StringComparison.Ordinal)
        Assert.Contains("Holder{Map: { k: 2 }}", printed, StringComparison.Ordinal)
        Assert.Contains("HolderWithCtor(3){Map = { k: 4 }}", printed, StringComparison.Ordinal)
    }

    @Fact
    func AliasRepro_DictionaryWithAliasTypeAndIdentifierKey_RunsLikeCSharp() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using Alias = System.Text.StringBuilder;

public static class Demo {
    public static string Run() {
        var element = new System.Text.StringBuilder("same");
        var value = new Dictionary<Alias, string>{{element, "same"}}.Values;
        var first = new { Value = value };
        {
            int Alias = 0;
            var second = new { Value = value };
            return first.Equals(second).ToString() + ":" +
                string.Join(",", second.Value) + ":" + Alias;
        }
    }
}`, strictIl: true, expectedOutput: "True:same:0")
        Assert.Contains("Dictionary[Alias, string](){ element: \"same\" }.Values", printed, StringComparison.Ordinal)
    }

    @Fact
    func AliasRepro_ExactIssue6011Source_HasNoGS0158MemberError() {
        let source = `
#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using Alias = System.Text.StringBuilder;
public static class First {
    public static string Run() {
        var element = new System.Text.StringBuilder("same");
        var value = new Dictionary<Alias, string>{{element, "same"}}.Values;
        var first = new { Value = value };
        {
            int Alias = 0;
            var second = new { Value = value };
            return first.Equals(second).ToString() + ":" +
                second.Value.First().ToString() + ":" + Alias;
        }
    }
}
public static class Second { public static string Run() => ""; }
`
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Repro.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("Dictionary[Alias, string](){ element: \"same\" }.Values", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Dictionary[Alias, string]{ element: \"same\" }", printed, StringComparison.Ordinal)
        Assert.Contains("Value Dictionary[Alias, string].ValueCollection", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Dictionary[Alias, string?]", printed, StringComparison.Ordinal)

        let compiler = FindCompiler()
        Assert.NotNull(compiler)
        let workDir = Path.Combine(
            AppContext.BaseDirectory,
            "Issue6011DictionaryIdentifierKeyTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(workDir)
        try {
            let gsPath = Path.Combine(workDir, "Repro.gs")
            let dllPath = Path.Combine(workDir, "Repro.dll")
            File.WriteAllText(gsPath, printed)
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            startInfo.ArgumentList.Add(compiler!!)
            startInfo.ArgumentList.Add("/target:library")
            startInfo.ArgumentList.Add("/out:" + dllPath)
            startInfo.ArgumentList.Add(gsPath)
            using let process = Process.Start(startInfo) ?? throw InvalidOperationException("failed to start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(TimeSpan.FromMinutes(5)) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("gsc did not exit within 5 minutes.")
            }
            let output = stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult()
            Assert.DoesNotContain("GS0158", output, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0159", output, StringComparison.Ordinal)
            Assert.True(process.ExitCode == 0, "Expected clean gsc compilation:\n" + output)
        } finally {
            try {
                Directory.Delete(workDir, recursive: true)
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    @Fact
    func Issue6159_NullableEnableAnonymousProjectedStorage_PreservesNonNullArgumentsAcrossContainersAndRunsLikeCSharp() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using Alias = System.Text.StringBuilder;

public static class Demo {
    public static string Run() {
        var element = new System.Text.StringBuilder("same");
        var value = new Dictionary<Alias, string> { { element, "same" } }.Values;
        var first = new { Value = value };
        var keys = new { Keys = new Dictionary<Alias, string> { { element, "same" } }.Keys };
        var list = new { Items = new List<string> { "item" } };
        var array = new { Items = new[] { "arr" } };
        var tuple = new { Pair = ("tup", 7) };
        {
            int Alias = 0;
            var second = new { Value = value };
            return first.Equals(second).ToString() + ":" +
                second.Value.First().ToString() + ":" +
                keys.Keys.First().ToString() + ":" +
                list.Items.First().ToString() + ":" +
                array.Items.First().ToString() + ":" +
                tuple.Pair.Item1.ToString() + ":" +
                Alias;
        }
    }
}`, strictIl: true, expectedOutput: "True:same:same:item:arr:tup:0")
        Assert.Contains("Value Dictionary[Alias, string].ValueCollection", printed, StringComparison.Ordinal)
        Assert.Contains("Keys Dictionary[Alias, string].KeyCollection", printed, StringComparison.Ordinal)
        Assert.Contains("Items List[string]", printed, StringComparison.Ordinal)
        Assert.Contains("Items []string", printed, StringComparison.Ordinal)
        Assert.Contains("Pair (string, int32)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("string?", printed, StringComparison.Ordinal)
    }

    @Fact
    func Issue6159_ExplicitNullableAndObliviousAnonymousProjectedStorage_PreserveWidenedContracts() {
        let nullablePrinted = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using Alias = System.Text.StringBuilder;

public static class Demo {
    public static string Run() {
        var element = new System.Text.StringBuilder("same");
        var values = new Dictionary<Alias, string?> { { element, null } }.Values;
        var list = new List<string?> { "ok", null };
        var array = new string?[] { null, "ok" };
        var tuple = ((string?)null, 7);
        var box = new { Values = values, Items = list, Arr = array, Pair = tuple };
        return (box.Values.First() ?? "nil") + ":" +
            (box.Items.Last() ?? "nil") + ":" +
            (box.Arr[0] ?? "nil") + ":" +
            (box.Pair.Item1 ?? "nil");
    }
}`, strictIl: true, expectedOutput: "nil:nil:nil:nil")
        Assert.Contains("Values Dictionary[Alias, string?].ValueCollection", nullablePrinted, StringComparison.Ordinal)
        Assert.Contains("Items List[string?]", nullablePrinted, StringComparison.Ordinal)
        Assert.Contains("Arr []string?", nullablePrinted, StringComparison.Ordinal)
        Assert.Contains("Pair (string?, int32)", nullablePrinted, StringComparison.Ordinal)

        let obliviousTree = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(`
#nullable disable
using System.Collections.Generic;

public static class ObliviousDemo {
    public static object Make() {
        var dict = new Dictionary<string, string> { { "k", "v" } };
        var values = dict.Values;
        var list = new List<string> { "item" };
        var array = new[] { "arr" };
        var tuple = ("tup", 7);
        return new { Dict = dict, Values = values, Items = list, Arr = array, Pair = tuple };
    }
}`, path: "ObliviousDemo.cs")
        let obliviousProject = CSharpProjectLoader.LoadInMemory(
            [](string, string){("ObliviousDemo.cs", obliviousTree.ToString())}
        )
        Assert.True(
            obliviousProject.BoundWithoutErrors,
            string.Join(Environment.NewLine, obliviousProject.ErrorDiagnostics)
        )
        let obliviousDoc = Assert.Single(obliviousProject.Documents)
        let obliviousCtx = TranslationContext(
            obliviousProject.Compilation,
            obliviousDoc.SemanticModel,
            obliviousDoc.FilePath
        )
        let obliviousPrinted = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(obliviousDoc, obliviousCtx)
        )
        Assert.Contains("Dict Dictionary[string, string?]", obliviousPrinted, StringComparison.Ordinal)
        Assert.Contains(
            "Values Dictionary[string, string?].ValueCollection",
            obliviousPrinted,
            StringComparison.Ordinal
        )
        Assert.Contains("Items List[string?]", obliviousPrinted, StringComparison.Ordinal)
        Assert.Contains("Arr []string?", obliviousPrinted, StringComparison.Ordinal)
        Assert.Contains("Pair (string?, int32)", obliviousPrinted, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(obliviousPrinted)
    }

    @Fact
    func EmptyGenericCollectionInitializer_KeepsParenthesesAndBinds() {
        let collection = CollectionInitializerExpression(
            InvocationExpression(
                IdentifierExpression("MakeDict"),
                List[GExpression](),
                List[GTypeReference]{NamedTypeReference("string"), NamedTypeReference("int32")}
            ),
            List[CollectionInitializerElement]()
        )
        let unit = CompilationUnit(
            "Demo",
            List[ImportDirective]{ImportDirective("System.Collections.Generic")},
            List[GNode]{
                MethodDeclaration(
                    "MakeDict",
                    typeParameters: List[TypeParameter]{TypeParameter("K"), TypeParameter("V")},
                    returnType: NamedTypeReference(
                        "Dictionary",
                        List[GTypeReference]{NamedTypeReference("K"), NamedTypeReference("V")}
                    ),
                    expressionBody: ReturnStatement(
                        InvocationExpression(
                            IdentifierExpression("Dictionary"),
                            List[GExpression](),
                            List[GTypeReference]{NamedTypeReference("K"), NamedTypeReference("V")}
                        )
                    )
                ),
                MethodDeclaration(
                    "Build",
                    returnType: NamedTypeReference(
                        "Dictionary",
                        List[GTypeReference]{NamedTypeReference("string"), NamedTypeReference("int32")}
                    ),
                    expressionBody: ReturnStatement(collection)
                )
            }
        )
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("MakeDict[string, int32](){", printed, StringComparison.Ordinal)
        let roundTrip = TranslationTestValidation.AssertBinds(printed)
        Assert.True(roundTrip!!.Success)
    }

    shared {
        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
