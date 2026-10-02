// <copyright file="Issue4663EmitOrderIndependenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #4663: emitted output must not depend on the identity-hash order of
/// the symbol-keyed dictionaries the lowering passes walk.
/// </summary>
/// <remarks>
/// The existing determinism guards (#598) compile the same input twice with
/// the same compiler, which is exactly the case identity hashes reproduce:
/// CoreCLR derives them from a per-thread generator, so the same binary
/// allocating the same objects gets the same hashes. These tests perturb
/// what actually varies in practice — an unrelated input file, the file
/// order — and pin the synthesized names themselves to source order. Before
/// the fix the capture-box classes were numbered in hash-bucket order
/// (<c>n18_1 n15_2 n32_3 …</c>), renumbered when an unrelated file was
/// added, and a G#-built compiler numbered them differently again, which is
/// what broke the self-host stage-2 equivalence check (#4631).
/// </remarks>
public class Issue4663EmitOrderIndependenceTests
{
    private const int CaptureCount = 24;

    private static readonly Dictionary<short, OpCode> OpCodesByValue = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Select(field => (OpCode)field.GetValue(null)!) // OpCodes' public static fields are all non-null OpCode values.
        .ToDictionary(opCode => opCode.Value);

    /// <summary>The capture boxes are numbered in source order.</summary>
    [Fact]
    public void CaptureBoxes_AreNumberedInSourceOrder()
    {
        byte[] image = Emit(ProgramTree());

        IReadOnlyList<string> boxes = BoxTypeNames(image);

        Assert.Equal(
            Enumerable.Range(0, CaptureCount).Select(i => $"<>__Box_n{i}_{i + 1}").ToArray(),
            boxes);
    }

    /// <summary>
    /// An unrelated, closure-free file — before or after the program —
    /// changes nothing the program's own code compiles to.
    /// </summary>
    [Fact]
    public void UnrelatedFile_PrependedOrAppended_LeavesTheProgramsCodeUnchanged()
    {
        IReadOnlyDictionary<string, string> alone = ProgramMethodBodies(Emit(ProgramTree()));
        IReadOnlyDictionary<string, string> appended = ProgramMethodBodies(Emit(ProgramTree(), UnrelatedTree()));
        IReadOnlyDictionary<string, string> prepended = ProgramMethodBodies(Emit(UnrelatedTree(), ProgramTree()));

        Assert.NotEmpty(alone);
        Assert.Equal(alone, appended);
        Assert.Equal(alone, prepended);
        Assert.Equal(BoxTypeNames(Emit(ProgramTree())), BoxTypeNames(Emit(UnrelatedTree(), ProgramTree())));
    }

    /// <summary>Reversing the input file order yields the same IL and metadata (MVID zeroed).</summary>
    [Fact]
    public void ReversedFileOrder_ProducesIdenticalIlAndMetadata()
    {
        string forward = HashIlAndMetadata(Emit(ProgramTree(), UnrelatedTree(), ShapesTree()));
        string reversed = HashIlAndMetadata(Emit(ShapesTree(), UnrelatedTree(), ProgramTree()));

        Assert.Equal(forward, reversed);
    }

    /// <summary>
    /// Synthesized types (state machines, closure classes, boxes) keep their
    /// names and order whatever unrelated input surrounds them. A single
    /// perturbation can leave a tie in its old order by chance, so this
    /// compiles the shapes beside unrelated files of several sizes, before and
    /// after, and requires one answer across all of them.
    /// </summary>
    [Fact]
    public void SynthesizedTypes_AreTheSameWhateverUnrelatedInputSurroundsThem()
    {
        var layouts = new List<IReadOnlyList<string>>();
        foreach (int size in new[] { 1, 7, 23, 61, 157, 401 })
        {
            layouts.Add(TypeLayout(Emit(UnrelatedTree(size), ShapesTree())));
            layouts.Add(TypeLayout(Emit(ShapesTree(), UnrelatedTree(size))));
        }

        Assert.Contains(layouts[0], name => name.Contains("Run", StringComparison.Ordinal));
        Assert.All(layouts, layout => Assert.Equal(layouts[0], layout));
    }

