// <copyright file="Issue3896InferenceBoundVarianceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3896: symbolic type-argument inference merges the bounds a call's
/// arguments contribute. Two facts have to hold together, and only IL
/// verification separates them.
/// 1. Two class bounds from VALUE positions fix the type parameter at their common base, the way C#
/// fixing does. Without it `ImmutableArray.Create(derived, base)` inferred `ImmutableArray[Derived]`
/// and a correct call would not bind (GS0154) — argument-order-dependent inference.
/// 2. A bound from a DELEGATE PARAMETER is an upper bound and must not widen anything.
/// `ImmutableArray[Derived].Where(pred)` with `pred : func(Base) bool` or `func(object) bool` stays
/// `Where[Derived]`; widening it to `Base` binds cleanly, emits a MethodSpec whose receiver no longer
/// matches, and produces IL the verifier rejects with `StackUnexpected`.
///
/// These compile, ILVerify AND run the program: the bad instantiation in
/// (2) survived both binding and execution on this machine, so a run-only
/// assertion would have passed it. ILVerify is what catches it.
open class Issue3896InferenceBoundVarianceEmitTests {
    @Fact
    func CommonBaseWidening_AndDelegateParameterBound_EmitVerifiableIl() {
        const Source = (`
package Demo

import System
import System.Collections.Immutable
import System.Linq

open class Base {
    func tag() string { return "base" }
}

class Derived : Base {
}

// (1) The derived argument comes FIRST; T must still fix at Base.
func pair(b Base) ImmutableArray[Base] {
    return ImmutableArray.Create(Derived(), b)
}

// (2) The predicate's parameter is the BASE; T must stay Derived so the
// MethodSpec matches the ImmutableArray[Derived] receiver.
func countKept(items ImmutableArray[Derived]) int32 {
    let keep = func (b Base) bool { return b != nil }
    return items.Where(keep).ToList().Count
}

// (3) ` + "`" + `object` + "`" + ` is also only an upper bound. It must not replace Derived
// in the emitted Where MethodSpec.
func countObjectKept(items ImmutableArray[Derived]) int32 {
    let keep = func (value object) bool { return value != nil }
    return items.Where(keep).ToList().Count
}

var pairLength = pair(Base()).Length
var keptCount = countKept(ImmutableArray.Create(Derived(), Derived()))
var objectKeptCount = countObjectKept(ImmutableArray.Create(Derived(), Derived()))
Console.WriteLine("pair=$pairLength")
Console.WriteLine("kept=$keptCount")
Console.WriteLine("object-kept=$objectKeptCount")
`)
        let tempDir = Directory.CreateTempSubdirectory("gs_issue3896_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, Source)
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
            // The discriminating assertion: the widening bug binds and runs.
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
            Assert.Contains("pair=2", stdout)
            Assert.Contains("kept=2", stdout)
            Assert.Contains("object-kept=2", stdout)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { }
        }
    }
}
