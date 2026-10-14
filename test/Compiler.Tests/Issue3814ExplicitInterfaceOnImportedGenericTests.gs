// <copyright file="Issue3814ExplicitInterfaceOnImportedGenericTests.cs" company="GSharp">
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

/// Issue #3814 / ADR-0149: a class may explicitly implement the SAME member on
/// two different instantiations of one imported generic interface.
///
/// `StructSymbol.GetMethodsIncludingInherited` deduplicated the overload
/// set with `BoundScope.FunctionSignaturesEqual`, which — correctly for
/// ordinary overloads — ignores the return type. Two explicit implementations of
/// `IAsyncEnumerable[T].GetAsyncEnumerator(CancellationToken)` differ ONLY
/// in their return type, so the second was dropped from the overload set as if
/// it were an override of the first, and the interface-implementation check then
/// reported that interface unimplemented (GS0187). The dropped method was
/// whichever was declared second, so the diagnostic followed declaration order.
///
/// Every case EXECUTES and dispatches THROUGH the interface, because binding
/// alone cannot see whether the two `MethodImpl` rows landed on the right
/// slots — wiring both interface slots to one method is still verifiable IL.
open class Issue3814ExplicitInterfaceOnImportedGenericTests {
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func ExplicitInterfaceOnImportedGeneric_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3814_").FullName
        try {
            let outPath = CompileOrThrow(tempDir, name, source)
            IlVerifier.Verify(outPath)
            let (exit, output) = RunDotnet(outPath)
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

    /// Asserts the guard rails: shapes the narrowed hiding rule must NOT admit.
    /// @param name The case name.
    /// @param source The G# source.
    @Theory
    @MemberData("RejectedCases")
    func InvalidShape_IsStillRejected(name string, source string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3814_neg_").FullName
        try {
            let (exit, stdout, stderr) = Compile(tempDir, name, source)
            Assert.True(exit != 0, "'$name' must NOT compile — the #3814 fix is scoped to explicit-interface " + (`clauses naming DIFFERENT interface instantiations.
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const Preamble string = `
package P
import System
import System.Collections.Generic
import System.Threading
import System.Threading.Tasks

class EmptyEnum[T] : IAsyncEnumerator[T] {
    var cur T
    prop Current T { get { return cur } }
    func MoveNextAsync() ValueTask[bool] { return ValueTask[bool](false) }
    func DisposeAsync() ValueTask { return ValueTask() }
}
`

        /// Gets the executable cases: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            // The test/Core.Tests shape, reduced: two explicit implementations of
            // GetAsyncEnumerator, one per instantiation. The program dispatches
            // through EACH interface and the method itself reports which slot ran,
            // so a mis-wired MethodImpl row is observable.
            yield[]object{"two-instantiations-of-one-imported-generic-interface", Preamble + `
class Fwd : IAsyncEnumerable[int32], IAsyncEnumerable[string] {
    func (IAsyncEnumerable[int32]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int32] {
        Console.WriteLine("int-slot")
        return EmptyEnum[int32]()
    }

    func (IAsyncEnumerable[string]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[string] {
        Console.WriteLine("string-slot")
        return EmptyEnum[string]()
    }
}

let f = Fwd()
let a IAsyncEnumerable[int32] = f
let b IAsyncEnumerable[string] = f
let _ea = a.GetAsyncEnumerator(CancellationToken.None)
let _eb = b.GetAsyncEnumerator(CancellationToken.None)
`, []string{"int-slot", "string-slot"}}
            // The declaration order is reversed: on `origin/main` the diagnostic
            // followed whichever method came SECOND, so both orders must be proved.
            yield[]object{"two-instantiations-reversed-declaration-order", Preamble + `
class Fwd : IAsyncEnumerable[int32], IAsyncEnumerable[string] {
    func (IAsyncEnumerable[string]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[string] {
        Console.WriteLine("string-slot")
        return EmptyEnum[string]()
    }

    func (IAsyncEnumerable[int32]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int32] {
        Console.WriteLine("int-slot")
        return EmptyEnum[int32]()
    }
}

let f = Fwd()
let a IAsyncEnumerable[int32] = f
let b IAsyncEnumerable[string] = f
let _ea = a.GetAsyncEnumerator(CancellationToken.None)
let _eb = b.GetAsyncEnumerator(CancellationToken.None)
`, []string{"int-slot", "string-slot"}}
            // Three instantiations: the hiding rule dropped every method after the
            // first, so a two-case fix that only special-cased a pair would fail.
            yield[]object{"three-instantiations-of-one-imported-generic-interface", Preamble + `
class Fwd3 : IAsyncEnumerable[int32], IAsyncEnumerable[int64], IAsyncEnumerable[string] {
    func (IAsyncEnumerable[int32]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int32] {
        Console.WriteLine("i32")
        return EmptyEnum[int32]()
    }

    func (IAsyncEnumerable[int64]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int64] {
        Console.WriteLine("i64")
        return EmptyEnum[int64]()
    }

    func (IAsyncEnumerable[string]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[string] {
        Console.WriteLine("str")
        return EmptyEnum[string]()
    }
}

let f = Fwd3()
let a IAsyncEnumerable[int32] = f
let b IAsyncEnumerable[int64] = f
let c IAsyncEnumerable[string] = f
let _ea = a.GetAsyncEnumerator(CancellationToken.None)
let _eb = b.GetAsyncEnumerator(CancellationToken.None)
let _ec = c.GetAsyncEnumerator(CancellationToken.None)
`, []string{"i32", "i64", "str"}}
            // ANTI-VACUITY (passes on `origin/main` too): a SINGLE explicit clause
            // on an imported generic interface already worked — only the second
            // same-signature sibling was dropped. It must keep working.
            yield[]object{"single-explicit-clause-on-imported-generic-still-works", Preamble + `
class One : IAsyncEnumerable[int32] {
    func (IAsyncEnumerable[int32]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int32] {
        Console.WriteLine("only-slot")
        return EmptyEnum[int32]()
    }
}

let f = One()
let a IAsyncEnumerable[int32] = f
let _ea = a.GetAsyncEnumerator(CancellationToken.None)
`, []string{"only-slot"}}
            // The clause names an imported generic interface closed over the
            // declaring class's OWN type parameter. `target.ClrType` is the erased
            // `IEquatable[object]`, so the slot search saw `Equals(object)` against a
            // declaration saying `Equals(T)` and reported GS0494; the resolver now
            // matches through the open definition with the symbolic argument.
            yield[]object{"clause-on-imported-generic-closed-over-own-type-parameter", `
package P
import System

class Value[T] : IEquatable[T] {
    private func (IEquatable[T]) Equals(other T) bool -> true
}

let v = Value[int32]()
let e IEquatable[int32] = v
Console.WriteLine(e.Equals(1).ToString())
`, []string{"True"}}
            // The `List[T]` shape from the real corpus: an explicit non-generic
            // `IEnumerable.GetEnumerator()` alongside two generic instantiations,
            // reached through an inherited interface (`IReadOnlyCollection[T]`).
            yield[]object{"two-instantiations-reached-through-an-inherited-interface", `
package P
import System
import System.Collections
import System.Collections.Generic

class Conflict : IReadOnlyCollection[int32], IReadOnlyCollection[string] {
    prop Count int32 { get { return 0 } }

    func (IEnumerable[int32]) GetEnumerator() IEnumerator[int32] {
        return List[int32]().GetEnumerator()
    }

    func (IEnumerable[string]) GetEnumerator() IEnumerator[string] {
        return List[string]().GetEnumerator()
    }

    func (IEnumerable) GetEnumerator() IEnumerator {
        return List[int32]().GetEnumerator()
    }
}

let c = Conflict()
let a IReadOnlyCollection[int32] = c
let b IReadOnlyCollection[string] = c
Console.WriteLine(a.Count.ToString())
Console.WriteLine(b.Count.ToString())
`, []string{"0", "0"}}
            // ANTI-VACUITY (passes on `origin/main` too): the hiding rule the fix
            // narrows is what makes a real OVERRIDE replace its base method rather
            // than sit beside it as an ambiguous overload. A derived override must
            // still win, and the base entry must stay hidden.
            yield[]object{"derived-override-still-hides-the-base-method", `
package P
import System

open class Base {
    open func Speak() string { return "base" }
}

class Derived : Base {
    override func Speak() string { return "derived" }
}

let d = Derived()
Console.WriteLine(d.Speak())
let b Base = d
Console.WriteLine(b.Speak())
`, []string{"derived", "derived"}}
        }

        /// Gets the cases that must still be REJECTED, so the narrowed hiding rule
        /// did not open up plain duplicate overloads. Each is (name, source).
        /// @returns The case data.
        func RejectedCases() sequence[[]object] {
            // ANTI-VACUITY: two same-signature methods with NO explicit-interface
            // clause are still a duplicate overload (GS0264). The fix keys strictly
            // on the clause target.
            yield[]object{"plain-duplicate-overloads-still-rejected", `
package P
import System

class Dup {
    func M(x int32) int32 { return x }
    func M(x int32) string { return "no" }
}

Console.WriteLine("unreachable")
`}
            // ANTI-VACUITY: two clauses naming the SAME interface instantiation are
            // still duplicates — the clause target has to actually differ.
            yield[]object{"two-clauses-on-the-same-instantiation-still-rejected", Preamble + `
class SameTwice : IAsyncEnumerable[int32] {
    func (IAsyncEnumerable[int32]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int32] {
        return EmptyEnum[int32]()
    }

    func (IAsyncEnumerable[int32]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int32] {
        return EmptyEnum[int32]()
    }
}

Console.WriteLine("unreachable")
`}
            // ANTI-VACUITY: a clause naming a member the imported generic interface
            // does NOT declare is still GS0494 — the symbolic slot search widened
            // which signatures match, not whether a match is required.
            yield[]object{"clause-naming-a-nonexistent-member-still-rejected", `
package P
import System

class Value[T] : IEquatable[T] {
    func (IEquatable[T]) Equals(other T) bool -> true
    func (IEquatable[T]) NotAMember(other T) bool -> true
}

Console.WriteLine("unreachable")
`}
            // ANTI-VACUITY: an interface instantiation left with NO implementation
            // at all is still reported unimplemented — the fix must not have made
            // GS0187 unreachable for this shape.
            yield[]object{"unimplemented-second-instantiation-still-rejected", Preamble + `
class Missing : IAsyncEnumerable[int32], IAsyncEnumerable[string] {
    func (IAsyncEnumerable[int32]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int32] {
        return EmptyEnum[int32]()
    }
}

Console.WriteLine("unreachable")
`}
        }

        private func CompileOrThrow(tempDir string, name string, source string) string {
            let (exit, stdout, stderr) = Compile(tempDir, name, source)
            Assert.True(exit == 0, (`gsc failed for '` + "$name" + `':
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return Path.Combine(tempDir, name + ".dll")
        }

        private func Compile(tempDir string, name string, source string)(Exit int32, Stdout string, Stderr string) {
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let outPath = Path.Combine(tempDir, name + ".dll")
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
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
                return (Program.Main(args.ToArray()), compileOut.ToString(), compileErr.ToString())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
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
