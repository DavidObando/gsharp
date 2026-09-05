// <copyright file="Issue3932GenericEmitSitesTests.cs" company="GSharp">
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

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3932: four places where gsc emitted IL for a GENERIC context using a
/// shape that is only correct for a non-generic one. Each one compiled without
/// a diagnostic and each one produced IL the verifier rejects, so they were
/// invisible until <c>src/Sdk/Gsharp.Runtime.Channels</c> compiled cleanly for
/// the first time (#3907) and its ilverify stage became reachable.
/// </summary>
/// <remarks>
/// <para>What makes all four the same story: in every case gsc's OWN
/// neighbouring path already got it right, and only one sibling was missed.
/// A <c>newobj</c> on a generic user type parents its ctor MemberRef at the
/// self TypeSpec, but the chained <c>init(...)</c> did not. An imported generic
/// METHOD slot takes a raw <c>T</c>, but the imported generic CTOR slot boxed
/// it. An INSTANCE async method reifies its state machine over the enclosing
/// type's parameters, but a <c>shared</c> one did not. A CONCRETE element type
/// emits <c>Memory`1::op_Implicit</c> at an extension-call argument, but an
/// open one emitted nothing.</para>
/// <para>Every case COMPILES, ILVERIFIES and RUNS, and asserts on observed
/// behaviour — all three are load-bearing on the #3501 effort, where an
/// executing test has passed a build only ILVerify caught and an ILVerify-clean
/// build has produced a wrong runtime answer. Two cases additionally read the
/// emitted metadata back, because "the token is a MethodDef, not a
/// TypeSpec-parented MemberRef" and "the state machine has arity 0" are
/// encoding facts a behavioural assertion cannot name.</para>
/// <para>Discrimination (ADR-0154): every test carries a control that passed
/// BEFORE the fix — the same construct in the non-generic / instance /
/// concrete-element form — so a mutant that applies the new path
/// unconditionally is caught as surely as one that never applies it.</para>
/// </remarks>
public class Issue3932GenericEmitSitesTests
{
    /// <summary>
    /// Root 1 (9 of the 19 ilverify findings): a <c>convenience init</c>
    /// delegating to a sibling inside a GENERIC aggregate emitted
    /// <c>call Box`1::.ctor</c> against the raw MethodDef, which names the OPEN
    /// definition. The verifier then sees a <c>Box`1&lt;!0&gt;</c> receiver
    /// handed to a ctor on <c>Box`1</c>: <c>this</c> is never marked
    /// initialized (<c>CallCtor</c> + <c>ThisUninitReturn</c>) and the argument
    /// slots stay uninstantiated (<c>StackUnexpected</c>).
    /// </summary>
    [Fact]
    public void ChainedInitInsideAGenericType_TargetsTheSelfTypeSpec()
    {
        const string source = @"
package main

import System

class Box[T] {
    var items []T
    var tag string

    // Two hops of chaining, so a fix that only handles the last one is caught.
    convenience init() {
        init(4, ""default"")
    }

    convenience init(capacity int32) {
        init(capacity, ""sized"")
    }

    init(capacity int32, tag string) {
        items = [capacity]T
        this.tag = tag
    }

    func Describe() string -> tag + "":"" + items.Length.ToString()
}

// Control: the identical chaining shape on a NON-generic type has always been
// correct, because a bare MethodDef IS the right token there.
class Plain {
    var tag string

    convenience init() {
        init(""plain"")
    }

    init(tag string) {
        this.tag = tag
    }

    func Describe() string -> tag
}

Console.WriteLine(""zeroArg="" + Box[int32]().Describe())
Console.WriteLine(""oneArg="" + Box[string](7).Describe())
Console.WriteLine(""twoArg="" + Box[int32](2, ""explicit"").Describe())
Console.WriteLine(""plain="" + Plain().Describe())
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source, out var assemblyPath);

        // Behaviour: both convenience hops really ran the designated
        // initializer, so the tag and the buffer length are the chained ones
        // rather than a default-constructed instance's.
        Assert.Contains("zeroArg=default:4", lines);
        Assert.Contains("oneArg=sized:7", lines);
        Assert.Contains("twoArg=explicit:2", lines);
        Assert.Contains("plain=plain", lines);
        Assert.Equal("done", lines[^1]);

