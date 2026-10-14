// <copyright file="Issue3907MemberLookupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3907: two defects in `TypeMemberModel.GetMethods`'s overload-set
/// construction, both found by the migrated
/// `src/Sdk/Gsharp.Runtime.Channels`.
/// @remarks <b>Explicit-interface implementations leaked into simple-name
/// lookup.</b> An ADR-0149 `func (IFoo) Bar(…)` keeps its plain
/// `Name` in the symbol table — only the METADATA name is mangled — so it
/// joined the overload set for `Bar(…)` written inside the type. C# and
/// the CLR reach such a member only through the interface. In the channels
/// runtime, `Chan<T>`'s `bool ISendSelectableCore<T>.TrySendLocked`
/// therefore resolved its own `TrySendLocked(value, ref completions)` call
/// to ITSELF instead of the private `SendOutcome`-returning helper, and
/// the enum comparisons below it failed with
/// `GS0129 '==' is not defined for 'bool' and 'SendOutcome'`.
///
/// <b>An override did not hide its base on a generic hierarchy.</b>
/// `class Derived[T] : Base[T]` gives each level its own
/// `TypeParameterSymbol` named `T`, so `Commit(value T)` on the
/// base and on the override were not signature-equal by symbol identity. Both
/// entered the overload set and every call became `GS0266 ambiguous between
/// multiple overloads` — which is what `SelectNode[DateTime].TryCommitReceive`
/// hit in `Timers`. The dedup now also consults the override link the
/// binder already recorded.
///
/// Both assertions RUN the emitted program: the explicit-interface case
/// is specifically about WHICH overload is selected, and a binding-only
/// assertion cannot tell a right selection from a wrong one that also
/// type-checks. ILVerify runs too, because the fix changes overload selection
/// and therefore the emitted call targets.
open class Issue3907MemberLookupTests {
    @Fact
    func ExplicitInterfaceImplementation_DoesNotJoinTheTypesOwnOverloadSet() {
        // `Box[T]`'s explicit implementation calls the SAME NAME expecting the
        // private `Outcome`-returning helper — the exact shape of
        // `Chan<T>.TrySendLocked`. Before the fix it bound to itself.
        const source = `
package Demo

import System

internal enum Outcome { Sent, Full }

interface ISend[T] {
    func TrySendLocked(value T) bool;
}

class Box[T] : ISend[T] {
    internal func (ISend[T]) TrySendLocked(value T) bool {
        let outcome = TrySendLocked(value)
        return outcome == Outcome.Sent
    }

    private func TrySendLocked(value T) Outcome -> Outcome.Sent
}

let asInterface ISend[string] = Box[string]()
let sent = asInterface.TrySendLocked("x")
Console.WriteLine("sent=$sent")
`
        let lines = CompileVerifyAndRun(source)
        // The private helper answers `Sent`, so the explicit implementation's
        // `outcome == Outcome.Sent` is true. Before the fix this did not
        // compile at all; a variant of the defect that merely picked a
        // different overload would print `False`.
        Assert.Contains("sent=True", lines)
    }

    @Fact
    func OverrideOnAGenericHierarchy_HidesItsBaseDeclaration() {
        const source = `
package Demo

import System

open class Base[T] {
    internal open func Commit(value T) bool;
}

class Derived[T] : Base[T] {
    internal override func Commit(value T) bool -> true
}

func Go(n Derived[int32]) bool -> n.Commit(1)

let commit = Go(Derived[int32]())
Console.WriteLine("commit=$commit")
`
        let lines = CompileVerifyAndRun(source)
        Assert.Contains("commit=True", lines)
    }

    shared {
        private func CompileVerifyAndRun(source string)[]string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3907_lookup_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "Program.gs")
                File.WriteAllText(srcPath, source)
                let outPath = Path.Combine(tempDir, "Program.dll")
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`sample exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine).Split(
                    Environment.NewLine,
                    StringSplitOptions.RemoveEmptyEntries
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