    private static SyntaxTree ProgramTree()
    {
        var source = new StringBuilder("package Repro\n\nimport System\n\n");
        for (int i = 0; i < CaptureCount; i++)
        {
            source.Append($"func f{i}() int32 {{\n    var n{i} = {i}\n    var bump = func () {{ n{i} = n{i} + 1 }}\n")
                .Append("    bump()\n")
                .Append($"    return n{i}\n}}\n\n");
        }

        source.Append("Console.WriteLine(")
            .Append(string.Join(" + ", Enumerable.Range(0, CaptureCount).Select(i => $"f{i}()")))
            .Append(")\n");
        return SyntaxTree.Parse(SourceText.From(source.ToString(), "Program.gs"));
    }

    // Enough closure-free declarations to shift every allocation the binder
    // and lowering passes make, which is what reshuffled identity hashes.
    private static SyntaxTree UnrelatedTree(int functions = 200)
    {
        var source = new StringBuilder("package Repro\n\n");
        for (int i = 0; i < functions; i++)
        {
            source.Append($"func g{i}(x int32) int32 {{\n    let y = x * {i} + 1\n    return y\n}}\n\n");
        }

        return SyntaxTree.Parse(SourceText.From(source.ToString(), "Unrelated.gs"));
    }

    // Shapes whose synthesized names were numbered in a pass that walked the
    // program in hash order, or ordered by a key that ties: same-named
    // iterators and async methods in different types, interpolation, and
    // closures inside constructors (initialization plans).
    private static SyntaxTree ShapesTree() => SyntaxTree.Parse(SourceText.From(
        ShapesSource + FieldLambdaClasses(),
        "Shapes.gs"));

    // Field initializers become per-type initialization plans, a second
    // symbol-keyed dictionary; a dozen of them make a hash-order walk of
    // the plans visibly unstable.
    private static string FieldLambdaClasses()
    {
        var source = new StringBuilder();
        for (int i = 0; i < 12; i++)
        {
            source.Append($"\nclass Plan{i} {{\n    var Apply Func[int32, int32] = func (x int32) int32 {{ return x + {i} }}\n}}\n");
        }

        return source.ToString();
    }

    private const string ShapesSource =
        """
        package Repro

        import System
        import System.Collections.Generic
        import System.Threading.Tasks

        class Left(Seed int32) {
            func Items() IEnumerable[int32] {
                yield Seed
                yield Seed + 1
            }

            async func Run(n int32) int32 {
                await Task.Delay(1)
                return Seed + n
            }

            func Describe() string {
                return "left $Seed"
            }
        }

        class Right(Seed int32) {
            func Items() IEnumerable[int32] {
                yield Seed * 2
            }

            async func Run(n int32) int32 {
                await Task.Delay(1)
                return Seed * n
            }

            func Describe() string {
                return "right $Seed"
            }
        }

        class Hooks {
            var Count int32
            var Twice Func[int32, int32] = func (x int32) int32 { return x * 2 }

            init() {
                var k = 1
                var bump = func () { k = k + 1 }
                bump()
                Count = k
            }
        }

        class Gauges {
            var Level int32
            var Thrice Func[int32, int32] = func (x int32) int32 { return x * 3 }

            init() {
                var m = 2
                var grow = func () { m = m * 3 }
                grow()
                Level = m
            }
        }

        """;

