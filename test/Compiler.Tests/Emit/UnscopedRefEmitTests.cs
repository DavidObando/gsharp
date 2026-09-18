// <copyright file="UnscopedRefEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0184 / issue #376: emit-level proof for definition-side
/// <c>@UnscopedRef</c>. Two things have to be true in the produced PE, and
/// neither is observable from the binder's diagnostics alone:
/// <list type="number">
/// <item><description><c>UnscopedRefAttribute</c> really reaches CLR metadata,
/// on the method row for the <c>func</c> spelling and on the property row for
/// the <c>prop</c>/indexer spelling — so a C# (or later G#) consumer reading
/// the assembly sees the same contract gsc enforced. The bound attribute is a
/// real type-identity-resolved attribute, not a compiler-intrinsic marker, so
/// this is what the <c>import System.Diagnostics.CodeAnalysis</c> buys.</description></item>
/// <item><description>The body emits <c>ldarg.0</c> (not <c>ldarga.s</c>)
/// followed by <c>ldflda</c>. A struct instance method's arg0 is already the
/// managed pointer <c>ref S</c>; <c>ldarga.0</c> would yield a pointer to that
/// pointer and the returned reference would be garbage. This is exactly what
/// csc emits for <c>[UnscopedRef] public ref int F() =&gt; ref field;</c>.</description></item>
/// </list>
/// </summary>
public class UnscopedRefEmitTests
{
    private const string UnscopedRefAttributeFullName = "System.Diagnostics.CodeAnalysis.UnscopedRefAttribute";

    /// <summary>Opcode <c>ldarg.0</c>, the correct receiver load in a struct instance method.</summary>
    private const byte Ldarg0 = 0x02;

    /// <summary>Opcode <c>ldarga.s</c>, which would be wrong here (pointer-to-pointer).</summary>
    private const byte LdargaS = 0x0F;

    /// <summary>Opcode <c>ldflda</c>.</summary>
    private const byte Ldflda = 0x7C;

    private const string Source = """
        package P
        import System.Diagnostics.CodeAnalysis

        struct Acc {
            var Total int32

            @UnscopedRef
            func Slot() ref int32 {
                return ref this.Total
            }

            @UnscopedRef
            prop Ref ref int32 {
                get { return ref this.Total }
            }

            @UnscopedRef
            prop this[i int32] ref int32 {
                get { return ref this.Total }
            }
        }
        """;

