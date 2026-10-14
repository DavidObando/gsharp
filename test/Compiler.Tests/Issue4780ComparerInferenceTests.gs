// <copyright file="Issue4780ComparerInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System
import System.IO
import System.Linq
import Xunit

class Issue4780ComparerInferenceTests {
    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func ImportedDualComparerWithIdentitySelectorVerifiesAndMatchesNative(
        reverseInterfaces bool,
        implicitSelector bool
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let interfaces = if reverseInterfaces {
            "IComparer<FunctionSymbol>, IComparer<Symbol>"
        } else {
            "IComparer<Symbol>, IComparer<FunctionSymbol>"
        }
        let library = fixture.CompileCSharp(
            Contracts.Replace("INTERFACES", interfaces, StringComparison.Ordinal),
            "Contracts4780"
        )
        IlVerifier.Verify(library)
        let selector = if implicitSelector {
            "s -> Probe.Identity(s)"
        } else {
            "(s FunctionSymbol) -> Probe.Identity(s)"
        }
        let dll = fixture.Compile((`package Caller4780
import System
import System.Linq
import Contracts4780
func Main() {
    Console.WriteLine(Probe.Native())
    let first = FunctionSymbol("B")
    let second = FunctionSymbol("A")
    Probe.Reset()
    let result = []FunctionSymbol{first, second}.OrderBy(
        ` + "$selector" + `, SymbolSourceOrderComparer.Instance)
    for item in result { Console.WriteLine(item.Name) }
    Console.WriteLine(Probe.Calls)
    Console.WriteLine(Probe.Select(SymbolSourceOrderComparer.Instance, first))
    Console.WriteLine(Probe.Invariant(Both(), first))
    Console.WriteLine(Host[int32]().Select(SymbolSourceOrderComparer.Instance, first))
    Console.WriteLine(first.SelectWith(SymbolSourceOrderComparer.Instance))
}`), "Caller4780", true, "/r:" + library)
        IlVerifier.Verify(dll, []string{library})
        Assert.Equal(`A,B:2
A
B
2
` + string.Concat(Enumerable.Repeat("Contracts4780.FunctionSymbol\n", 4)), fixture.Run(dll))
    }