        // Encoding: the chained call must go through a MemberRef (which carries
        // the TypeSpec parent) on the GENERIC type, and must stay a plain
        // MethodDef on the non-generic one. Reading the token kind out of the
        // emitted body is the only way to state that; ILVerify agrees but says
        // it as a stack-shape complaint three instructions later.
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var reader = pe.GetMetadataReader();

        Assert.Equal(
            HandleKind.MemberReference,
            SingleChainedCtorCallTokenKind(reader, pe, "Box`1"));
        Assert.Equal(
            HandleKind.MethodDefinition,
            SingleChainedCtorCallTokenKind(reader, pe, "Plain"));
    }

    /// <summary>
    /// Root 2 (7 of the 19): an argument at an IMPORTED generic constructor's
    /// own type-parameter slot (<c>ValueTask&lt;T&gt;(!0)</c>) was converted to
    /// the type-erased <c>object</c>, so gsc emitted <c>box !!T</c> in front of
    /// a <c>newobj</c> whose parent TypeSpec is the correctly symbolic
    /// <c>ValueTask`1&lt;!!T&gt;</c>.
    /// </summary>
    /// <remarks>
    /// A ctor has no receiver, so neither #765's
    /// <c>TrySubstituteParameterTypeFromReceiver</c> nor #1540's
    /// <c>TryRecoverReceiverTypeParameterSlot</c> — the two helpers that keep
    /// <c>List[T].Add(v)</c> off the boxing path — could fire.
    /// <c>ViaMethod</c> below is exactly that already-correct sibling, and it
    /// is what makes this a ctor-only hole rather than a general erasure gap.
    /// </remarks>
    [Fact]
    public void ImportedGenericCtorSlot_TakesTheRawTypeParameterNotABox()
    {
        const string source = @"
package main

import System
import System.Collections.Generic
import System.Threading.Tasks

class Ops {
    shared {
        // Control: the imported generic METHOD slot has always been correct.
        func ViaMethod[T](v T) List[T] {
            var l = List[T]()
            l.Add(v)
            return l
        }

        // The failing shape: the imported generic CTOR slot.
        func ViaCtor[T](v T) ValueTask[T] {
            return ValueTask[T](v)
        }

        // The same defect one level in: the boxed operand also dragged the
        // TUPLE's own element type to `object`, emitting
        // `ValueTuple`2<object,bool>` where `ValueTuple`2<!!T,bool>` belongs.
        func ViaCtorTuple[T](v T, ok bool) ValueTask[(Value T, Ok bool)] {
            return ValueTask[(Value T, Ok bool)]((v, ok))
        }
    }
}

// A VALUE type is the discriminating instantiation: a stray box on a
// reference `T` is merely redundant, but on `int32` it changes the value's
// representation at the slot.
Console.WriteLine(""method-int="" + Ops.ViaMethod[int32](7)[0].ToString())
Console.WriteLine(""ctor-int="" + Ops.ViaCtor[int32](7).Result.ToString())
Console.WriteLine(""ctor-string="" + Ops.ViaCtor[string](""hi"").Result)

let t = Ops.ViaCtorTuple[int32](9, true)
let (value, ok) = t.Result
Console.WriteLine(""tuple-int="" + value.ToString() + "":"" + ok.ToString())

let s = Ops.ViaCtorTuple[string](""nine"", false)
let (svalue, sok) = s.Result
Console.WriteLine(""tuple-string="" + svalue + "":"" + sok.ToString())
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source, out _);

        Assert.Contains("method-int=7", lines);
        Assert.Contains("ctor-int=7", lines);
        Assert.Contains("ctor-string=hi", lines);
        Assert.Contains("tuple-int=9:True", lines);
        Assert.Contains("tuple-string=nine:False", lines);
        Assert.Equal("done", lines[^1]);
    }

    /// <summary>
    /// Root 3: a <c>shared</c> (static) async method on a generic type has no
    /// <c>ReceiverType</c>, so the state-machine reifier saw no class type
    /// parameters and emitted the struct at arity ZERO — leaving every hoisted
    /// field carrying a dangling <c>!0</c>.
    /// </summary>
    /// <remarks>
    /// The instance form has always been right, and so has the iterator
    /// sibling, whose scope collection consults <c>StaticOwnerType</c> as well.
    /// </remarks>
    [Fact]
    public void SharedAsyncOnAGenericType_ReifiesItsStateMachineOverTheTypeParameters()
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
        // The failing shape: `shared async` on a generic type.
        async func FetchShared(v T) ValueTask[T] {
            await Task.Yield()
            return v
        }
    }

    // Control: the instance form always reified at the right arity.
    async func FetchInstance() ValueTask[T] {
        await Task.Yield()
        return seed
    }
}

