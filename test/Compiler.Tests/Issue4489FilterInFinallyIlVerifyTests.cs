// <copyright file="Issue4489FilterInFinallyIlVerifyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Tests;
using Xunit;
using Xunit.Sdk;

namespace GSharp.Compiler.Tests;

/// <summary>
/// #4489: ilverify 10.0.8 reports <c>StackUnderflow</c> at the first
/// instruction of a <c>catch … when</c> filter whose start lies inside a
/// <c>finally</c> handler (upstream dotnet/runtime#134711). The IL is valid;
/// the test <see cref="IlVerifier"/> must accept exactly that shape and keep
/// reporting every other stack underflow.
/// </summary>
public class Issue4489FilterInFinallyIlVerifyTests
{
    private const string Source = """
        package P

        import System
        import System.IO

        public func A() string {
            try {
                return "a"
            } finally {
                try {
                    Console.WriteLine("cleanup")
                } catch (ex Exception) when ex is IOException {
                }
            }
        }

        public func B(prefix string) string {
            let suffix = "!"
            let f = func() string {
                try {
                    return prefix + suffix
                } finally {
                    try {
                        Console.WriteLine("cleanup2")
                    } catch (ex Exception) when ex is IOException {
                    }
                }
            }
            return f()
        }
        """;

    [Fact]
    public void FilterInFinally_CompilesRunsAndVerifies()
    {
        string dir = Directory.CreateTempSubdirectory("gs_ilv_4489_").FullName;
        try
        {
            string dll = Compile(dir);

            var context = new AssemblyLoadContext("issue4489-" + Guid.NewGuid().ToString("N"), isCollectible: true);
            try
            {
                Type program = context.LoadFromAssemblyPath(dll).GetType("P.<Program>")
                    ?? throw new XunitException("P.<Program> not emitted");
                MethodInfo a = program.GetMethod("A") ?? throw new XunitException("A not emitted");
                MethodInfo b = program.GetMethod("B") ?? throw new XunitException("B not emitted");
                Assert.Equal("a", a.Invoke(null, null));
                Assert.Equal("b!", b.Invoke(null, new object[] { "b" }));
            }
            finally
            {
                context.Unload();
            }

            // Both the top-level function and the closure body carry the
            // layout; before #4489 this threw with two StackUnderflow lines.
            IlVerifier.Verify(dll);
        }
        finally
        {
            TryDelete(dir);
        }
    }

    [Fact]
    public void RealStackUnderflowElsewhereInSameMethod_IsStillReported()
    {
        if (!IlVerifier.IsEnabled)
        {
            return;
        }

        string dir = Directory.CreateTempSubdirectory("gs_ilv_4489_neg_").FullName;
        try
        {
            string dll = Compile(dir);

            // Corrupt A's first instruction (the 1-byte `ldnull` that seeds
            // its result local) into `pop`: a genuine underflow at offset 0, in
            // the same method whose filter start the rule accepts.
            byte[] bytes = File.ReadAllBytes(dll);
            using (var pe = new PEReader(new MemoryStream(bytes, writable: false)))
            {
                MetadataReader md = pe.GetMetadataReader();
                MethodDefinition a = md.MethodDefinitions
                    .Select(md.GetMethodDefinition)
                    .Single(m => md.GetString(m.Name) == "A");
                MethodBodyBlock body = pe.GetMethodBody(a.RelativeVirtualAddress);
                Assert.Contains(body.ExceptionRegions, r => r.Kind == ExceptionRegionKind.Filter);
                byte[] il = body.GetILBytes() ?? throw new XunitException("A has no IL body");
                Assert.Equal(0x14, il[0]);

                SectionHeader section = pe.PEHeaders.SectionHeaders.Single(s =>
                    a.RelativeVirtualAddress >= s.VirtualAddress
                    && a.RelativeVirtualAddress < s.VirtualAddress + s.SizeOfRawData);
                int headerOffset = a.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData;
                int headerSize = (bytes[headerOffset + 1] >> 4) * 4; // fat header (method has EH)
                int code = headerOffset + headerSize;
                bytes[code] = 0x26;
            }

            File.WriteAllBytes(dll, bytes);

            XunitException error = Assert.Throws<XunitException>(() => IlVerifier.Verify(dll));
            Assert.Contains("<Program>::A()][offset 0x00000000] Stack underflow", error.Message, StringComparison.Ordinal);
        }
        finally
        {
            TryDelete(dir);
        }
    }

    [Fact]
    public void Rule_MatchesOnlyTheFilterStart_OfTheRealAssembly()
    {
        string dir = Directory.CreateTempSubdirectory("gs_ilv_4489_rule_").FullName;
        try
        {
            string dll = Compile(dir);
            int filterOffset;
            using (var pe = new PEReader(File.OpenRead(dll)))
            {
                MetadataReader md = pe.GetMetadataReader();
                MethodDefinition a = md.MethodDefinitions
                    .Select(md.GetMethodDefinition)
                    .Single(m => md.GetString(m.Name) == "A");
                filterOffset = pe.GetMethodBody(a.RelativeVirtualAddress).ExceptionRegions
                    .Single(r => r.Kind == ExceptionRegionKind.Filter).FilterOffset;
            }

            IlVerifyFilterInFinallyRule rule = IlVerifyFilterInFinallyRule.Load(dll);
            Assert.True(rule.Matches("StackUnderflow", Line("StackUnderflow", "P.<Program>::A()", filterOffset)));
            Assert.False(rule.Matches("StackUnderflow", Line("StackUnderflow", "P.<Program>::A()", filterOffset + 1)));
            Assert.False(rule.Matches("StackUnderflow", Line("StackUnderflow", "P.<Program>::A()", 0)));
            Assert.False(rule.Matches("StackUnderflow", Line("StackUnderflow", "P.<Program>::B(string)", filterOffset)));
            Assert.False(rule.Matches("StackUnderflow", Line("StackUnderflow", "P.<Program>::A(string)", filterOffset)));
            Assert.False(rule.Matches("StackUnexpected", Line("StackUnexpected", "P.<Program>::A()", filterOffset)));
        }
        finally
        {
            TryDelete(dir);
        }
    }

    private static string Line(string code, string member, int offset) =>
        $"[IL]: Error [{code}]: [/abs/x.dll : {member}][offset 0x{offset:X8}] Stack underflow.";

    private static string Compile(string dir)
    {
        string src = Path.Combine(dir, "repro.gs");
        string dll = Path.Combine(dir, "repro.dll");
        File.WriteAllText(src, Source);
        int exit = Program.Main(new[]
        {
            "/out:" + dll,
            "/target:library",
            "/targetframework:net10.0",
            src,
        });
        Assert.Equal(0, exit);
        return dll;
    }

    private static void TryDelete(string dir)
    {
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
