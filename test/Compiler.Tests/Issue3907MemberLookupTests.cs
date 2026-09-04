// <copyright file="Issue3907MemberLookupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3907: two defects in <c>TypeMemberModel.GetMethods</c>'s overload-set
/// construction, both found by the migrated
/// <c>src/Sdk/Gsharp.Runtime.Channels</c>.
/// </summary>
/// <remarks>
/// <para><b>Explicit-interface implementations leaked into simple-name
/// lookup.</b> An ADR-0149 <c>func (IFoo) Bar(…)</c> keeps its plain
/// <c>Name</c> in the symbol table — only the METADATA name is mangled — so it
/// joined the overload set for <c>Bar(…)</c> written inside the type. C# and
/// the CLR reach such a member only through the interface. In the channels
/// runtime, <c>Chan&lt;T&gt;</c>'s <c>bool ISendSelectableCore&lt;T&gt;.TrySendLocked</c>
/// therefore resolved its own <c>TrySendLocked(value, ref completions)</c> call
/// to ITSELF instead of the private <c>SendOutcome</c>-returning helper, and
/// the enum comparisons below it failed with
/// <c>GS0129 '==' is not defined for 'bool' and 'SendOutcome'</c>.</para>
/// <para><b>An override did not hide its base on a generic hierarchy.</b>
/// <c>class Derived[T] : Base[T]</c> gives each level its own
/// <c>TypeParameterSymbol</c> named <c>T</c>, so <c>Commit(value T)</c> on the
/// base and on the override were not signature-equal by symbol identity. Both
/// entered the overload set and every call became <c>GS0266 ambiguous between
/// multiple overloads</c> — which is what <c>SelectNode[DateTime].TryCommitReceive</c>
/// hit in <c>Timers</c>. The dedup now also consults the override link the
/// binder already recorded.</para>
/// <para>Both assertions RUN the emitted program: the explicit-interface case
/// is specifically about WHICH overload is selected, and a binding-only
/// assertion cannot tell a right selection from a wrong one that also
/// type-checks. ILVerify runs too, because the fix changes overload selection
/// and therefore the emitted call targets.</para>
/// </remarks>
public class Issue3907MemberLookupTests
{
    [Fact]
    public void ExplicitInterfaceImplementation_DoesNotJoinTheTypesOwnOverloadSet()
    {
        // `Box[T]`'s explicit implementation calls the SAME NAME expecting the
        // private `Outcome`-returning helper — the exact shape of
        // `Chan<T>.TrySendLocked`. Before the fix it bound to itself.
        const string source = @"
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
let sent = asInterface.TrySendLocked(""x"")
Console.WriteLine(""sent=$sent"")
";

        var lines = CompileVerifyAndRun(source);

        // The private helper answers `Sent`, so the explicit implementation's
        // `outcome == Outcome.Sent` is true. Before the fix this did not
        // compile at all; a variant of the defect that merely picked a
        // different overload would print `False`.
        Assert.Contains("sent=True", lines);
    }

    [Fact]
    public void OverrideOnAGenericHierarchy_HidesItsBaseDeclaration()
    {
        const string source = @"
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
Console.WriteLine(""commit=$commit"")
";

        var lines = CompileVerifyAndRun(source);

        Assert.Contains("commit=True", lines);
    }

    private static string[] CompileVerifyAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3907_lookup_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "Program.gs");
            File.WriteAllText(srcPath, source);
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

            return stdout
                .ReplaceLineEndings(Environment.NewLine)
                .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
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
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
