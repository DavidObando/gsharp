// <copyright file="Issue1035FixedBufferEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #1035 / ADR-0122 §10: end-to-end emit + execution + metadata tests for
/// fixed-size buffers (`fixed name [N]T` inside an unsafe struct). The
/// buffer lowers to a compiler-generated nested backing struct with an explicit
/// `ClassLayout` size of `N * sizeof(T)`, a single element field, the
/// containing field typed as that nested struct and carrying
/// `[FixedBuffer(typeof(T), N)]`. The field decays to a `*T` to the
/// first element, indexable as `name[i]`.
open class Issue1035FixedBufferEmitTests {
    @Fact
    func FixedBuffer_WriteReadThroughPointer_CompilesAndRuns() {
        let source = BufStruct + `unsafe func run() {
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

run()`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}9${Environment.NewLine}49${Environment.NewLine}", output)
    }

    @Fact
    func FixedBuffer_Metadata_NestedStructSizeAndFixedBufferAttribute() {
        let tempDir = Directory.CreateTempSubdirectory("gs_issue1035_fb_md_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, BufStruct + "\n")
            Compile(srcPath, outPath, "library")
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            // The compiler-generated backing struct <data>e__FixedBuffer.
            let backing = md
                .TypeDefinitions
                .Select(md.GetTypeDefinition)
                .FirstOrDefault((t TypeDefinition) -> md.GetString(t.Name).Contains("e__FixedBuffer"))
            Assert.False(md.GetString(backing.Name).Length == 0, "expected a <data>e__FixedBuffer backing struct")
            // Sequential layout with explicit Size = 8 * sizeof(int32) = 32.
            let layout = backing.GetLayout()
            Assert.False(layout.IsDefault, "expected a ClassLayout row for the fixed-buffer backing struct")
            Assert.Equal(32, layout.Size)
            // Single element field FixedElementField : int32.
            let fieldNames = backing
                .GetFields()
                .Select((fh FieldDefinitionHandle) -> md.GetString(md.GetFieldDefinition(fh).Name))
                .ToList()
            Assert.Contains("FixedElementField", fieldNames)
            // CompilerGenerated + UnsafeValueType on the backing struct.
            Assert.True(HasCustomAttribute(md, backing.GetCustomAttributes(), "CompilerGeneratedAttribute"))
            Assert.True(HasCustomAttribute(md, backing.GetCustomAttributes(), "UnsafeValueTypeAttribute"))
            // [FixedBuffer(typeof(int32), 8)] on the containing field 'data'.
            let bufType = md
                .TypeDefinitions
                .Select(md.GetTypeDefinition)
                .First((t TypeDefinition) -> md.GetString(t.Name) == "Buf")
            let dataField = bufType
                .GetFields()
                .Select(md.GetFieldDefinition)
                .First((f FieldDefinition) -> md.GetString(f.Name) == "data")
            Assert.True(HasCustomAttribute(md, dataField.GetCustomAttributes(), "FixedBufferAttribute"))
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch {
                // ignored

            }
        }
    }

    shared {
        private let UnsafeIlVerifyIgnored[]string = []string{
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType"
        }

        private const BufStruct string = `package Probe
import System

unsafe struct Buf {
    fixed data [8]int32
}
`

        private func HasCustomAttribute(
            md MetadataReader,
            handles CustomAttributeHandleCollection,
            simpleAttrName string
        ) bool {
            for h in handles {
                let ca = md.GetCustomAttribute(h)
                var typeName string? = nil
                if ca.Constructor.Kind == HandleKind.MemberReference {
                    let mr = md.GetMemberReference(MemberReferenceHandle(ca.Constructor))
                    if mr.Parent.Kind == HandleKind.TypeReference {
                        let tr = md.GetTypeReference(TypeReferenceHandle(mr.Parent))
                        typeName = md.GetString(tr.Name)
                    }
                }
                if typeName == simpleAttrName {
                    return true
                }
            }
            return false
        }

        private func Compile(srcPath string, outPath string, target string) {
            let args = []string{"/out:" + outPath, "/target:" + target, "/targetframework:net10.0", srcPath}
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1035_fb_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                Compile(srcPath, outPath, "exe")
                IlVerifier.Verify(outPath, nil, UnsafeIlVerifyIgnored)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // ignored

                }
            }
        }
    }
}
