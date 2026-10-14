// <copyright file="Issue4028CollectionLiteralExplicitInterfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #4028: a collection literal — and an ordinary call with a
/// same-compilation argument — still reached an explicitly-implemented
/// interface member, so `List[int32]{"x"}` compiled and threw.
/// @remarks <b>What #4013 left open, and why.</b> #4013 took every abstract
/// interface member off a class's own surface, which is what C# does, and
/// `List[int32]().Add("x")` became `GS0159`. But the narrowing is
/// applied at candidate COLLECTION, which is memoized on `(Type, name)` and
/// cannot see arguments, so two exemptions had to be cut there instead — a
/// synthesized collection-initializer `Add`, and a call carrying a
/// same-compilation argument — and both re-admitted
/// `System.Collections.IList.Add(object)` and
/// `System.Collections.IDictionary.Add(object, object)` to calls that had
/// no erasure to repair. `List[int32]{"x"}` and
/// `Dictionary[string, int32]{"a": "x"}` went on compiling and throwing
/// `ArgumentException` from inside the BCL.
///
/// <b>The three tests that forced the exemptions, and what changed for
/// them.</b>
///
/// 1. `Issue3096CollectionSpreadEmitTests.FieldPropertyAndCollectionSpreads…` fills a
/// `Dictionary[K, V]` through the explicitly-implemented `ICollection<KeyValuePair<K, V>>.Add`. That
/// member is on a GENERIC interface, so on a constructed class receiver it is closed over the
/// receiver's own type arguments and cannot widen to `object` — it is not a hazard and is not a target
/// of this fix at all. It needs no exemption; it simply is not touched.
/// 2. `Issue3096CollectionSpreadEmitTests.UserDefinedSpreadConversions…` spreads a `[]Celsius` into a
/// `List[float64]`. A same-compilation struct has no CLR type while binding, so the element erases to
/// `object` and cannot match `Add(double)` — but the user-defined conversion `Celsius -> float64`
/// EXISTS, and asking the conversion classifier about the receiver's own `Add` on the real types finds
/// it. That is a genuine erasure to repair, so the widening member stays — and, since #4036, the
/// conversion the classifier finds here is also APPLIED, so the kept member no longer wins. The
/// exemption is no longer needed because the question is now asked directly rather than approximated by
/// "some argument is same-compilation".
/// 3. `Issue2918InlineLambdaErasedReceiverTests.ImportedGenericReceiverMethods…` adds a
/// `(item Mode) -> …` lambda to a `List[System.Action[Mode]]`. Here the RECEIVER carries the
/// same-compilation type: it is built over the flat `System.Object` placeholder of the
/// generic-CONSTRUCTION path and presents as `List<Action<object>>`, while the lambda erases the enum
/// and presents as `Action<int>`. Its own members' parameter types are surrogates, so nothing here can
/// judge the call and the widening member stays. That is #4016's defect one site over — the two erasers
/// of one type disagree — and it is still open; this fixture's row keeps it working until it is fixed
/// there.
///
/// <b>What is left is the reported hole and only it.</b> A genuine
/// `string` at a genuine `int32`, or a same-compilation
/// `Celsius` at an `int32` it does not convert to: no erasure to
/// repair, so the widening member goes and the call reports `GS0159` — the
/// same diagnostic the author-written form already reported, which is the bar
/// the issue sets.
///
/// <b>Why not the fix order the issue's comment suggests.</b> It proposes
/// repairing the generic-CONSTRUCTION placeholder the way #4016 repaired the
/// method-type-argument one, so exemption (3) closes by deletion. Measured
/// against the cost: #4016's own version of that change leaked its surrogate
/// into a sibling type parameter's CONSTRAINT and took the
/// `cs2gs-code-exploder` gate red, and needed
/// `NormaliseErasedTypeArgsForConstraintCheck` to survive. The
/// construction-site placeholder is load-bearing for every constructed generic
/// in the language rather than for one call's type-argument list, so the same
/// change there is a larger blast radius than this issue. Both of the shapes
/// #4028 actually reports close without it, at applicability, which is where the
/// issue's own body says the discrimination has to happen. The Issue2918
/// disagreement stays filed as #4016-adjacent work.
///
/// <b>Out of scope here, and now CLOSED by #4036.</b>
/// `List[float64]().Add(someCelsius)` — the author-written form of row (2),
/// with the user-defined conversion in scope — compiled and threw
/// `ArgumentException` when this fixture was written: the widening member
/// is correctly kept (the conversion exists), but the ordinary call path bound
/// it instead of applying the conversion at the type's own `Add(double)`.
/// That was a conversion-application bug rather than a candidacy one, filed as
/// #4036 and fixed there. This fixture's decision is unchanged by that fix —
/// the widening member is still KEPT here, exactly as described above; #4036
/// only makes it stop WINNING, by converting the argument to the own member's
/// parameter type before applicability runs. See
/// `Issue4036CollectionCallUserDefinedConversionTests`.
///
/// <b>A case the review raised, and what it measures as.</b> A collection
/// literal whose ELEMENT type is declared in this compilation —
/// `enum Mode { First }; List[Mode]{"x"}` — was suggested to be an open
/// hole, on the reading that keeping the member for an erased receiver waves it
/// through. It does not: such a receiver binds its own `Add` through the
/// SYMBOLIC member path, where the argument is converted against the real
/// element type, so the wrong element is refused with `GS0155` before any
/// widening member is reached — in the literal form and the author-written form
/// alike, and on `main` as well as here. Rows below pin it for an enum, a
/// class and an author-written call.
///
/// Not channel business, so no ADR-0174 erratum.
open class Issue4028CollectionLiteralExplicitInterfaceTests {
    /// A call with a genuine argument that simply does not fit no longer reaches
    /// a widening explicitly-implemented interface member.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("RejectedCases")
    func AWideningExplicitInterfaceMember_IsNotReachedWithNothingToRepair(
        name string,
        source string,
        expectedId string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4028_neg_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Every legitimate neighbour still binds, compiles to verifiable IL and
    /// runs — including the three dependencies #4013 measured.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("BindingCases")
    func ALegitimateNeighbour_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4028_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath)
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