    [Fact]
    public void MethodSpelling_EmitsUnscopedRefAttribute_OnTheMethodRow()
    {
        var acc = LoadAcc();
        var slot = acc.GetMethod("Slot", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(slot);
        Assert.Contains(slot!.GetCustomAttributesData(), d => d.AttributeType.FullName == UnscopedRefAttributeFullName);
    }

    [Theory]
    [InlineData("Ref")]
    [InlineData("Item")]
    public void PropertySpelling_EmitsUnscopedRefAttribute_OnThePropertyRow(string propertyName)
    {
        var acc = LoadAcc();
        var property = acc.GetProperty(propertyName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(property);

        // ADR-0184 §7 pins the PROPERTY row specifically for the `prop`/indexer
        // spelling, so assert that row and nothing else. An earlier version
        // accepted `property OR getter`, which would also have passed had the
        // emitter regressed to writing the attribute only on `get_Item` — the
        // getter-row placement is a CLR-INPUT shape gsc must READ (covered by
        // Issue4265SpanByValueRefReturnTests over a C# fixture), not an output
        // shape gsc may choose.
        Assert.True(
            Carries(property!.GetCustomAttributesData()),
            $"'{propertyName}' does not carry {UnscopedRefAttributeFullName} on its property row; "
                + $"getter row carries it: {Carries(property.GetGetMethod(nonPublic: true)!.GetCustomAttributesData())}");
    }

    /// <summary>
    /// The IL half: the receiver is loaded with <c>ldarg.0</c> and the field
    /// address taken with <c>ldflda</c>. A regression to <c>ldarga.s</c> here
    /// would compile, verify and return a reference to a stack slot holding a
    /// pointer — silently wrong at run time, which is why this asserts opcodes
    /// rather than just "it compiled".
    /// </summary>
    [Fact]
    public void RefReturnOfOwnField_Emits_Ldarg0_Then_Ldflda()
    {
        var acc = LoadAcc();
        var slot = acc.GetMethod("Slot", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(slot);
        var il = slot!.GetMethodBody()?.GetILAsByteArray();
        Assert.NotNull(il);
        Assert.NotEmpty(il!);
        Assert.Equal(Ldarg0, il![0]);
        Assert.DoesNotContain(LdargaS, il);
        Assert.Contains(Ldflda, il);
    }

    /// <summary>Opcode <c>ldobj</c>, the value-copy half of a defensive receiver spill.</summary>
    private const byte Ldobj = 0x71;

    /// <summary>Opcodes <c>stloc.0</c>–<c>stloc.3</c>, <c>stloc.s</c> and <c>stloc</c>'s prefix.</summary>
    private static readonly byte[] StoreLocalOpcodes = { 0x0A, 0x0B, 0x0C, 0x0D, 0x13, 0xFE };

    /// <summary>
    /// ADR-0184 amendment, the emit-level half of the caller-side fix. The
    /// binder now rejects a <c>ref</c> forwarded through a READ-ONLY receiver,
    /// because the emitter defensively copies such a receiver into a
    /// function-local temp. This asserts the complementary fact at the metadata
    /// level rather than inferring it from a runtime value: the SAFE path — a
    /// genuine <c>ref</c> parameter receiver — emits a direct
    /// <c>ldarg</c>-style pass-through with NO spill sequence
    /// (<c>ldobj</c>/<c>stloc</c>/<c>ldloca</c>) between the receiver load and
    /// the <c>call</c>. If hook B ever started treating the <c>ref</c>-parameter
    /// path as copied too, or the emitter started copying it, this body would
    /// grow exactly that sequence.
    /// </summary>
    [Fact]
    public void RefParameterReceiver_ForwardsWithoutADefensiveReceiverCopy()
    {
        var assembly = CompileToAssembly(Source + """


            func Forward(ref a Acc) ref int32 {
                return ref a.Slot()
            }
            """,
            // `Forward` is a byref-returning forwarder, so it hits the same
            // ilverify ReturnPtrToStack limitation ADR-0181 already records for
            // `Acc.Slot` — csc's IL for the identical C# fails it too.
            ignoredErrorScope: @"(Acc\.(Slot|get_Ref|get_Item)|Forward)$");
        var forward = assembly.GetTypes()
            .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
            .Single(method => method.Name == "Forward");
        var il = forward.GetMethodBody()?.GetILAsByteArray();
        Assert.NotNull(il);
        Assert.NotEmpty(il!);

        // arg0 is already `ref Acc`; forwarding it is a straight load.
        Assert.Equal(Ldarg0, il![0]);
        Assert.DoesNotContain(LdargaS, il);

        // No value copy and no spill slot — the whole point of the assertion.
        Assert.DoesNotContain(Ldobj, il);
        Assert.DoesNotContain(il, opcode => StoreLocalOpcodes.Contains(opcode));
    }

    private static bool Carries(IList<CustomAttributeData> attributes)
        => attributes.Any(attribute => attribute.AttributeType.FullName == UnscopedRefAttributeFullName);

    private static Type LoadAcc()
    {
        var assembly = CompileToAssembly(Source);
        return assembly.GetTypes().Single(t => t.Name == "Acc");
    }

    private static Assembly CompileToAssembly(string source, string ignoredErrorScope = @"Acc\.(Slot|get_Ref|get_Item)$")
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_unscopedref_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        // ADR-0181 already records this as a verifier limitation, not an
        // emitter bug: ilverify 10.0.8 reports `ReturnPtrToStack` for the
        // minimal incoming byref forwarder (`ldarg; ret`) emitted by BOTH
        // Roslyn and G#. It rejects any byref return signature outright — it
        // has no notion of `[UnscopedRef]` or of a permanent home — so csc's
        // IL for the same `[UnscopedRef] public ref int Slot() => ref
        // this.Total;` fails identically. Scoped to the three ref-returning
        // members: IlVerifier.Verify runs the rest of the assembly in a second
        // pass with no suppression at all.
        IlVerifier.Verify(
            outPath,
            ignoredErrorCodes: IlVerifier.KnownIssues.RefStruct,
            ignoredErrorScope: ignoredErrorScope);

        return EmittedFixture.Load(outPath);
    }
}
