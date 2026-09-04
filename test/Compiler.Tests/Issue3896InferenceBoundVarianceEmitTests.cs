// <copyright file="Issue3896InferenceBoundVarianceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3896: symbolic type-argument inference merges the bounds a call's
/// arguments contribute. Two facts have to hold together, and only IL
/// verification separates them.
/// <list type="number">
/// <item>Two class bounds from VALUE positions fix the type parameter at their
/// common base, the way C# fixing does. Without it
/// <c>ImmutableArray.Create(derived, base)</c> inferred
/// <c>ImmutableArray[Derived]</c> and a correct call would not bind
/// (GS0154) — argument-order-dependent inference.</item>
/// <item>A bound from a DELEGATE PARAMETER is an upper bound and must not
/// widen anything. <c>ImmutableArray[Derived].Where(pred)</c> with
/// <c>pred : func(Base) bool</c> stays <c>Where[Derived]</c>; widening it
/// to <c>Base</c> binds cleanly, emits a MethodSpec whose receiver no longer
/// matches, and produces IL the verifier rejects with
/// <c>StackUnexpected</c>.</item>
/// </list>
/// <para>These compile, ILVerify AND run the program: the bad instantiation in
/// (2) survived both binding and execution on this machine, so a run-only
/// assertion would have passed it. ILVerify is what catches it.</para>
/// </summary>
public class Issue3896InferenceBoundVarianceEmitTests
{
    [Fact]
    public void CommonBaseWidening_AndDelegateParameterBound_EmitVerifiableIl()
    {
        const string Source = @"
package Demo

import System
import System.Collections.Immutable
import System.Linq

open class Base {
    func tag() string { return ""base"" }
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

var pairLength = pair(Base()).Length
var keptCount = countKept(ImmutableArray.Create(Derived(), Derived()))
Console.WriteLine(""pair=$pairLength"")
Console.WriteLine(""kept=$keptCount"")
";

        var tempDir = Directory.CreateTempSubdirectory("gs_issue3896_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "Program.gs");
            File.WriteAllText(srcPath, Source);
            var outPath = Path.Combine(tempDir, "Program.dll");

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            // The discriminating assertion: the widening bug binds and runs.
            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi);
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            Assert.Contains("pair=2", stdout);
            Assert.Contains("kept=2", stdout);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }
}