    shared {
        /// How long a compiled case may run before it counts as hung.
        private const RunTimeout int32 = 60_000

        /// The calls that reached a widening explicit-interface member with nothing
        /// to repair, and are refused now.
        /// @returns Case name, G# source, expected diagnostic id.
        func RejectedCases() sequence[[]object] {
            // RED BEFORE: compiled; threw ArgumentException from
            // List<int>.System.Collections.IList.Add(object). The issue's repro.
            yield[]object{"a-collection-literal-with-a-wrong-element-no-longer-reaches-ilist-add", `package P
import System
import System.Collections.Generic

let ys = List[int32]{"x"}
Console.WriteLine(ys.Count)`, "GS0159"}
            // RED BEFORE: the same hole one interface over —
            // Dictionary<K, V>.System.Collections.IDictionary.Add(object, object).
            yield[]object{"a-dictionary-literal-with-a-wrong-value-no-longer-reaches-idictionary-add", `package P
import System
import System.Collections.Generic

let d = Dictionary[string, int32]{"a": "x"}
Console.WriteLine(d.Count)`, "GS0159"}
            // RED BEFORE: the comment's second shape — an ordinary call whose
            // argument carries a same-compilation type that does NOT convert.
            yield[]object{"an-ordinary-call-with-a-same-compilation-argument-that-does-not-convert", `package P
import System
import System.Collections.Generic

struct Celsius {
    var Degrees float64
}

let ys = List[int32]()
ys.Add(Celsius{ Degrees: 2.5 })
Console.WriteLine(ys.Count)`, "GS0159"}
            // RED BEFORE: the two-argument form of the same, on IDictionary.
            yield[]object{"a-dictionary-add-with-a-same-compilation-argument-that-does-not-convert", `package P
import System
import System.Collections.Generic

struct Celsius {
    var Degrees float64
}

let d = Dictionary[string, int32]()
d.Add("a", Celsius{ Degrees: 1.0 })
Console.WriteLine(d.Count)`, "GS0159"}
            // Review finding: a collection literal whose ELEMENT type is declared
            // in this compilation was suggested to be an open hole, on the reading
            // that the erased-receiver escape waves it through. Measured, it is
            // not: a `List[Mode]` / `List[Thing]` / `List[Celsius]` receiver binds
            // its own `Add` through the SYMBOLIC member path, where the argument is
            // converted against the real element type, so a wrong element is
            // refused with GS0155 before any widening member can be reached — in
            // the literal form and the author-written form alike, and before this
            // PR as well as after. Pinned in all three element kinds so the claim
            // is checked rather than argued.
            yield[]object{"a-literal-of-a-same-compilation-enum-refuses-a-wrong-element", `package P
import System
import System.Collections.Generic

enum Mode { First }

let xs = List[Mode]{"x"}
Console.WriteLine(xs.Count)`, "GS0155"}
            yield[]object{"a-literal-of-a-same-compilation-class-refuses-a-wrong-element", `package P
import System
import System.Collections.Generic

class Thing {
}

let xs = List[Thing]{"x"}
Console.WriteLine(xs.Count)`, "GS0155"}
            yield[]object{"an-author-written-add-of-a-same-compilation-element-refuses-it-too", `package P
import System
import System.Collections.Generic

enum Mode { First }

let xs = List[Mode]()
xs.Add("x")
Console.WriteLine(xs.Count)`, "GS0155"}
            // GREEN BEFORE (already refused by #4013). The author-written control
            // this issue's Expected section measures itself against: the literal
            // must now report what this reports.
            yield[]object{"the-author-written-control-still-reports-the-same-diagnostic", `package P
import System
import System.Collections.Generic

let ys = List[int32]()
ys.Add("x")
Console.WriteLine(ys.Count)`, "GS0159"}
        }

        /// The neighbours that must keep binding: the three dependencies #4013
        /// measured, and the ordinary well-typed spellings.
        /// @returns Case name, G# source, expected stdout lines.
        func BindingCases() sequence[[]object] {
            // Dependency (1): a GENERIC explicit interface member, never a target.
            yield[]object{"a-dictionary-spread-still-fills-through-the-explicit-generic-add", `package P
import System
import System.Collections.Generic

let pairs = []KeyValuePair[string, int32]{
    KeyValuePair[string, int32]("a", 1),
    KeyValuePair[string, int32]("b", 2),
}
let d = Dictionary[string, int32](){ ...pairs }
Console.WriteLine(d.Count)`, []string{"2"}}
            // Dependency (2): a genuine erasure to repair — the conversion exists.
            yield[]object{"a-user-defined-spread-conversion-still-reaches-the-widening-add", `package P
import System
import System.Collections.Generic

struct Celsius {
    var Degrees float64
}

func operator implicit(value Celsius) float64 {
    return value.Degrees
}

let source = []Celsius{ Celsius{ Degrees: 2.5 } }
let array = []float64{ ...source }
let list = List[float64](){ ...source }
Console.WriteLine(array[0])
Console.WriteLine(list[0])`, []string{"2.5", "2.5"}}
            // Dependency (3): an ERASED RECEIVER, whose own members are surrogates.
            yield[]object{"an-erased-receiver-still-reaches-the-widening-add", `package P
import System
import System.Collections.Generic

enum Mode { First, Second }

let enumCallbacks = List[System.Action[Mode]]()
enumCallbacks.Add((item Mode) -> Console.WriteLine(17))
enumCallbacks[0](Mode.Second)`, []string{"17"}}
            // A well-typed literal binds the type's OWN Add, as it always did.
            yield[]object{"a-well-typed-collection-literal-still-binds-the-types-own-add", `package P
import System
import System.Collections.Generic

let ys = List[int32]{1, 2, 3}
Console.WriteLine(ys.Count)
Console.WriteLine(ys[2])`, []string{"3", "3"}}
            // A well-typed map literal, the sibling of the rejected row above.
            yield[]object{"a-well-typed-dictionary-literal-still-binds", `package P
import System
import System.Collections.Generic

let d = Dictionary[string, int32]{"a": 1, "b": 2}
Console.WriteLine(d.Count)
Console.WriteLine(d["b"])`, []string{"2", "2"}}
            // An INTERFACE-typed receiver still reaches the member for real — the
            // "Expected" #4013 gives for anyone who wants IList.Add(object).
            yield[]object{"an-interface-typed-receiver-still-reaches-the-widening-member", `package P
import System
import System.Collections
import System.Collections.Generic

let ys = List[int32]()
cast[IList](ys).Add(7)
Console.WriteLine(ys.Count)
Console.WriteLine(ys[0])`, []string{"1", "7"}}
            // A same-compilation element in a literal of its OWN type: the argument
            // is erased, but the type's own Add takes it, so nothing is dropped.
            yield[]object{"a-literal-of-a-same-compilation-element-still-binds", `package P
import System
import System.Collections.Generic

struct Celsius {
    var Degrees float64
}

let xs = List[Celsius]{ Celsius{ Degrees: 1.5 } }
Console.WriteLine(xs.Count)
Console.WriteLine(xs[0].Degrees)`, []string{"1", "1.5"}}
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
