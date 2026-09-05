// <copyright file="Issue3939GenericStaticSiblingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3939: two emit paths that reason about GENERIC context and disagreed
/// with a sibling path a few lines away — the #3705 defect class, swept for in
/// the emitter rather than waiting for a migrated app to trip over it.
/// </summary>
/// <remarks>
/// <para>Finding A: a <c>shared</c> (static) call chose EITHER a
/// TypeSpec-parented MemberRef (naming which type owns the method, #1209 /
/// #1433) OR a MethodSpec (naming how the METHOD is instantiated, ADR-0087
/// §3 R3+R4) with an <c>else if</c>. Those are independent axes and a
/// <c>shared func Make[U]()</c> on a generic <c>Box[T]</c> needs both. The
/// INSTANCE sibling in <c>MethodBodyEmitter.Calls.cs</c> — and
/// <c>EmitMethodGroupTarget</c> in <c>MethodBodyEmitter.Closures.cs</c> — have
/// always applied them sequentially.</para>
/// <para>Finding B: <c>StateMachineEmitter.EmitAsyncKickoffBody</c> re-derived
/// the type parameters in scope at an async kickoff instead of reading the list
/// its state machine was REIFIED from, and its copy never picked up the
/// <c>StaticOwnerType</c> half that #3932 root C added to the reification. Both
/// now route through one primitive.</para>
/// <para>Grouped by EMITTED IL, not by symptom: finding A's four surface shapes
/// print three different diagnostics (ILVerify <c>[found ref
/// 'string'][expected ref '!!0']</c>, <c>InvalidOperationException</c> "not
/// fully instantiated", and — once A is fixed — B's <c>TypeLoadException</c>)
/// and are one cause, <c>call &lt;TypeSpec-parented MemberRef naming an open
/// generic method&gt;</c>.</para>
/// <para>Every test COMPILES, ILVERIFIES, RUNS and asserts on behaviour. All
/// three are load-bearing on the #3501 effort: within one week a defect
/// ILVerified clean and threw <c>TypeLoadException</c> at load (#3936), and
/// another passed an executing test and was caught only by ILVerify (#3900).
/// Two tests additionally read the emitted metadata back, because "the token is
/// a MethodSpec, not a bare MemberRef" and "the state machine's arity equals
/// its self-instantiation's argument count" are encoding facts no behavioural
/// assertion can name.</para>
/// <para>Discrimination (ADR-0154): every test carries controls that passed
/// BEFORE the fix — the same construct in its instance form, its non-generic-
/// method form, and its non-generic-encloser form — so a mutant that applies
/// the new path unconditionally is caught as surely as one that never applies
/// it.</para>
/// </remarks>
public class Issue3939GenericStaticSiblingEmitTests
{
    /// <summary>
    /// Finding A, the plain shape: a generic <c>shared</c> method on a generic
    /// user CLASS. Before the fix the call emitted a TypeSpec-parented MemberRef
    /// naming the OPEN generic method and no MethodSpec at all.
    /// </summary>
    [Fact]
    public void GenericSharedMethodOnAGenericClass_GetsBothTheTypeSpecParentAndTheMethodSpec()
    {
        const string source = @"
package main

import System

class Holder[T] {
    shared {
        // The failing shape: BOTH the owner and the method are generic.
        func Plain[U](v T, other U) string -> v.ToString() + ""|"" + other.ToString()

        // Control: a NON-generic shared method on the same generic type. #1209
        // gave this a TypeSpec-parented MemberRef and no MethodSpec, which is
        // right; a mutant that adds a MethodSpec unconditionally breaks it.
        func PlainNG(v T) string -> ""ng:"" + v.ToString()
    }

    // Control: the INSTANCE form of the failing shape, which has always
    // resolved the TypeSpec parent and the MethodSpec sequentially.
    func PlainInst[U](v T, other U) string -> v.ToString() + ""/"" + other.ToString()
}

// Control: a generic shared method on a NON-generic type, which needs a bare
// MethodDef parent and a MethodSpec — the other half of the pair.
class Flat {
    shared {
        func Plain[U](other U) string -> ""flat/"" + other.ToString()
    }
}

Console.WriteLine(""shared="" + Holder[int32].Plain[string](41, ""b""))
Console.WriteLine(""shared-other-inst="" + Holder[string].Plain[int32](""q"", 3))
Console.WriteLine(""shared-ng="" + Holder[int32].PlainNG(5))
Console.WriteLine(""inst="" + Holder[int32]().PlainInst[string](7, ""c""))
Console.WriteLine(""flat="" + Flat.Plain[int32](9))
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source, out var assemblyPath);