    private static byte[] Emit(params SyntaxTree[] trees)
    {
        var compilation = new Compilation(trees)
        {
            DebugInformation = new DebugInformationOptions { Deterministic = true },
        };

        using var peStream = new MemoryStream();
        var result = compilation.Emit(
            peStream: peStream,
            pdbStream: null,
            refStream: null,
            assemblyName: "GSharp.Issue4663",
            assemblyVersion: "1.0.0.0");
        Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select(d => d.Message)));
        return peStream.ToArray();
    }

    // Every TypeDef as "Enclosing/Name" in table order; the unrelated file
    // declares no types, so any difference is the shapes' own.
    private static IReadOnlyList<string> TypeLayout(byte[] image)
    {
        using var pe = new PEReader(new MemoryStream(image, writable: false));
        MetadataReader reader = pe.GetMetadataReader();
        return reader.TypeDefinitions
            .Select(handle =>
            {
                TypeDefinition type = reader.GetTypeDefinition(handle);
                TypeDefinitionHandle enclosing = type.GetDeclaringType();
                string outer = enclosing.IsNil ? string.Empty : reader.GetString(reader.GetTypeDefinition(enclosing).Name);
                return outer + "/" + reader.GetString(type.Name);
            })
            .ToArray();
    }

    private static IReadOnlyList<string> BoxTypeNames(byte[] image)
    {
        using var pe = new PEReader(new MemoryStream(image, writable: false));
        MetadataReader reader = pe.GetMetadataReader();
        return reader.TypeDefinitions
            .Select(handle => reader.GetString(reader.GetTypeDefinition(handle).Name))
            .Where(name => name.StartsWith("<>__Box_", StringComparison.Ordinal))
            .ToArray();
    }

    // The IL of every method the program file declares (f0..fN and the
    // closures and box constructors they own), keyed by declaring type and
    // name, with metadata tokens resolved to names so a body compares equal
    // only if it references the same members by the same names.
    private static IReadOnlyDictionary<string, string> ProgramMethodBodies(byte[] image)
    {
        using var pe = new PEReader(new MemoryStream(image, writable: false));
        MetadataReader reader = pe.GetMetadataReader();
        var bodies = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (MethodDefinitionHandle handle in reader.MethodDefinitions)
        {
            MethodDefinition method = reader.GetMethodDefinition(handle);
            string name = reader.GetString(method.Name);
            string type = reader.GetString(reader.GetTypeDefinition(method.GetDeclaringType()).Name);
            if (name.StartsWith('g') || method.RelativeVirtualAddress == 0)
            {
                continue;
            }

            byte[] il = pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes() ?? Array.Empty<byte>();
            bodies[type + "::" + name] = Convert.ToHexString(SHA256.HashData(StripTokens(il)));
        }

        return bodies;
    }

    // Tokens are row numbers, which legitimately shift when another file adds
    // rows; the opcode stream (and, through the type and method names keyed
    // above, the synthesized names) is what must not change. Blank every
    // metadata-token operand.
    private static byte[] StripTokens(byte[] il)
    {
        byte[] copy = (byte[])il.Clone();
        int offset = 0;
        while (offset < copy.Length)
        {
            short value = copy[offset] == 0xFE && offset + 1 < copy.Length
                ? (short)(0xFE00 | copy[offset + 1])
                : copy[offset];
            OpCode opCode = OpCodesByValue[value];
            offset += opCode.Size;
            switch (opCode.OperandType)
            {
                case OperandType.InlineField:
                case OperandType.InlineMethod:
                case OperandType.InlineSig:
                case OperandType.InlineString:
                case OperandType.InlineTok:
                case OperandType.InlineType:
                    Array.Clear(copy, offset, 4);
                    offset += 4;
                    break;
                case OperandType.InlineSwitch:
                    offset += 4 + (4 * BitConverter.ToInt32(copy, offset));
                    break;
                case OperandType.InlineI8:
                case OperandType.InlineR:
                    offset += 8;
                    break;
                case OperandType.InlineBrTarget:
                case OperandType.InlineI:
                case OperandType.ShortInlineR:
                    offset += 4;
                    break;
                case OperandType.InlineVar:
                    offset += 2;
                    break;
                case OperandType.ShortInlineBrTarget:
                case OperandType.ShortInlineI:
                case OperandType.ShortInlineVar:
                    offset += 1;
                    break;
            }
        }

        return copy;
    }

    private static string HashIlAndMetadata(byte[] bytes)
    {
        using var pe = new PEReader(new MemoryStream(bytes, writable: false));
        MetadataReader reader = pe.GetMetadataReader();
        byte[] metadata = bytes.AsSpan(pe.PEHeaders.MetadataStartOffset, pe.PEHeaders.MetadataSize).ToArray();
        byte[] mvid = reader.GetGuid(reader.GetModuleDefinition().Mvid).ToByteArray();
        for (int at = metadata.AsSpan().IndexOf(mvid); at >= 0; at = metadata.AsSpan().IndexOf(mvid))
        {
            metadata.AsSpan(at, mvid.Length).Clear();
        }

        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(metadata);
        foreach (MethodDefinitionHandle handle in reader.MethodDefinitions)
        {
            int rva = reader.GetMethodDefinition(handle).RelativeVirtualAddress;
            if (rva != 0)
            {
                hash.AppendData(pe.GetMethodBody(rva).GetILBytes() ?? Array.Empty<byte>());
            }
        }

        return Convert.ToHexString(hash.GetHashAndReset());
    }
}