    @Fact
    func BaseComparerRemainsContravariantAndBaseSelectorKeepsItsKeyType() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(
            Contracts.Replace("INTERFACES", "IComparer<Symbol>, IComparer<FunctionSymbol>", StringComparison.Ordinal),
            "Contracts4780"
        )
        let dll = fixture.Compile(`package Variance4780
import System
import System.Linq
import Contracts4780
func Main() {
    let items = []FunctionSymbol{FunctionSymbol("B"), FunctionSymbol("A")}
    for item in items.OrderBy((s FunctionSymbol) -> s, BaseComparer()) {
        Console.WriteLine(item.Name)
    }
    for item in items.OrderBy((s FunctionSymbol) -> Probe.AsSymbol(s), SymbolSourceOrderComparer.Instance) {
        Console.WriteLine(item.Name)
    }
}`, "Variance4780", true, "/r:" + library)
        IlVerifier.Verify(dll, []string{library})
        Assert.Equal(`B
A
B
A
`, fixture.Run(dll))
    }

    @Theory
    @InlineData(
        "Probe.Infer(SymbolSourceOrderComparer.Instance)",
        "Probe.Infer(SymbolSourceOrderComparer.Instance)",
        "CS0411"
    )
    @InlineData(
        "Probe.Select(SymbolSourceOrderComparer.Instance, Unrelated())",
        "Probe.Select(SymbolSourceOrderComparer.Instance, new Unrelated())",
        "CS1503"
    )
    @InlineData(
        "Probe.Constrained(SymbolSourceOrderComparer.Instance, FunctionSymbol(\"A\"))",
        "Probe.Constrained(SymbolSourceOrderComparer.Instance, new FunctionSymbol(\"A\"))",
        "CS0311"
    )
    @InlineData("Probe.Invariant(Both(), Unrelated())", "Probe.Invariant(new Both(), new Unrelated())", "CS1503")
    func AmbiguousUnfixedInapplicableAndConstrainedCallsStayRejected(
        call string,
        nativeCall string,
        nativeDiagnostic string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(
            Contracts.Replace("INTERFACES", "IComparer<Symbol>, IComparer<FunctionSymbol>", StringComparison.Ordinal),
            "Contracts4780"
        )
        let nativeFailure = Assert.ThrowsAny[Exception](
            func () object? {
                return fixture.CompileCSharp((`using Contracts4780;
public static class RejectedNative {
    public static string Run() => ` + "$nativeCall" + `;
}`), "RejectedNative", library)
            }
        )
        Assert.Contains(nativeDiagnostic, nativeFailure.Message, StringComparison.Ordinal)
        let (code, output) = fixture.TryCompile((`package Rejected4780
import System
import Contracts4780
func Main() { Console.WriteLine(` + "$call" + `) }`), "Rejected4780", true, "/r:" + library)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0159", output, StringComparison.Ordinal)
    }

    @Fact
    func MigratedProducerContractAndSameCompilationComparerKeepTheExactCall() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const contracts = `package Migrated4780
import System
import System.Collections.Generic
open class Symbol {
    let Name string
    init(name string) { Name = name }
}
class FunctionSymbol : Symbol {
    init(name string) : base(name) { }
}
class SymbolSourceOrderComparer : IComparer[Symbol], IComparer[FunctionSymbol] {
    shared { let Instance SymbolSourceOrderComparer = SymbolSourceOrderComparer() }
    func Compare(x Symbol?, y Symbol?) int32 -> StringComparer.Ordinal.Compare(y?.Name, x?.Name)
    func Compare(x FunctionSymbol?, y FunctionSymbol?) int32 -> StringComparer.Ordinal.Compare(x?.Name, y?.Name)
}`
        const caller = `package MigratedCaller4780
import System
import System.Linq
import Migrated4780
func Main() {
    let first = FunctionSymbol("B")
    let second = FunctionSymbol("A")
    for item in []FunctionSymbol{first, second}.OrderBy(
        (s FunctionSymbol) -> s, SymbolSourceOrderComparer.Instance) {
        Console.WriteLine(item.Name)
    }
}`
        let producer = fixture.Compile(contracts, "Migrated4780", false)
        IlVerifier.Verify(producer)
        let imported = fixture.Compile(caller, "Imported4780", true, "/r:" + producer)
        IlVerifier.Verify(imported, []string{producer})
        Assert.Equal(`A
B
`, fixture.Run(imported))
        let sourceFile = Path.Combine(fixture.Directory, "Contracts.gs")
        File.WriteAllText(sourceFile, contracts)
        let local = fixture.Compile(caller, "Local4780", true, sourceFile)
        IlVerifier.Verify(local)
        Assert.Equal(`A
B
`, fixture.Run(local))
    }

    shared {
        private const Contracts string = `#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
namespace Contracts4780;
public class Symbol {
    public string Name { get; }
    public Symbol(string name) => Name = name;
}
public sealed class FunctionSymbol : Symbol {
    public FunctionSymbol(string name) : base(name) { }
}
public sealed class Unrelated { }
public interface IInvariant<T> { }
public sealed class Both : IInvariant<Symbol>, IInvariant<FunctionSymbol> { }
public sealed class BaseComparer : IComparer<Symbol> {
    public int Compare(Symbol? x, Symbol? y) => StringComparer.Ordinal.Compare(y?.Name, x?.Name);
}
public sealed class SymbolSourceOrderComparer : INTERFACES {
    public static readonly SymbolSourceOrderComparer Instance = new();
    public int Compare(Symbol? x, Symbol? y) =>
        StringComparer.Ordinal.Compare(y?.Name, x?.Name);
    public int Compare(FunctionSymbol? x, FunctionSymbol? y) =>
        StringComparer.Ordinal.Compare(x?.Name, y?.Name);
}
public sealed class Host<TMarker> {
    public string Select<T>(IComparer<T> comparer, T value) where T : class => Probe.Select(comparer, value);
}
public static class Extensions {
    public static string SelectWith<T>(this T value, IComparer<T> comparer) where T : class => Probe.Select(comparer, value);
}
public static class Probe {
    public static int Calls { get; private set; }
    public static void Reset() => Calls = 0;
    public static FunctionSymbol Identity(FunctionSymbol value) { Calls++; return value; }
    public static Symbol AsSymbol(FunctionSymbol value) => value;
    public static string Select<T>(IComparer<T> comparer, T value) where T : class => typeof(T).ToString();
    public static string Infer<T>(IComparer<T> comparer) => typeof(T).ToString();
    public static string Constrained<T>(IComparer<T> comparer, T value) where T : IDisposable => typeof(T).ToString();
    public static string Invariant<T>(IInvariant<T> choice, T value) => typeof(T).ToString();
    public static string Native() {
        Reset();
        var first = new FunctionSymbol("B");
        var second = new FunctionSymbol("A");
        var items = new[] { first, second }.OrderBy(
            (FunctionSymbol s) => Identity(s), SymbolSourceOrderComparer.Instance);
        return string.Join(",", items.Select(s => s.Name)) + ":" + Calls;
    }
}`
    }
}
