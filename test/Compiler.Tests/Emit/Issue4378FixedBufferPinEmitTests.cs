// <copyright file="Issue4378FixedBufferPinEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4378 / ADR-0125 amendment: a <c>fixed</c> statement accepts a
/// fixed-size buffer field (ADR-0122 §10, <c>fixed Name [32]int8</c>) reached
/// through a movable variable as its pinning source, mirroring C#
/// <c>fixed (sbyte* p = Name) { … }</c>. The pointer binds to the buffer's
/// first element and the containing storage stays pinned for the whole block
/// through a <c>int8&amp; pinned</c> local loaded from
/// <c>ldflda Name; ldflda FixedElementField</c> — the IL csc emits. Each
/// runtime test compiles with <c>gsc</c>, ilverifies (tolerating the inherent
/// unmanaged-pointer codes), and executes under <c>dotnet exec</c>.
/// Also covers issue #4377: a bare (implicit-<c>this</c>) buffer name inside
/// the declaring struct decays exactly like the explicit <c>this.Name</c>.
/// </summary>
public class Issue4378FixedBufferPinEmitTests
{
    private static readonly string[] FixedIlVerifyIgnored =
    {
        "Unverifiable",
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
        "ExpectedNumericType",
    };

    // The Raylib-cs `BoneInfo` shape: a 32-byte name buffer next to a parent index.
    private const string BoneInfoPrelude = """
        package Probe
        import System

        unsafe struct BoneInfo {
            fixed Name [32]int8
            var Parent int32

            func First() int8 {
                fixed p *int8 = Name {
                    return p[0]
                }
            }

            func SetAt(i int32, v int8) {
                Name[i] = v
            }

            func GetAt(i int32) int8 {
                return Name[i]
            }
        }

        unsafe class Holder {
            var B BoneInfo
        }

        """;

