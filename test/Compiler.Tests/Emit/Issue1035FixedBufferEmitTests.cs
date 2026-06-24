// <copyright file="Issue1035FixedBufferEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1035 / ADR-0122 §10: end-to-end emit + execution + metadata tests for
/// fixed-size buffers (<c>fixed name [N]T</c> inside an unsafe struct). The
/// buffer lowers to a compiler-generated nested backing struct with an explicit
/// <c>ClassLayout</c> size of <c>N * sizeof(T)</c>, a single element field, the
/// containing field typed as that nested struct and carrying
/// <c>[FixedBuffer(typeof(T), N)]</c>. The field decays to a <c>*T</c> to the
/// first element, indexable as <c>name[i]</c>.
/// </summary>
public class Issue1035FixedBufferEmitTests
{
    private static readonly string[] UnsafeIlVerifyIgnored =
    {
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
    };

    private const string BufStruct = """
        package Probe
        import System

        unsafe struct Buf {
            fixed data [8]int32
        }

        """;

    [Fact]
    public void FixedBuffer_WriteReadThroughPointer_CompilesAndRuns()
    {
        var source = BufStruct + """
            unsafe func run() {
                var b = Buf{}
                var p = &b
                var i = 0
                for i < 8 {
                    p->data[i] = i * i
                    i = i + 1
                }
                Console.WriteLine(p->data[0])
                Console.WriteLine(p->data[3])
                Console.WriteLine(p->data[7])
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n9\n49\n", output);
    }

    [Fact]
    public void FixedBuffer_Metadata_NestedStructSizeAndFixedBufferAttribute()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1035_fb_md_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, BufStruct + "\n");

            Compile(srcPath, outPath, "library");

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            // The compiler-generated backing struct <data>e__FixedBuffer.
            var backing = md.TypeDefinitions
                .Select(md.GetTypeDefinition)
                .FirstOrDefault(t => md.GetString(t.Name).Contains("e__FixedBuffer"));
            Assert.False(md.GetString(backing.Name).Length == 0, "expected a <data>e__FixedBuffer backing struct");

            // Sequential layout with explicit Size = 8 * sizeof(int32) = 32.
            var layout = backing.GetLayout();
            Assert.False(layout.IsDefault, "expected a ClassLayout row for the fixed-buffer backing struct");
            Assert.Equal(32, layout.Size);

            // Single element field FixedElementField : int32.
            var fieldNames = backing.GetFields().Select(fh => md.GetString(md.GetFieldDefinition(fh).Name)).ToList();
            Assert.Contains("FixedElementField", fieldNames);

            // CompilerGenerated + UnsafeValueType on the backing struct.
            Assert.True(HasCustomAttribute(md, backing.GetCustomAttributes(), "CompilerGeneratedAttribute"));
            Assert.True(HasCustomAttribute(md, backing.GetCustomAttributes(), "UnsafeValueTypeAttribute"));

            // [FixedBuffer(typeof(int32), 8)] on the containing field 'data'.
            var bufType = md.TypeDefinitions
                .Select(md.GetTypeDefinition)
                .First(t => md.GetString(t.Name) == "Buf");
            var dataField = bufType.GetFields()
                .Select(md.GetFieldDefinition)
                .First(f => md.GetString(f.Name) == "data");
            Assert.True(HasCustomAttribute(md, dataField.GetCustomAttributes(), "FixedBufferAttribute"));
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

    private static bool HasCustomAttribute(MetadataReader md, CustomAttributeHandleCollection handles, string simpleAttrName)
    {
        foreach (var h in handles)
        {
            var ca = md.GetCustomAttribute(h);
            string typeName = null;
            if (ca.Constructor.Kind == HandleKind.MemberReference)
            {
                var mr = md.GetMemberReference((MemberReferenceHandle)ca.Constructor);
                if (mr.Parent.Kind == HandleKind.TypeReference)
                {
                    var tr = md.GetTypeReference((TypeReferenceHandle)mr.Parent);
                    typeName = md.GetString(tr.Name);
                }
            }

            if (typeName == simpleAttrName)
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1035_fb_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            Compile(srcPath, outPath, "exe");

            IlVerifier.Verify(outPath, null, UnsafeIlVerifyIgnored);

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
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
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
