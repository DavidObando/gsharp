// <copyright file="Issue3907SymbolicErasureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3907: three places where issue #658's type-argument erasure — a
/// same-compilation type or an open type parameter has no CLR
/// <see cref="Type"/> while binding, so it rides through as
/// <c>System.Object</c> — was allowed to decide a question it cannot answer,
/// and the symbolic type the author wrote was lost.
/// </summary>
/// <remarks>
/// <para>All three surfaced in the migrated
/// <c>src/Sdk/Gsharp.Runtime.Channels</c> after #3915's performance rewrite,
/// and each has a control case in this file that passed BEFORE the fix — the
/// same construct over a concrete/BCL type — so a mutant that erases
/// unconditionally, or one that never erases, is caught by discrimination
/// rather than by a single green assertion (ADR-0154).</para>
/// <para>Every case COMPILES, ILVERIFIES and RUNS the emitted program.
/// Both checks are load-bearing on the #3501 effort: an executing test has
/// passed a broken build that only ILVerify caught, and an ILVerify-clean
/// build has produced a wrong runtime answer.</para>
/// </remarks>
public class Issue3907SymbolicErasureTests
{
    [Fact]
    public void RangeSliceOverAnOpenSpan_KeepsItsElementType()
    {
        // `destination[1..]` reflects the slice member off the receiver's
        // ERASED ClrType, so inside `Holder[T]` a `Span[T]` reports
        // `Span<object>` as Slice's return type. Taking that verbatim made the
        // slice unusable at the `Span[T]` slot it was sliced from — which is
        // exactly `Chan{T}.DrainBufferInto(destination[first..])`.
        //
        // Controls that already passed: `.Slice(1)` (an ordinary method call,
        // never routed through the range path) and the whole shape over a
        // concrete `Span[int32]`.
        const string source = @"
package Demo

import System

class Holder[T] {
    func Copy(source Span[T], destination Span[T]) int32 {
        // Range slice on both sides, feeding a `Span[T]` parameter.
        let tail = destination[1..]
        source[..tail.Length].CopyTo(tail)
        return Consume(tail)
    }

    func ViaSliceMethod(destination Span[T]) int32 {
        // Control: the method form always kept `Span[T]`.
        return Consume(destination.Slice(1))
    }

    func Consume(s Span[T]) int32 -> s.Length
}

class Concrete {
    func Copy(destination Span[int32]) int32 {
        // Control: a concrete element type was never erased.
        let tail = destination[1..]
        tail[0] = 42
        return tail.Length
    }
}

var backing = []string{ ""a"", ""b"", ""c"" }
var target = []string{ """", """", """" }
let h = Holder[string]()
Console.WriteLine(""copied="" + h.Copy(backing.AsSpan(), target.AsSpan()).ToString())
Console.WriteLine(""target1="" + target[1])
Console.WriteLine(""target2="" + target[2])
Console.WriteLine(""viaSlice="" + h.ViaSliceMethod(target.AsSpan()).ToString())

var nums = []int32{ 1, 2, 3 }
Console.WriteLine(""concrete="" + Concrete().Copy(nums.AsSpan()).ToString())
Console.WriteLine(""nums1="" + nums[1].ToString())
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source);

        // The slice really is the tail of the SAME buffer: the copy lands at
        // index 1 and 2, not at 0, and the elements are the source's.
        Assert.Contains("copied=2", lines);
        Assert.Contains("target1=a", lines);
        Assert.Contains("target2=b", lines);
        Assert.Contains("viaSlice=2", lines);
        Assert.Contains("concrete=2", lines);
        Assert.Contains("nums1=42", lines);
        Assert.Equal("done", lines[^1]);
    }

    [Fact]
    public void ExplicitInterfaceImplementationOverATupleTypeArgument_BindsAndDispatches()
    {
        // `class Node[T] : IValueTaskSource[(Value T, Ok bool)]` could not
        // satisfy its own `GetResult` slot: the binder's
        // `MemberLookup.IsSymbolicTypeArgument` had no tuple arm, so the
        // interface was verified against the ERASED
        // `IValueTaskSource<ValueTuple<object, bool>>` and demanded a
        // `GetResult` returning `(object, bool)`. The emitter's counterpart
        // (`ArgIsSymbolicUserDefined`, issue #1902) already recursed into
        // tuples, so the two disagreed.
        //
        // The `NodeB`/`NodeC` shapes are the controls that already passed: a
        // named tuple over CONCRETE elements (whose ClrType builds fine) and a
        // bare `T`. The assertions dispatch through BOTH slots on the same
        // object, so a mutant that collapses the two implementations is caught.
        const string source = @"
package Demo

import System
import System.Threading.Tasks.Sources

class Node[T] : IValueTaskSource[(Value T, Ok bool)], IValueTaskSource[T] {
    private var payload T
    private var ok bool

    init(payload T, ok bool) {
        this.payload = payload
        this.ok = ok
    }

    private func (IValueTaskSource[(Value T, Ok bool)]) GetResult(token int16) (Value T, Ok bool) {
        return (payload, ok)
    }

    private func (IValueTaskSource[(Value T, Ok bool)]) GetStatus(token int16) ValueTaskSourceStatus -> ValueTaskSourceStatus.Succeeded

    private func (IValueTaskSource[(Value T, Ok bool)]) OnCompleted(
        continuation (object?) -> void,
        state object?,
        token int16,
        flags ValueTaskSourceOnCompletedFlags) {
    }

    private func (IValueTaskSource[T]) GetResult(token int16) T -> payload

    private func (IValueTaskSource[T]) GetStatus(token int16) ValueTaskSourceStatus -> ValueTaskSourceStatus.Succeeded

    private func (IValueTaskSource[T]) OnCompleted(
        continuation (object?) -> void,
        state object?,
        token int16,
        flags ValueTaskSourceOnCompletedFlags) {
    }
}

// Control: a named tuple over CONCRETE element types always worked.
class Fixed : IValueTaskSource[(Value string, Ok bool)] {
    private func (IValueTaskSource[(Value string, Ok bool)]) GetResult(token int16) (Value string, Ok bool) -> (""fixed"", true)

    private func (IValueTaskSource[(Value string, Ok bool)]) GetStatus(token int16) ValueTaskSourceStatus -> ValueTaskSourceStatus.Succeeded

    private func (IValueTaskSource[(Value string, Ok bool)]) OnCompleted(
        continuation (object?) -> void,
        state object?,
        token int16,
        flags ValueTaskSourceOnCompletedFlags) {
    }
}

func ReadPair[T](n Node[T]) (Value T, Ok bool) {
    let src IValueTaskSource[(Value T, Ok bool)] = n
    return src.GetResult(0)
}

func ReadOne[T](n Node[T]) T {
    let src IValueTaskSource[T] = n
    return src.GetResult(0)
}

let s = Node[string](""hi"", true)
let pair = ReadPair[string](s)
Console.WriteLine(""pair="" + pair.Value + "":"" + pair.Ok.ToString())
Console.WriteLine(""one="" + ReadOne[string](s))

let i = Node[int32](7, false)
let ipair = ReadPair[int32](i)
Console.WriteLine(""ipair="" + ipair.Value.ToString() + "":"" + ipair.Ok.ToString())

let f IValueTaskSource[(Value string, Ok bool)] = Fixed()
Console.WriteLine(""fixed="" + f.GetResult(0).Value)
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source);

        // Both slots exist on the same object and dispatch separately: the
        // tuple slot yields the pair, the bare-T slot yields the value alone.
        Assert.Contains("pair=hi:True", lines);
        Assert.Contains("one=hi", lines);

        // A value-type instantiation exercises the `ValueTuple<int32, bool>`
        // shape the erased form would have got wrong in the other direction.
        Assert.Contains("ipair=7:False", lines);
        Assert.Contains("fixed=fixed", lines);
        Assert.Equal("done", lines[^1]);
    }

    [Fact]
    public void ByRefArgumentOverAUserClass_PicksTheGenericOverload()
    {
        // `Interlocked` declares BOTH `Exchange<T>(ref T, T) where T : class`
        // and the non-generic `Exchange(ref object?, object?)`. The #658
        // erasure made `&nodeField` look like `ref object`, which is an exact
        // IDENTITY match for the non-generic overload, so it won and the
        // call's type became `object` (GS0156 at the use site). csc never
        // considers that overload at all: a `ref` argument requires exact type
        // identity.
        //
        // The `StringPool` control — the identical shape over a BCL element
        // type, where no erasure happens — passed before the fix. The
        // assertions RUN the pool, so the test would also catch an
        // `Exchange` that type-checks but does not actually swap.
        const string source = @"
package Demo

import System
import System.Threading

class Node {
    var Tag string

    init(tag string) {
        Tag = tag
    }
}

class Pool {
    private var slot Node?

    func Rent(tag string) Node -> Interlocked.Exchange(&slot, nil) ?? Node(tag)

    func Return(n Node) {
        Volatile.Write(&slot, n)
    }

    func Peek() Node? -> Volatile.Read(&slot)

    func Swap(n Node?) Node? -> Interlocked.Exchange(&slot, n)
}

// Control: the same shape over a BCL element type never erased.
class StringPool {
    private var slot string?

    func Rent() string -> Interlocked.Exchange(&slot, nil) ?? ""fresh""
}

let p = Pool()
Console.WriteLine(""rent1="" + p.Rent(""a"").Tag)
Console.WriteLine(""empty="" + (if p.Peek() == nil { ""nil"" } else { ""set"" }))
p.Return(Node(""pooled""))
Console.WriteLine(""peek="" + p.Peek()!!.Tag)
Console.WriteLine(""rent2="" + p.Rent(""b"").Tag)
Console.WriteLine(""drained="" + (if p.Peek() == nil { ""nil"" } else { ""set"" }))
let previous = p.Swap(Node(""next""))
Console.WriteLine(""swapped="" + (if previous == nil { ""nil"" } else { previous!!.Tag }))
Console.WriteLine(""after="" + p.Peek()!!.Tag)
Console.WriteLine(""control="" + StringPool().Rent())
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source);

        // The pool actually pools: an empty slot manufactures a node, a
        // returned node is handed back, and the rent CLEARS the slot — that
        // last one is the observable proof that the selected `Exchange` really
        // performed the exchange rather than merely type-checking.
        Assert.Contains("rent1=a", lines);
        Assert.Contains("empty=nil", lines);
        Assert.Contains("peek=pooled", lines);
        Assert.Contains("rent2=pooled", lines);
        Assert.Contains("drained=nil", lines);
        Assert.Contains("swapped=nil", lines);
        Assert.Contains("after=next", lines);
        Assert.Contains("control=fresh", lines);
        Assert.Equal("done", lines[^1]);
    }

    private static string[] CompileVerifyAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3907_erasure_").FullName;
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
