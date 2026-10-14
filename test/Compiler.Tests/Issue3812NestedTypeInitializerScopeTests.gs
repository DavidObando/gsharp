// <copyright file="Issue3812NestedTypeInitializerScopeTests.cs" company="GSharp">
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

/// Issue #3812: a nested type's field <b>initializer</b> can name the enclosing
/// type's type parameters, the same way its field <b>declaration</b> already
/// could.
///
/// Issue #1537 gave nested-type member binding the enclosing type parameters by
/// seeding `binderCtx.CurrentTypeParameters` with
/// `CollectEnclosingTypeParameters(...)` in
/// `BindStructDeclarationBody`. Field initializers, however, are bound from
/// a DEFERRED closure (issue #1194) that runs after that scope has unwound and
/// rebuilds it from scratch — and rebuilt it from
/// `structSymbol.TypeParameters` alone. So
/// `class Outer[T] { class Inner { var item T } }` bound, while adding an
/// initializer — `var item T = default(T)` — failed on the initializer
/// only, with `GS0113 "Type 'T' doesn't exist"`.
///
/// This is one of the two errors walling
/// `bench/concurrency/clr/ClrBaseline` out of the issue #3501
/// self-migration gate: its `Hchan<T>.Waiter` nested class carries
/// `internal T item = default!;`.
///
/// Every case EXECUTES: an initializer that silently bound to the WRONG
/// type parameter (an outer/inner shadowing mistake) would still compile and
/// still verify; only the stored value tells them apart.
open class Issue3812NestedTypeInitializerScopeTests {
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func NestedTypeInitializer_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3812_").FullName
        try {
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
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, "gsc failed for '$name' (a GS0113 here is the #3812 deferred-initializer " + (`scope):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
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

    shared {
        /// Gets the executable cases: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            // The reduction of the defect.
            yield[]object{"nested-initializer-names-enclosing-type-parameter", `
package P
import System

class Outer[T] {
    class Inner {
        var item T = default(T)
    }

    func Fresh() Inner -> Inner()

    func Make(v T) Inner {
        let i = Inner()
        i.item = v
        return i
    }
}

let o = Outer[int32]()
Console.WriteLine(o.Fresh().item.ToString())
Console.WriteLine(o.Make(7).item.ToString())
`, []string{"0", "7"}}
            // The ClrBaseline shape: an enclosing-parameterised initializer sitting
            // beside a field whose type mentions the nested type itself.
            yield[]object{"hchan-waiter-shape", `
package P
import System
import System.Collections.Generic

class Hchan[T] {
    private let q Queue[Waiter] = Queue[Waiter]()

    class Waiter {
        var next Waiter?
        var item T = default(T)
    }

    func Push(v T) {
        let w = Waiter()
        w.item = v
        q.Enqueue(w)
    }

    func Pop() T -> q.Dequeue().item
}

let h = Hchan[string]()
h.Push("go")
Console.WriteLine(h.Pop())
`, []string{"go"}}
            // ANTI-VACUITY: with BOTH levels generic and DIFFERENT names, each
            // initializer must pick its own level's parameter. A scope that merely
            // "has some type parameters" would pass the first case and fail here.
            yield[]object{"inner-and-outer-parameters-are-distinguished", `
package P
import System

class Outer[T] {
    class Inner[U] {
        var outerItem T = default(T)
        var innerItem U = default(U)

        func Describe() string -> outerItem.ToString()!! + "|" + (if innerItem == nil { "nil" } else { "not-nil" })
    }

    func Describe[U]() string -> Inner[U]().Describe()
}

Console.WriteLine(Outer[int32]().Describe[string]())
`, []string{"0|nil"}}
            // ANTI-VACUITY: an inner parameter that SHADOWS the outer's name must
            // win inside the nested type — the outermost-first seeding order.
            yield[]object{"inner-parameter-shadows-same-named-outer", `
package P
import System

class Outer[T] {
    class Inner[T] {
        var item T = default(T)

        func Describe() string -> item.ToString()!!
    }

    func Describe[U]() string -> Inner[U]().Describe()
}

Console.WriteLine(Outer[string]().Describe[int32]())
`, []string{"0"}}
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