// Control: `shared async` on a NON-generic type needs no reification at all.
class Flat {
    shared {
        async func FetchShared(v int32) ValueTask[int32] {
            await Task.Yield()
            return v
        }
    }
}

Console.WriteLine(""shared-int="" + Holder[int32].FetchShared(41).AsTask().GetAwaiter().GetResult().ToString())
Console.WriteLine(""shared-string="" + Holder[string].FetchShared(""hi"").AsTask().GetAwaiter().GetResult())
Console.WriteLine(""instance-int="" + Holder[int32](7).FetchInstance().AsTask().GetAwaiter().GetResult().ToString())
Console.WriteLine(""flat="" + Flat.FetchShared(3).AsTask().GetAwaiter().GetResult().ToString())
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source, out var assemblyPath);

        Assert.Contains("shared-int=41", lines);
        Assert.Contains("shared-string=hi", lines);
        Assert.Contains("instance-int=7", lines);
        Assert.Contains("flat=3", lines);
        Assert.Equal("done", lines[^1]);

        // Encoding: the arity of the emitted state machine IS the bug. Read it
        // straight out of the metadata so a regression is named precisely
        // rather than inferred from a stack-shape complaint.
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var reader = pe.GetMetadataReader();

        Assert.Equal(1, StateMachineGenericParameterCount(reader, "FetchShared", "Holder`1"));
        Assert.Equal(1, StateMachineGenericParameterCount(reader, "FetchInstance", "Holder`1"));

        // Control, in metadata: the non-generic encloser's state machine must
        // stay at arity 0. A mutant that reifies unconditionally fails here.
        Assert.Equal(0, StateMachineGenericParameterCount(reader, "FetchShared", "Flat"));
    }

    /// <summary>
    /// Root 4: at an extension-call argument whose parameter type still
    /// CONTAINS a type parameter, gsc skipped conversion entirely. That skip is
    /// right for a BARE open <c>T</c> slot (erased to <c>object</c>, boxed by
    /// the emitter) but wrong for <c>Memory[T]</c>, which emits as a real
    /// constructed slot — so a <c>[]T</c> argument reached it with no
    /// <c>Memory`1::op_Implicit</c> at all.
    /// </summary>
    [Fact]
    public void OpenElementArrayAtAMemorySlot_EmitsTheImplicitConversion()
    {
        const string source = @"
package main

import System
import System.Collections.Generic

// An extension function, which is the shape the channels runtime uses
// (`reader.ReceiveBatch(buffer, …)`).
func (list List[T]) TakeMemory[T](m Memory[T]) int32 -> m.Length * 10 + list.Count

// The bare-`T` slot the skip actually exists for: it must keep passing the
// argument through unconverted, so a mutant that converts everything is caught.
func (list List[T]) TakeBare[T](v T) string -> v.ToString() + "":"" + list.Count.ToString()

class Ops {
    shared {
        // The failing shape: an OPEN element array at a Memory[T] slot.
        func ViaOpen[T](l List[T], buffer []T) int32 -> l.TakeMemory(buffer)

        // Control: the identical call with a CONCRETE element has always
        // emitted the operator.
        func ViaConcrete(l List[int32], buffer []int32) int32 -> l.TakeMemory(buffer)

        func ViaBare[T](l List[T], v T) string -> l.TakeBare(v)
    }
}

Console.WriteLine(""open-string="" + Ops.ViaOpen[string](List[string]{ ""z"" }, []string{ ""a"", ""b"", ""c"" }).ToString())
Console.WriteLine(""open-int="" + Ops.ViaOpen[int32](List[int32]{ 9, 9 }, []int32{ 1, 2 }).ToString())
Console.WriteLine(""concrete="" + Ops.ViaConcrete(List[int32]{ 9 }, []int32{ 1, 2 }).ToString())
Console.WriteLine(""bare-int="" + Ops.ViaBare[int32](List[int32]{ 5 }, 4))
Console.WriteLine(""bare-string="" + Ops.ViaBare[string](List[string]{ ""q"" }, ""w""))
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source, out _);

        // The arithmetic pins that the CONVERTED value carried the right
        // length: a `Memory` built from a 3-element array reports 3, so
        // 3*10 + 1 = 31. A dropped conversion cannot produce this at all
        // (the assembly does not verify), and a conversion applied to the
        // wrong operand would not produce these exact numbers.
        Assert.Contains("open-string=31", lines);
        Assert.Contains("open-int=22", lines);
        Assert.Contains("concrete=21", lines);
        Assert.Contains("bare-int=4:1", lines);
        Assert.Contains("bare-string=w:1", lines);
        Assert.Equal("done", lines[^1]);
    }

    /// <summary>
    /// Returns the token kind of the single chained-constructor <c>call</c>
    /// inside <paramref name="typeName"/>'s parameterless convenience ctor.
    /// </summary>
    /// <param name="reader">The metadata reader.</param>
    /// <param name="pe">The PE reader.</param>
    /// <param name="typeName">The emitted type's metadata name.</param>
    /// <returns>The handle kind of the called constructor's token.</returns>
    private static HandleKind SingleChainedCtorCallTokenKind(MetadataReader reader, PEReader pe, string typeName)
    {
        var type = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(t => reader.GetString(t.Name) == typeName);

        // The parameterless ctor is the convenience one that chains.
        var ctor = type.GetMethods()
            .Select(reader.GetMethodDefinition)
            .Single(m => reader.GetString(m.Name) == ".ctor"
                && m.DecodeSignature(new SignatureArity(), genericContext: null).ParameterTypes.Length == 0);

        var body = pe.GetMethodBody(ctor.RelativeVirtualAddress);
        var il = body.GetILContent();

        // `ldarg.0` (0x02) then the argument loads, then `call` (0x28) with a
        // 4-byte token, then `ret`. Scan for the single `call`.
        for (var i = 0; i < il.Length - 4; i++)
        {
            if (il[i] != 0x28)
            {
                continue;
            }

            var token = il[i + 1] | (il[i + 2] << 8) | (il[i + 3] << 16) | (il[i + 4] << 24);
            return MetadataTokens.EntityHandle(token).Kind;
        }

        throw new InvalidOperationException($"No 'call' instruction found in {typeName}'s parameterless constructor.");
    }

    /// <summary>
    /// Returns the generic-parameter count of the async state machine
    /// synthesized for <paramref name="methodName"/> inside
    /// <paramref name="enclosingTypeName"/>.
    /// </summary>
    /// <param name="reader">The metadata reader.</param>
    /// <param name="methodName">The kickoff method's name.</param>
    /// <param name="enclosingTypeName">The kickoff method's declaring type.</param>
    /// <returns>The state-machine type's generic-parameter count.</returns>
    private static int StateMachineGenericParameterCount(MetadataReader reader, string methodName, string enclosingTypeName)
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
        var tempDir = Directory.CreateTempSubdirectory("gs_3932_").FullName;
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

    /// <summary>
    /// Minimal signature provider used only to count a constructor's
    /// parameters, so the chaining assertion can pick the parameterless
    /// overload without depending on a reflection context.
    /// </summary>
    private sealed class SignatureArity : ISignatureTypeProvider<string, object>
    {
        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();

        public string GetGenericTypeParameter(object genericContext, int index) => "!" + index;

        public string GetGenericMethodParameter(object genericContext, int index) => "!!" + index;

        public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind)
            => reader.GetString(reader.GetTypeDefinition(handle).Name);

        public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
            => reader.GetString(reader.GetTypeReference(handle).Name);

        public string GetTypeFromSpecification(MetadataReader reader, object genericContext, TypeSpecificationHandle handle, byte rawTypeKind)
            => reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);

        public string GetGenericInstantiation(string genericType, System.Collections.Immutable.ImmutableArray<string> typeArguments)
            => genericType + "<" + string.Join(",", typeArguments) + ">";

        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[]";

        public string GetByReferenceType(string elementType) => elementType + "&";

        public string GetPointerType(string elementType) => elementType + "*";

        public string GetSZArrayType(string elementType) => elementType + "[]";

        public string GetFunctionPointerType(MethodSignature<string> signature) => "method*";

        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType;

        public string GetPinnedType(string elementType) => elementType;

        public string GetTypeFromSerializedName(string name) => name;

        public PrimitiveTypeCode GetUnderlyingEnumType(string type) => PrimitiveTypeCode.Int32;

        public bool IsSystemType(string type) => false;
    }
}