    [Fact]
    public void ClassFieldReceiver_PinsAndReadsThroughPointer()
    {
        var source = BoneInfoPrelude + """
            unsafe func run() {
                var h = Holder()
                h.B.Name[0] = int8(71)
                h.B.Name[1] = int8(35)
                fixed p *int8 = h.B.Name {
                    Console.WriteLine(int32(p[0]))
                    Console.WriteLine(int32(p[1]))
                    p[2] = int8(33)
                }
                Console.WriteLine(int32(h.B.Name[2]))
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal(Lines("71", "35", "33"), output);
    }

    [Fact]
    public void BareBufferNameInsideDeclaringStruct_PinsIndexesAndWrites()
    {
        // The C# source shape `fixed (sbyte* p = Name) return p[0];` inside the
        // struct (receiver `this`, a movable ref) plus bare `Name[i]` reads and
        // writes (issue #4377).
        var source = BoneInfoPrelude + """
            unsafe func run() {
                var h = Holder()
                h.B.SetAt(0, int8(66))
                h.B.SetAt(5, int8(-3))
                Console.WriteLine(int32(h.B.First()))
                Console.WriteLine(int32(h.B.GetAt(5)))
                Console.WriteLine(int32(h.B.Name[5]))
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal(Lines("66", "-3", "-3"), output);
    }

    [Fact]
    public void ArrayElementAndRefParameterReceivers_Pin()
    {
        var source = BoneInfoPrelude + """
            unsafe func sum4(ref b BoneInfo) int32 {
                var total = 0
                fixed p *int8 = b.Name {
                    for var i = 0; i < 4; i++ {
                        total = total + int32(p[i])
                    }
                }
                return total
            }

            unsafe func run() {
                var bones = []BoneInfo{BoneInfo{}, BoneInfo{}}
                fixed q *int8 = bones[1].Name {
                    q[0] = int8(1)
                    q[1] = int8(2)
                    q[2] = int8(3)
                    q[3] = int8(4)
                }
                Console.WriteLine(int32(bones[1].Name[3]))
                Console.WriteLine(int32(bones[0].Name[3]))
                Console.WriteLine(sum4(ref bones[1]))
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal(Lines("4", "0", "10"), output);
    }

    [Fact]
    public void GenericStructBuffer_PinsInMethodAndInsideLambda()
    {
        // A buffer on a generic struct addresses its field through the
        // constructed TypeSpec; inside a lambda the holder is a captured
        // variable, so the pin is rooted at a closure field.
        var source = """
            package Probe
            import System

            unsafe struct GBuf[T] {
                fixed Data [4]int32
                var Tag T

                func Sum() int32 {
                    var t = 0
                    fixed p *int32 = Data {
                        for var i = 0; i < 4; i++ {
                            t = t + p[i]
                        }
                    }
                    return t
                }
            }

            unsafe class Box {
                var G GBuf[string]
            }

            unsafe func run() {
                var b = Box()
                b.G.Data[0] = 5
                b.G.Data[3] = 7
                Console.WriteLine(b.G.Sum())
                var f = func() int32 {
                    fixed q *int32 = b.G.Data {
                        q[1] = 30
                        return q[3]
                    }
                }
                Console.WriteLine(f())
                Console.WriteLine(b.G.Sum())
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal(Lines("12", "7", "42"), output);
    }

    [Fact]
    public void PinnedBuffer_SurvivesCollectionsInsideTheBlock()
    {
        // The pin must hold the heap object in place while the body allocates
        // and forces full compacting collections; the raw pointer taken before
        // the collections must still address the object's live buffer.
        var source = BoneInfoPrelude + """
            unsafe func churn() {
                var junk = []Object{}
                for var i = 0; i < 20000; i++ {
                    junk = []Object{Object()}
                }
                GC.Collect()
                GC.WaitForPendingFinalizers()
                GC.Collect()
            }

            unsafe func run() {
                var h = Holder()
                fixed p *int8 = h.B.Name {
                    churn()
                    p[7] = int8(99)
                    churn()
                    Console.WriteLine(int32(p[7]))
                }
                Console.WriteLine(int32(h.B.Name[7]))
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal(Lines("99", "99"), output);
    }

    [Fact]
    public void BareBufferPin_EmitsPinnedByRefToFixedElementField()
    {
        // C# emits, for `fixed (sbyte* p = Name)` in a struct method:
        //   ldarg.0
        //   ldflda  valuetype BoneInfo/'<Name>e__FixedBuffer' BoneInfo::Name
        //   ldflda  int8 BoneInfo/'<Name>e__FixedBuffer'::FixedElementField
        //   stloc   [int8& pinned]
        // gsc must produce the same pin: an `int8& pinned` local loaded from
        // the element-field address, released (nulled) in a finally.
        var tempDir = Directory.CreateTempSubdirectory("gs_issue4378_il_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, BoneInfoPrelude);
            Compile(srcPath, outPath, "library");

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();
            var first = md.MethodDefinitions
                .Select(md.GetMethodDefinition)
                .Single(m => md.GetString(m.Name) == "First");
            var body = pe.GetMethodBody(first.RelativeVirtualAddress);

            // The local signature carries ELEMENT_TYPE_PINNED ELEMENT_TYPE_BYREF ELEMENT_TYPE_I1.
            Assert.False(body.LocalSignature.IsNil, "expected a local signature");
            var localSig = md.GetBlobBytes(md.GetStandaloneSignature(body.LocalSignature).Signature);
            Assert.True(
                ContainsSequence(localSig, new byte[] { 0x45, 0x10, 0x04 }),
                $"expected an 'int8& pinned' local; signature was {BitConverter.ToString(localSig)}");

            // The pin is loaded from `ldflda Name; ldflda FixedElementField; stloc`.
            // (IlInstructionReader records operand tokens for calls only; `ldflda`
            // is a one-byte opcode followed by its 4-byte field token.)
            var ilBytes = body.GetILBytes() ?? Array.Empty<byte>();
            var il = IlInstructionReader.Read(ilBytes);
            string LdfldaField(IlInstruction i) => FieldName(md, BitConverter.ToInt32(ilBytes, i.Offset + 1));
            var ldfldaFields = il
                .Where(i => i.OpCode == OpCodes.Ldflda)
                .Select(LdfldaField)
                .ToList();
            Assert.Equal(new[] { "Name", "FixedElementField" }, ldfldaFields);

            var elementIndex = Array.FindIndex(
                il,
                i => i.OpCode == OpCodes.Ldflda && LdfldaField(i) == "FixedElementField");
            Assert.True(IsStloc(il[elementIndex + 1].OpCode), $"expected stloc after ldflda FixedElementField, got {il[elementIndex + 1].OpCode}");

            // The pin is released in a finally region.
            Assert.Contains(body.ExceptionRegions, r => r.Kind == ExceptionRegionKind.Finally);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }

    private static string Lines(params string[] lines)
        => string.Concat(lines.Select(l => l + Environment.NewLine));

    private static bool IsStloc(OpCode opCode)
        => opCode == OpCodes.Stloc || opCode == OpCodes.Stloc_S
            || opCode == OpCodes.Stloc_0 || opCode == OpCodes.Stloc_1
            || opCode == OpCodes.Stloc_2 || opCode == OpCodes.Stloc_3;

    private static string FieldName(MetadataReader md, int token)
    {
        var handle = MetadataTokens.EntityHandle(token);
        return handle.Kind switch
        {
            HandleKind.FieldDefinition => md.GetString(md.GetFieldDefinition((FieldDefinitionHandle)handle).Name),
            HandleKind.MemberReference => md.GetString(md.GetMemberReference((MemberReferenceHandle)handle).Name),
            _ => string.Empty,
        };
    }

    private static bool ContainsSequence(byte[] haystack, byte[] needle)
    {
        for (var i = 0; i + needle.Length <= haystack.Length; i++)
        {
            if (haystack.AsSpan(i, needle.Length).SequenceEqual(needle))
            {
                return true;
            }
        }

        return false;
    }

    private static void Compile(string srcPath, string outPath, string target)
    {
        var args = new[]
        {
            "/out:" + outPath,
            "/target:" + target,
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
            compileExit = Program.Main(args);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue4378_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            Compile(srcPath, outPath, "exe");

            IlVerifier.Verify(outPath, null, FixedIlVerifyIgnored);

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

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdoutTask = proc.StandardOutput.ReadToEndAsync();
            var stderrTask = proc.StandardError.ReadToEndAsync();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            var stdout = stdoutTask.GetAwaiter().GetResult();
            var stderr = stderrTask.GetAwaiter().GetResult();
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }
}
