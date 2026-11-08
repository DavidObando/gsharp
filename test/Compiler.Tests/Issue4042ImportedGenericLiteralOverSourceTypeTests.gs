// <copyright file="Issue4042ImportedGenericLiteralOverSourceTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #4042: an object literal of an IMPORTED generic over a
/// SAME-COMPILATION type argument.
/// @remarks <b>The defect.</b> `Handler[MyOptions]{Tag: "z"}` reported
/// `GS0157: Cannot find type Handler. Are you missing an import?` — not a
/// message about the literal, but the fall-through for a type that could not
/// be named at all — while the CONSTRUCTOR spelling
/// `Handler[MyOptions]()` of the very same instantiation compiled, IL-
/// verified and ran. Re-measured on the parent before anything was written.
///
/// <b>Why a same-compilation argument was not "CLR-faithful".</b> The
/// imported-generic literal branch was gated on
/// `!hasSymbolicArgument || HasOnlyClrFaithfulSymbolicArguments(...)`. A
/// same-compilation user class has NO reference-context CLR type while
/// binding — its TypeDef is only produced at emit — so
/// `TryResolveClrConstructionTypeArgs` closes it over the `object`
/// SURROGATE and `HasOnlyClrFaithfulSymbolicArguments` answers false by
/// its own definition (`argument.ClrType == null`). That predicate came
/// from #4024 and is CORRECT about what it says: the closed CLR type
/// `Handler<object>` does not describe the argument. It was being
/// used for the wrong thing — as a gate on ENTERING the branch, when the fact
/// it establishes only decides the RESULT TYPE. The fix moves it: the branch
/// is entered for every resolvable argument, and a non-faithful vector is
/// carried beside the erased shape as
/// `ImportedTypeSymbol.GetConstructed(...)`, which is exactly what the
/// CONSTRUCTOR path has done since #671 and is why that spelling worked.
///
/// <b>Measured, not assumed: this is binder-only.</b> The discriminating
/// probe was the ADR-0117 object-initializer SUFFIX,
/// `Handler[MyOptions](){Tag = "z"}`, which produces the same bound nodes
/// (`BoundClrConstructorCallExpression` plus member assignments) over a
/// constructed-symbol receiver. On the parent it compiled, IL-verified and
/// printed `z` — so the emitter already reified `Handler<MyOptions>`
/// from that shape and nothing in emit needed changing. The parity row below
/// asserts the reified runtime type
/// (`HelperLib2.Handler`1[P.MyOptions]`, not `…[System.Object]`) for
/// both spellings.
///
/// <b>The three LOSSY-BUT-REAL spellings are must-not-change rows.</b>
/// `Box[[]int32]{…}` (#4024), `Box[[3]int32]{…}` (#3962) and the
/// named-tuple spelling (ADR-0172) each retain a symbolic argument that DOES
/// have a faithful closed CLR type. They keep taking the plain path — the
/// predicate still decides which — and are pinned here as well as in
/// `Issue4024SliceTypeArgumentRetentionTests`.
///
/// <b>Widening the branch does not widen what is ACCEPTED.</b> #4032's
/// constraint check sits at the top of the branch, so
/// `Handler[NotOptions]{…}` now reports `GS0152` where it used to
/// report GS0157, and #4037's forwarding rule reaches the literal too, so
/// `Handler[T]{…}` inside an unconstrained `func f[T]` reports
/// `GS0580`. Both are rows here.
///
/// <b>Issue #4059 closed the shared follow-up.</b> A member whose type
/// is the erased type parameter now projects through the symbolic receiver on
/// both spellings, so `Handler[MyOptions]().Options!!.Name` and the literal
/// twin bind and execute against `MyOptions`, not `object`.
open class Issue4042ImportedGenericLiteralOverSourceTypeTests {
    /// A literal of an imported generic over a same-compilation type argument
    /// binds, IL-verifies, runs, and reifies the real closed type.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("BindingLiterals")
    func AnImportedGenericLiteral_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4042_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            // The parent's symptom, named explicitly: the fall-through that
            // could not name the type at all.
            Assert.DoesNotContain("GS0157", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0580", appLog, StringComparison.Ordinal)
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal(expectedLines, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The checks at the top of the widened branch still refuse what they
    /// refused, and say why.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("RefusedLiterals")
    func AnInvalidImportedGenericLiteral_IsRefused(name string, source string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4042_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            // The parent's wrong message must not be what a reader sees.
            Assert.DoesNotContain("GS0157", appLog, StringComparison.Ordinal)
            // Issue #4032's lesson: assert the COUNT, not the presence.
            let occurrences = appLog.Split(expectedId, StringSplitOptions.None).Length - 1
            Assert.True(
                occurrences == 1,
                (`'` + "$name" + `' must report ` + "$expectedId" + ` exactly once, saw ` + "$occurrences" + `. Log:
` + "$appLog")
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Issue #4059: a member whose type is the erased type parameter must be
    /// projected through the symbolic receiver on both construction spellings.
    /// @remarks Both spellings must bind, execute, and produce the same value.
    @Fact
    func AMemberTypedByTheErasedParameter_ProjectsOnBothSpellings() {
        const ViaLiteral = (`package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

let o = MyOptions()
o.Name = "n1"
let h = Handler[MyOptions]{Tag: "z", Options: o}
// Issue #4356: ` + "`" + `Options` + "`" + ` is declared ` + "`" + `TOptions?` + "`" + `; the chained read asserts.
Console.WriteLine(h.Options!!.Name)`)
        const ViaConstructor = (`package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

let o = MyOptions()
o.Name = "n1"
let h = Handler[MyOptions]()
h.Options = o
// Issue #4356: ` + "`" + `Options` + "`" + ` is declared ` + "`" + `TOptions?` + "`" + `; the chained read asserts.
Console.WriteLine(h.Options!!.Name)`)
        let tempDir = Directory.CreateTempSubdirectory("gs_4042_erasure_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let literalPath = Path.Combine(tempDir, "ViaLiteral.dll")
            let literalLog = Compile(
                tempDir,
                "ViaLiteral.gs",
                ViaLiteral,
                literalPath,
                "/target:exe",
                "/reference:" + libPath
            )
            let constructorPath = Path.Combine(tempDir, "ViaConstructor.dll")
            let constructorLog = Compile(
                tempDir,
                "ViaConstructor.gs",
                ViaConstructor,
                constructorPath,
                "/target:exe",
                "/reference:" + libPath
            )
            Assert.DoesNotContain("error GS", literalLog, StringComparison.Ordinal)
            Assert.DoesNotContain("error GS", constructorLog, StringComparison.Ordinal)
            Assert.True(File.Exists(literalPath), literalLog)
            Assert.True(File.Exists(constructorPath), constructorLog)
            let literalRun = RunDotnet(literalPath)
            let constructorRun = RunDotnet(constructorPath)
            Assert.Equal(0, literalRun.Exit)
            Assert.Equal(0, constructorRun.Exit)
            Assert.Equal("n1", literalRun.Output.Trim())
            Assert.Equal("n1", constructorRun.Output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Issue #4355: member access on a constructor-call or composite-literal
    /// receiver preserves nullable type arguments across top-level and nested
    /// imported generics.
    @Fact
    func Issue4355_ConstructorAndLiteralReceivers_PreserveNullableTypeArguments() {
        const GsLibrary = `package GsLib

data class Data[T] {
    var Field T
}

data class GsPair[T](First T, Second T)

func MakeNullableData() Data[string?] -> Data[string?]{ Field: "gs-data" }

func MakeNullablePair() GsPair[string?] -> GsPair[string?]("gs-left", "gs-right")`
        const Rejected = `package P
import System
import System.Collections.Generic
import HelperLib2
import GsLib

Console.WriteLine(PlainBox[List[int32]?]().Value.Capacity)
Console.WriteLine(Outer.Inner[List[int32]?]().Value.Capacity)
Console.WriteLine(GenericOuter[List[int32]?].Inner().Value.Capacity)
Console.WriteLine(GenericOuter[List[int32]?].Inner{}.Value.Capacity)
let { Field = df } = MakeNullableData()
Console.WriteLine(df.Length)
let (pf1, _) = MakeNullablePair()
Console.WriteLine(pf1.Length)
let (cf1, _) = PairFactory.MakeNullablePair()
Console.WriteLine(cf1.Length)`
        const Accepted = `package P
import System
import System.Collections.Generic
import HelperLib2
import GsLib

class Entry {
    public var Id int32
}

Console.WriteLine(PlainBox[List[int32]?](){ Value = List[int32]{1, 2} }.Value!!.Count)
Console.WriteLine(Outer.Inner[List[int32]?]{ Value: List[int32]{1, 2, 3} }.Value!!.Count)
Console.WriteLine(GenericOuter[List[int32]?].Inner(){ Value = List[int32]{4} }.Value!!.Count)
Console.WriteLine(GenericOuter[List[int32]?].Inner{ Value: List[int32]{5, 6} }.Value!!.Count)
let { Field = de } = Data[Entry]{ Field: Entry(){ Id = 7 } }
let (pe1, pe2) = Pair[Entry](Entry(){ Id = 8 }, Entry(){ Id = 9 })
let { Field = df } = MakeNullableData()
let (pf1, _) = MakeNullablePair()
let (cf1, _) = PairFactory.MakeNullablePair()
Console.WriteLine(de.Id)
Console.WriteLine(pe1.Id)
Console.WriteLine(pe2.Id)
Console.WriteLine(df!!.Length)
Console.WriteLine(pf1!!.Length)
Console.WriteLine(cf1!!.Length)`
        let tempDir = Directory.CreateTempSubdirectory("gs_4355_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let gsLibPath = Path.Combine(tempDir, "GsLib.dll")
            let gsLibLog = Compile(tempDir, "GsLib.gs", GsLibrary, gsLibPath, "/target:library")
            Assert.DoesNotContain("error GS", gsLibLog, StringComparison.Ordinal)
            Assert.True(File.Exists(gsLibPath), gsLibLog)
            let rejectedPath = Path.Combine(tempDir, "Rejected.dll")
            let rejectedLog = Compile(
                tempDir,
                "Rejected.gs",
                Rejected,
                rejectedPath,
                "/target:exe",
                "/reference:" + libPath,
                "/reference:" + gsLibPath
            )
            Assert.False(File.Exists(rejectedPath), rejectedLog)
            let gs0158Count = rejectedLog.Split("GS0158", StringSplitOptions.None).Length - 1
            Assert.Equal(7, gs0158Count)
            let acceptedPath = Path.Combine(tempDir, "Accepted.dll")
            let acceptedLog = Compile(
                tempDir,
                "Accepted.gs",
                Accepted,
                acceptedPath,
                "/target:exe",
                "/reference:" + libPath,
                "/reference:" + gsLibPath
            )
            Assert.DoesNotContain("error GS", acceptedLog, StringComparison.Ordinal)
            Assert.True(File.Exists(acceptedPath), acceptedLog)
            IlVerifier.Verify(acceptedPath, []string{libPath, gsLibPath})
            let (exit, output) = RunDotnet(acceptedPath)
            Assert.Equal(0, exit)
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal([]string{"2", "3", "1", "2", "7", "8", "9", "7", "7", "4"}, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Issue #4799: `with`, `.copy(...)`, and composite literals on imported C#
    /// and G# generic records/data types preserve their symbolic and lossy
    /// generic constructions through normalization and emission.
    @Fact
    func Issue4799_ImportedSymbolicRecordWithAndLiterals_PreserveGenericConstruction() {
        const GsLibrary = `package NativeGs

public data class GsRow[T any](Value T, Extra int32)

public data struct GsRowStruct[T any](Value T, Extra int32)`
        const AppSource = `package SymbolicWith
import System
import HelperLib2
import NativeGs

public struct SourceItem(Id int32)

public class Caller[A any, B any] {
    public func CopyCs(value Row[B]) Row[B] -> value with { Extra = 13 }
    public func CopyCsBoth(value Row[B], next B) Row[B] -> value with { Value = next, Extra = 14 }
    public func CopyCsDotCopy(value Row[B], next B) Row[B] -> value.copy(Value: next, Extra: 15)
    public func CopyCsStruct(value RowStruct[B], next B) RowStruct[B] -> value with { Value = next, Extra = 16 }
    public func LitWithCsStruct(next B) RowStruct[B] -> RowStruct[B]{ Value: next, Extra: 1 } with { Extra = 17 }
    public func CopyGs(value GsRow[B], next B) GsRow[B] -> value with { Value = next, Extra = 18 }
    public func CopyGsStruct(value GsRowStruct[B], next B) GsRowStruct[B] -> value with { Value = next, Extra = 19 }
    public func CopySourceItem(value Row[SourceItem], next SourceItem) Row[SourceItem] -> value with { Value = next, Extra = 20 }
    public func TupleRowStructLit() string -> (RowStruct[(Required string, Code int32)]{ Value: ("tuple-struct", 7), Extra: 2 } with { Extra = 21 }).Value.Required
    public func TupleGsRowStructLit() string -> (GsRowStruct[(Required string, Code int32)]{ Value: ("gs-tuple-struct", 8), Extra: 2 } with { Extra = 22 }).Value.Required
}

let caller = Caller[int32, string]()
let r1 = caller.CopyCs(Row[string]("a", 1))
let r2 = caller.CopyCsBoth(r1, "b")
let r3 = caller.CopyCsDotCopy(r2, "c")
let rs1 = caller.CopyCsStruct(RowStruct[string]("d", 1), "e")
let rs2 = caller.LitWithCsStruct("f")
let g1 = caller.CopyGs(GsRow[string]("g", 1), "h")
let gs1 = caller.CopyGsStruct(GsRowStruct[string]("i", 1), "j")
let s1 = caller.CopySourceItem(Row[SourceItem](SourceItem(1), 2), SourceItem(99))
Console.WriteLine("${r1.Value}:${r1.Extra}:${r1.GetType()}")
Console.WriteLine("${r2.Value}:${r2.Extra}")
Console.WriteLine("${r3.Value}:${r3.Extra}")
Console.WriteLine("${rs1.Value}:${rs1.Extra}:${rs1.GetType()}")
Console.WriteLine("${rs2.Value}:${rs2.Extra}")
Console.WriteLine("${g1.Value}:${g1.Extra}:${g1.GetType()}")
Console.WriteLine("${gs1.Value}:${gs1.Extra}:${gs1.GetType()}")
Console.WriteLine("${s1.Value.Id}:${s1.Extra}:${s1.GetType()}")
Console.WriteLine(caller.TupleRowStructLit())
Console.WriteLine(caller.TupleGsRowStructLit())`
        let tempDir = Directory.CreateTempSubdirectory("gs_4799_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let gsLibPath = Path.Combine(tempDir, "NativeGs.dll")
            let gsLibLog = Compile(tempDir, "NativeGs.gs", GsLibrary, gsLibPath, "/target:library")
            Assert.DoesNotContain("error GS", gsLibLog, StringComparison.Ordinal)
            Assert.True(File.Exists(gsLibPath), gsLibLog)
            IlVerifier.Verify(gsLibPath)
            let appPath = Path.Combine(tempDir, "SymbolicWith.dll")
            let appLog = Compile(
                tempDir,
                "SymbolicWith.gs",
                AppSource,
                appPath,
                "/target:exe",
                "/reference:" + libPath,
                "/reference:" + gsLibPath
            )
            Assert.DoesNotContain("error GS", appLog, StringComparison.Ordinal)
            Assert.True(File.Exists(appPath), appLog)
            IlVerifier.Verify(appPath, []string{libPath, gsLibPath})
            let (exit, output) = RunDotnet(appPath)
            Assert.Equal(0, exit)
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal(
                []string{
                    "a:13:HelperLib2.Row`1[System.String]",
                    "b:14",
                    "c:15",
                    "e:16:HelperLib2.RowStruct`1[System.String]",
                    "f:17",
                    "h:18:NativeGs.GsRow`1[System.String]",
                    "j:19:NativeGs.GsRowStruct`1[System.String]",
                    "99:20:HelperLib2.Row`1[SymbolicWith.SourceItem]",
                    "tuple-struct",
                    "gs-tuple-struct"
                },
                lines
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The C# library every row links against. Mirrors the issue's own
        /// library, plus an UNCONSTRAINED generic and a member typed by the type
        /// parameter itself.
        private const LibrarySource string = `namespace HelperLib2;

public class SchemeOptions
{
    public string? Name { get; set; }
}

public class Handler<TOptions>
    where TOptions : SchemeOptions
{
    public string Tag { get; set; } = "t";

    public TOptions? Options { get; set; }
}

public class Box<T>
{
    public string Tag { get; set; } = "b";

    public T? Value { get; set; }
}

public class PlainBox<T>
{
    public T Value { get; set; } = default!;
}

public class Outer
{
    public class Inner<T>
    {
        public T Value { get; set; } = default!;
    }
}

public class GenericOuter<T>
{
    public class Inner
    {
        public T Value { get; set; } = default!;
    }
}

public record Pair<T>(T First, T Second);

public record Row<T>(T Value, int Extra);

public record struct RowStruct<T>(T Value, int Extra);

public static class PairFactory
{
    public static Pair<string?> MakeNullablePair() => new("left", "right");
}`

        /// Every literal spelling that must bind, verify and run.
        /// @returns Case name, G# source, expected stdout lines.
        func BindingLiterals() sequence[[]object] {
            // THE ISSUE'S OWN REPRO. GS0157 on the parent.
            yield []object{"the-issues-repro-a-literal-over-a-same-compilation-type-argument", `package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

let lit = Handler[MyOptions]{Tag: "z"}
Console.WriteLine(lit.Tag)`, []string{"z"}}
            // PARITY WITH THE CONSTRUCTOR SPELLING, which is what the issue's
            // Expected asks for — and the reified runtime type is asserted, so
            // "it printed the right answer" is not the whole claim. `Handler<object>`
            // would print `HelperLib2.Handler`1[System.Object]`.
            yield []object{"the-literal-and-the-constructor-spellings-reify-the-same-closed-type", `package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

let ctor = Handler[MyOptions]()
ctor.Tag = "c"
let lit = Handler[MyOptions]{Tag: "c"}
Console.WriteLine(ctor.Tag)
Console.WriteLine(lit.Tag)
Console.WriteLine(ctor.GetType().ToString())
Console.WriteLine(lit.GetType().ToString())`, []string{
                    "c",
                    "c",
                    "HelperLib2.Handler`1[P.MyOptions]",
                    "HelperLib2.Handler`1[P.MyOptions]"
                }}
            // A TYPE PARAMETER as the argument. The constructor path admits one, so
            // the literal must too — and #4037's forwarding rule is what makes the
            // FORWARDED spelling the legal one.
            yield []object{"a-literal-over-a-forwarded-type-parameter", `package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

func viaParam[T SchemeOptions]() string {
    let h = Handler[T]{Tag: "p"}
    return h.Tag
}

Console.WriteLine(viaParam[MyOptions]())`, []string{"p"}}
            // A SAME-COMPILATION class at an UNCONSTRAINED imported generic — the
            // commonest shape, and the one that would have shown any regression in
            // ordinary code. GS0157 on the parent too.
            yield []object{"a-literal-of-an-unconstrained-imported-generic-over-a-same-compilation-class", `package P
import System
import HelperLib2

class Thing {
    public var N int32
}

let t = Thing()
t.N = 4
let b = Box[Thing]{Tag: "u", Value: t}
Console.WriteLine(b.Tag)
Console.WriteLine(b.GetType().ToString())`, []string{"u", "HelperLib2.Box`1[P.Thing]"}}
            // MUST NOT CHANGE: the IMPORTED type argument, which bound before this
            // change and is the spelling Issue4032's green row uses.
            yield []object{"control-a-literal-over-an-imported-type-argument-still-binds", `package P
import System
import HelperLib2

let lit = Handler[SchemeOptions]{Tag: "z"}
Console.WriteLine(lit.Tag)
Console.WriteLine(lit.GetType().ToString())`, []string{"z", "HelperLib2.Handler`1[HelperLib2.SchemeOptions]"}}
            // MUST NOT CHANGE: the three LOSSY-BUT-REAL spellings. Each retains a
            // symbolic argument that nonetheless has a faithful closed CLR type, so
            // each keeps taking the plain path. `[]T` is #4024's row, `[N]T` is
            // #3962's, the named tuple is ADR-0172's.
            //
            // The `!!` on the two reads is issue #4356, not a change of
            // subject: `Box<T>.Value` is declared `T?`, so the read is a
            // dereference of an ANNOTATED-nullable imported member. Member lookup
            // used to wave that through — the carve-out #4356 deleted could not
            // tell it from an oblivious member — and now reports it like any other
            // `T?`. What this row asserts is the literal SPELLING still binding,
            // which it does; the reads are how the row observes the values.
            yield []object{"control-the-three-lossy-but-real-spellings-still-bind", `package P
import System
import HelperLib2

let slice = Box[[]int32]{ Value: []int32{1, 2, 3} }
Console.WriteLine(slice.Value!!.Length)

let fixedLen = Box[[3]int32]{ Value: [3]int32{1, 2, 3} }
Console.WriteLine(fixedLen.Value!!.Length)

let named = Box[(a int32, b string)]{ Tag: "nt" }
Console.WriteLine(named.Tag)`, []string{"3", "3", "nt"}}
        }

        /// Widening the branch must not widen what is ACCEPTED: the checks that
        /// sit at the top of it now reach the literal spelling too.
        /// @returns Case name, G# source, expected diagnostic id.
        func RefusedLiterals() sequence[[]object] {
            // #4032's constraint check. On the parent this reported GS0157
            // ("Cannot find type Handler") — the wrong message for the wrong
            // reason. Now it reports the violation.
            yield []object{"a-literal-over-a-same-compilation-class-that-misses-the-bound", `package P
import System
import HelperLib2

class NotOptions {
    public var N int32
}

let bad = Handler[NotOptions]{Tag: "z"}
Console.WriteLine(bad.Tag)`, "GS0152"}
            // #4037's forwarding rule, reached through the literal.
            yield []object{"a-literal-over-an-unforwarded-type-parameter", `package P
import System
import HelperLib2

func viaOpen[T]() string {
    let h = Handler[T]{Tag: "p"}
    return h.Tag
}

Console.WriteLine(viaOpen[SchemeOptions]())`, "GS0580"}
        }

        private func CompileCSharpLibrary(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "HelperLib2",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "HelperLib2.dll")
            let result = compilation.Emit(libPath)
            Assert.True(
                result.Success,
                "the C# library must compile:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            return libPath
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
