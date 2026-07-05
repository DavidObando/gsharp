// <copyright file="Issue2117DefaultNullableTypeParamEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Regression tests for issue #2117: <c>default(T?)</c> where <c>T</c> is an
/// UNCONSTRAINED generic type parameter must emit IDENTICALLY to
/// <c>default(T)</c> in a value position. For an unconstrained <c>T</c> the
/// <c>?</c> annotation is a static-only nullability marker — at the CLR level
/// <c>T? == T</c> (there is no <c>Nullable&lt;T&gt;</c> box because <c>T</c> may
/// close to a reference type), so a <c>default(T?)</c> flowing into a reified
/// generic slot (e.g. the argument of <c>Task.FromResult[T?](...)</c>) must load
/// the zero VALUE (<c>ldloca; initobj; ldloc</c>), never a boxed reference.
/// <para>
/// The binder previously recovered the erased-<c>object</c> generic parameter
/// slot only for a bare <c>TypeParameterSymbol</c> argument, so
/// <c>default(T)</c> passed as identity (no box) while <c>default(T?)</c> fell
/// through to the <c>T? -&gt; object</c> boxing rule and emitted a spurious
/// <c>box !T</c> ahead of a call whose symbolically re-closed signature
/// (<c>FromResult&lt;!T&gt;(!!0)</c>) expects the raw value — producing the
/// ilverify <c>StackUnexpected [found ref 'T'][expected value 'T']</c> reported
/// in #2117 and an <c>InvalidProgramException</c> at JIT time. The recovery now
/// also fires for <c>T?</c> over an unconstrained type parameter, making the
/// argument <c>T? -&gt; T?</c> identity (no box), byte-identical to the working
/// <c>default(T)</c> control.
/// </para>
/// </summary>
public class Issue2117DefaultNullableTypeParamEmitTests
{
    /// <summary>
    /// End-to-end proof: a generic function returning
    /// <c>Task.FromResult[T?](default(T?))</c> JITs and runs correctly for BOTH
    /// a reference-type instantiation (<c>string</c> — default is <c>nil</c>) and
    /// a value-type instantiation (<c>int32</c> — default is <c>0</c>). Before
    /// the fix the spurious <c>box</c> made both instantiations throw
    /// <c>InvalidProgramException</c> at JIT time.
    /// </summary>
    [Fact]
    public void DefaultNullableTypeParameter_Unconstrained_RefAndValue_JitsAndRuns()
    {
        const string Source = @"package Issue2117Run
import System
import System.Threading.Tasks

func Make[T]() Task[T?] -> Task.FromResult[T?](default(T?))

var a = Make[string]()
Console.WriteLine(a.Result == nil)
var c = Make[int32]()
Console.WriteLine(c.Result)
";
        var stdout = CompileLoadInvokeCaptureStdout(Source, nameof(DefaultNullableTypeParameter_Unconstrained_RefAndValue_JitsAndRuns));
        var lines = stdout.Replace("\r\n", "\n").Trim().Split('\n');
        Assert.Equal("True", lines[0].Trim());
        Assert.Equal("0", lines[1].Trim());
    }

    /// <summary>
    /// The emitted body of the generic <c>Make</c> must load the default VALUE
    /// (<c>ldloca; initobj; ldloc</c>) and contain NO <c>box</c> opcode — the
    /// argument flows into the reified <c>FromResult&lt;!T&gt;(!!0)</c> slot as a
    /// value, exactly like the <c>default(T)</c> control.
    /// </summary>
    [Fact]
    public void DefaultNullableTypeParameter_Unconstrained_EmitsValueLoadNotBox()
    {
        const string Source = @"package Issue2117Il
import System.Threading.Tasks

func Make[T]() Task[T?] -> Task.FromResult[T?](default(T?))
";
        var il = EmitAndGetMethodIl(Source, "Make");

        // 0xFE 0x15 == initobj; the default value must be materialised in a slot.
        Assert.True(ContainsSequence(il, new byte[] { 0xFE, 0x15 }), "Make must zero-init the default into a slot (initobj)");

        // 0x8C == box. An unconstrained `default(T?)` argument to a reified
        // generic slot must NOT be boxed (that is the #2117 bug).
        Assert.DoesNotContain((byte)0x8C, il);
    }

    /// <summary>
    /// Control (other direction): a <c>default(T?)</c> flowing into a GENUINE
    /// <c>object</c> parameter (<c>Console.WriteLine(object)</c>) MUST still box.
    /// The #2117 fix only suppresses the box for reified generic slots, so this
    /// legitimate boxing path is unaffected.
    /// </summary>
    [Fact]
    public void DefaultNullableTypeParameter_IntoGenuineObjectSlot_StillBoxes()
    {
        const string Source = @"package Issue2117ObjSlot
import System

open class OB[T] {
    func W() -> Console.WriteLine(default(T?))
}
";
        var il = EmitAndGetMethodIl(Source, "W");
        Assert.Contains((byte)0x8C, il); // box !T is required for the object slot
    }

    /// <summary>
    /// Control (no regression): a value-type-constrained <c>[T struct]</c> —
    /// where <c>T?</c> genuinely IS <c>Nullable&lt;T&gt;</c> — must still emit a
    /// proper value-type nullable default and compile/emit cleanly. It is
    /// likewise reified over the real <c>Nullable&lt;!T&gt;</c> slot, so no box is
    /// introduced.
    /// </summary>
    [Fact]
    public void DefaultNullableTypeParameter_StructConstrained_EmitsNullableDefault()
    {
        const string Source = @"package Issue2117Struct
import System.Threading.Tasks

open class SB[T struct] {
    func MakeS() Task[T?] -> Task.FromResult[T?](default(T?))
}
";
        var il = EmitAndGetMethodIl(Source, "MakeS");
        Assert.True(ContainsSequence(il, new byte[] { 0xFE, 0x15 }), "struct-constrained default must initobj Nullable<T> into a slot");
        Assert.DoesNotContain((byte)0x8C, il); // no box: reified over Nullable<!T>
    }

    private static bool ContainsSequence(byte[] haystack, byte[] needle)
    {
        for (var i = 0; i + needle.Length <= haystack.Length; i++)
        {
            var match = true;
            for (var j = 0; j < needle.Length; j++)
            {
                if (haystack[i + j] != needle[j])
                {
                    match = false;
                    break;
                }
            }

            if (match)
            {
                return true;
            }
        }

        return false;
    }

    private static byte[] EmitAndGetMethodIl(string source, string methodName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var pe = new PEReader(peStream);
        var md = pe.GetMetadataReader();
        foreach (var th in md.TypeDefinitions)
        {
            var type = md.GetTypeDefinition(th);
            foreach (var mh in type.GetMethods())
            {
                var method = md.GetMethodDefinition(mh);
                if (md.GetString(method.Name) != methodName || method.RelativeVirtualAddress == 0)
                {
                    continue;
                }

                var body = pe.GetMethodBody(method.RelativeVirtualAddress);
                return body.GetILBytes() ?? Array.Empty<byte>();
            }
        }

        Assert.Fail($"method '{methodName}' not found in emitted assembly");
        return Array.Empty<byte>();
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var originalOut = Console.Out;
            using var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(originalOut);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