        // Behaviour: both type arguments really reached the callee, and the
        // SECOND instantiation pins that the MethodSpec is per-call rather than
        // a single cached one — `Holder[string].Plain[int32]` swaps both.
        Assert.Contains("shared=41|b", lines);
        Assert.Contains("shared-other-inst=q|3", lines);
        Assert.Contains("shared-ng=ng:5", lines);
        Assert.Contains("inst=7/c", lines);
        Assert.Contains("flat=flat/9", lines);
        Assert.Equal("done", lines[^1]);

        // Encoding: the token kind IS the bug. A MethodSpec is what carries the
        // method instantiation; before the fix the site emitted the MemberRef
        // directly. The control's kind must stay MemberReference, so a mutant
        // that MethodSpecs every static call on a generic type is caught here.
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var reader = pe.GetMetadataReader();
        var kinds = CallTokenKinds(reader, pe, "<Program>", "<Main>$");

        Assert.Contains(HandleKind.MethodSpecification, kinds);
        Assert.Contains(HandleKind.MemberReference, kinds);
    }

    /// <summary>
    /// Finding A on a generic user INTERFACE — the #1433 branch, which resolved
    /// its TypeSpec-parented MemberRef and then <c>break</c>ed out of the case
    /// entirely, so it could never reach the MethodSpec (or the #3226
    /// nullable-lift unwrap) below.
    /// </summary>
    [Fact]
    public void GenericSharedMethodOnAGenericInterface_GetsBothTheTypeSpecParentAndTheMethodSpec()
    {
        const string source = @"
package main

import System

interface IBox[T] {
    shared {
        // The failing shape.
        func Make[U](v T, other U) string {
            return v.ToString() + ""|"" + other.ToString()
        }

        // Control: #1433's original shape, which must keep working unchanged.
        func MakeNG(v T) string {
            return ""ng:"" + v.ToString()
        }
    }
}

// Control: a generic shared method on a NON-generic interface.
interface IFlat {
    shared {
        func Make[U](other U) string {
            return ""flat/"" + other.ToString()
        }
    }
}

Console.WriteLine(""iface="" + IBox[int32].Make[string](41, ""b""))
Console.WriteLine(""iface-ng="" + IBox[int32].MakeNG(5))
Console.WriteLine(""iface-flat="" + IFlat.Make[int32](9))
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source, out _);

        Assert.Contains("iface=41|b", lines);
        Assert.Contains("iface-ng=ng:5", lines);
        Assert.Contains("iface-flat=flat/9", lines);
        Assert.Equal("done", lines[^1]);
    }

    /// <summary>
    /// Finding A reached through an ITERATOR kickoff: a generic <c>shared</c>
    /// iterator on a generic type. The state-machine machinery was never at
    /// fault here — the CALL to the kickoff was — which is precisely why
    /// grouping by symptom would have mis-attributed this to
    /// <c>StateMachineEmitter</c>.
    /// </summary>
    [Fact]
    public void GenericSharedIteratorOnAGenericType_RunsToCompletion()
    {
        const string source = @"
package main

import System

class Holder[T] {
    var seed T

    init(seed T) {
        this.seed = seed
    }

    shared {
        // The failing shape.
        func WalkSharedG[U](v T, other U) sequence[string] {
            yield v.ToString()
            yield other.ToString()
        }

        // Control: a non-generic shared iterator on the same generic type.
        func WalkShared(v T) sequence[string] {
            yield v.ToString()
        }
    }

    // Control: the instance generic iterator form.
    func WalkInstanceG[U](other U) sequence[string] {
        yield seed.ToString()
        yield other.ToString()
    }
}

for x in Holder[int32].WalkSharedG[string](41, ""b"") {
    Console.WriteLine(""sg="" + x)
}

for x in Holder[int32].WalkShared(5) {
    Console.WriteLine(""s="" + x)
}

for x in Holder[int32](7).WalkInstanceG[string](""c"") {
    Console.WriteLine(""ig="" + x)
}

Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source, out _);

        // The ORDER matters: an iterator that ran but yielded in the wrong
        // order, or dropped an element, is not caught by a Contains-only check.
        Assert.Equal(
            new[] { "sg=41", "sg=b", "s=5", "ig=7", "ig=c", "done" },
            lines);
    }

    /// <summary>
    /// Finding B: with A fixed, a generic <c>shared async</c> method on a
    /// generic type still failed, because <c>EmitAsyncKickoffBody</c> derived
    /// the kickoff's in-scope type parameters from <c>ReceiverType</c> alone —
    /// the very <c>StaticOwnerType</c> gap #3932 root C closed one file over,
    /// on the reification side. The struct was reified at arity 2 and
    /// self-instantiated with 1 argument: <c>TypeLoadException</c>, "used with
    /// the wrong number of generic arguments".
    /// </summary>
    [Fact]
    public void GenericSharedAsyncOnAGenericType_SelfInstantiatesAtTheReifiedArity()
    {
        const string source = @"
package main

import System
import System.Threading.Tasks

class Holder[T] {
    var seed T

    init(seed T) {
        this.seed = seed
    }

    shared {
        // The failing shape: BOTH the encloser and the kickoff are generic,
        // and the kickoff is `shared`.
        async func FetchSharedG[U](v T, other U) ValueTask[string] {
            await Task.Yield()
            return v.ToString() + ""|"" + other.ToString()
        }

        // Control: a NON-generic `shared async` on a generic type — #3932
        // root C's shape, arity 1, which must stay at arity 1.
        async func FetchShared(v T) ValueTask[string] {
            await Task.Yield()
            return ""ng:"" + v.ToString()
        }
    }

    // Control: the INSTANCE generic async form on a generic type, arity 2,
    // which was already right.
    async func FetchInstanceG[U](other U) ValueTask[string] {
        await Task.Yield()
        return seed.ToString() + ""/"" + other.ToString()
    }
}

// Control: a generic `shared async` on a NON-generic type, arity 1 (the
// method's own U only).
class Flat {
    shared {
        async func FetchSharedG[U](other U) ValueTask[string] {
            await Task.Yield()
            return ""flat/"" + other.ToString()
        }
    }
}

Console.WriteLine(""sg="" + Holder[int32].FetchSharedG[string](41, ""b"").AsTask().GetAwaiter().GetResult())
Console.WriteLine(""s="" + Holder[int32].FetchShared(5).AsTask().GetAwaiter().GetResult())
Console.WriteLine(""ig="" + Holder[int32](7).FetchInstanceG[string](""c"").AsTask().GetAwaiter().GetResult())
Console.WriteLine(""flat="" + Flat.FetchSharedG[int32](9).AsTask().GetAwaiter().GetResult())
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source, out var assemblyPath);

        Assert.Contains("sg=41|b", lines);
        Assert.Contains("s=ng:5", lines);
        Assert.Contains("ig=7/c", lines);
        Assert.Contains("flat=flat/9", lines);
        Assert.Equal("done", lines[^1]);

        // Encoding: the arity of each state machine, read straight out of the
        // metadata. The failing shape is 2 (T then U); every control pins a
        // DIFFERENT expected arity, so a mutant that reifies unconditionally at
        // 2 — or that reverts to `ReceiverType` only — is caught.
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var reader = pe.GetMetadataReader();

        Assert.Equal(2, StateMachineGenericParameterCount(reader, "FetchSharedG", "Holder`1"));
        Assert.Equal(1, StateMachineGenericParameterCount(reader, "FetchShared", "Holder`1"));
        Assert.Equal(2, StateMachineGenericParameterCount(reader, "FetchInstanceG", "Holder`1"));
        Assert.Equal(1, StateMachineGenericParameterCount(reader, "FetchSharedG", "Flat"));
    }

    /// <summary>
    /// Returns the distinct handle kinds of every <c>call</c> token in
    /// <paramref name="methodName"/>.
    /// </summary>
    /// <param name="reader">The metadata reader.</param>
    /// <param name="pe">The PE reader.</param>
    /// <param name="typeName">The declaring type's metadata name.</param>
    /// <param name="methodName">The method whose body is scanned.</param>
    /// <returns>The set of token kinds appearing on <c>call</c> instructions.</returns>
    private static HashSet<HandleKind> CallTokenKinds(
        MetadataReader reader,
        PEReader pe,
        string typeName,
        string methodName)
    {
        var type = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(t => reader.GetString(t.Name) == typeName);

        var method = type.GetMethods()
            .Select(reader.GetMethodDefinition)
            .Single(m => reader.GetString(m.Name) == methodName);

        var il = pe.GetMethodBody(method.RelativeVirtualAddress).GetILContent();
        var kinds = new HashSet<HandleKind>();

        // `call` is 0x28 followed by a 4-byte token. Scanning for the opcode
        // byte can in principle land inside an operand; every hit is therefore
        // required to decode to a token kind that a `call` can legally carry,
        // and the assertions only ever check for PRESENCE of a kind.
        for (var i = 0; i + 4 < il.Length; i++)
        {
            if (il[i] != 0x28)
            {
                continue;
            }

            var token = il[i + 1] | (il[i + 2] << 8) | (il[i + 3] << 16) | (il[i + 4] << 24);
            if (token == 0)
            {
                continue;
            }

            var kind = MetadataTokens.EntityHandle(token).Kind;
            if (kind is HandleKind.MethodDefinition or HandleKind.MemberReference or HandleKind.MethodSpecification)
            {
                kinds.Add(kind);
            }
        }

        return kinds;
    }

    /// <summary>
    /// Returns the generic-parameter count of the state machine synthesized for
    /// <paramref name="methodName"/> inside <paramref name="enclosingTypeName"/>.
    /// </summary>
    /// <param name="reader">The metadata reader.</param>
    /// <param name="methodName">The kickoff method's name.</param>
    /// <param name="enclosingTypeName">The kickoff method's declaring type.</param>
    /// <returns>The state-machine type's generic-parameter count.</returns>
    private static int StateMachineGenericParameterCount(
        MetadataReader reader,
        string methodName,
        string enclosingTypeName)
    {
        var enclosing = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(t => reader.GetString(t.Name) == enclosingTypeName);

        var stateMachine = enclosing.GetNestedTypes()
            .Select(reader.GetTypeDefinition)
            .Single(t => reader.GetString(t.Name).StartsWith("<" + methodName + ">d__", StringComparison.Ordinal));

        return stateMachine.GetGenericParameters().Count;
    }

    private static string[] CompileVerifyAndRun(string source, out string assemblyPath)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3939_").FullName;
        var srcPath = Path.Combine(tempDir, "Program.gs");
        File.WriteAllText(srcPath, source);
        var outPath = Path.Combine(tempDir, "Program.dll");
        assemblyPath = outPath;

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
        var stdout = proc!.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

        return stdout
            .ReplaceLineEndings(Environment.NewLine)
            .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
    }
}
