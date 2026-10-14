// <copyright file="Issue775ConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit
import Xunit.Sdk

/// ADR-0097 / issue #775: end-to-end emit + IL-verify coverage for the
/// new G# spelling of `class` / `struct` / `init()`
/// type-parameter constraints. Each test:
/// 1. compiles a tiny program containing a generic function with the constraint;
/// 2. asks (cref:IlVerifier.Verify) to confirm the produced IL passes formal verification;
/// 3. inspects the emitted assembly metadata to confirm the (cref:GenericParameterAttributes) flag bits
/// were written exactly as ECMA-335 II.10.1.7 mandates; and
/// 4. runs the produced binary under the CoreCLR JIT to confirm the constraint is enforced at run time
/// as well.
open class Issue775ConstraintEmitTests {
    @Fact
    func ClassConstraint_Emits_ReferenceTypeConstraint_Flag() {
        let source = `package P
import System

func Pick[T class](x T) T { return x }
Console.WriteLine(Pick[string]("hi"))`
        let outPath = CompileAndRun(source, out var output)
        Assert.Equal("hi${Environment.NewLine}", output)
        let attrs = ReadGenericParamAttrs(outPath, "Pick")
        Assert.True(
            (attrs & GenericParameterAttributes.ReferenceTypeConstraint) != 0,
            "expected ReferenceTypeConstraint, got $attrs"
        )
        Assert.True(
            (attrs & GenericParameterAttributes.NotNullableValueTypeConstraint) == 0,
            "unexpected NotNullableValueTypeConstraint, got $attrs"
        )
        Assert.True(
            (attrs & GenericParameterAttributes.DefaultConstructorConstraint) == 0,
            "unexpected DefaultConstructorConstraint, got $attrs"
        )
    }

    @Fact
    func StructConstraint_Emits_ValueType_And_DefaultCtor_Flags() {
        let source = `package P
import System

func Pick[T struct](x T) T { return x }
Console.WriteLine(Pick[int32](42))`
        let outPath = CompileAndRun(source, out var output)
        Assert.Equal("42${Environment.NewLine}", output)
        let attrs = ReadGenericParamAttrs(outPath, "Pick")
        Assert.True(
            (attrs & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0,
            "expected NotNullableValueTypeConstraint, got $attrs"
        )
        // ECMA-335 II.10.1.7 — `struct` implies `init()` at the CLR level.
        Assert.True(
            (attrs & GenericParameterAttributes.DefaultConstructorConstraint) != 0,
            "expected DefaultConstructorConstraint (struct implies it), got $attrs"
        )
        Assert.True(
            (attrs & GenericParameterAttributes.ReferenceTypeConstraint) == 0,
            "unexpected ReferenceTypeConstraint, got $attrs"
        )
    }

    @Fact
    func NewConstraint_Emits_DefaultCtor_Flag_Only() {
        let source = `package P
import System

class Box {}
func Make[T init()](x T) T { return x }
Console.WriteLine(Make(Box()))`
        let outPath = CompileAndRun(source, out _)
        let attrs = ReadGenericParamAttrs(outPath, "Make")
        Assert.True(
            (attrs & GenericParameterAttributes.DefaultConstructorConstraint) != 0,
            "expected DefaultConstructorConstraint, got $attrs"
        )
        Assert.True(
            (attrs & GenericParameterAttributes.ReferenceTypeConstraint) == 0,
            "unexpected ReferenceTypeConstraint, got $attrs"
        )
        Assert.True(
            (attrs & GenericParameterAttributes.NotNullableValueTypeConstraint) == 0,
            "unexpected NotNullableValueTypeConstraint, got $attrs"
        )
    }

    @Fact
    func ClassAndNew_Combined_Emits_Both_Flags() {
        let source = `package P
import System

class Box {}
func Make[T class init()](x T) T { return x }
Console.WriteLine(Make(Box()))`
        let outPath = CompileAndRun(source, out _)
        let attrs = ReadGenericParamAttrs(outPath, "Make")
        Assert.True(
            (attrs & GenericParameterAttributes.ReferenceTypeConstraint) != 0,
            "expected ReferenceTypeConstraint, got $attrs"
        )
        Assert.True(
            (attrs & GenericParameterAttributes.DefaultConstructorConstraint) != 0,
            "expected DefaultConstructorConstraint, got $attrs"
        )
    }

    shared {
        private func ReadGenericParamAttrs(assemblyPath string, methodName string) GenericParameterAttributes {
            using let stream = File.OpenRead(assemblyPath)
            using let pe = PEReader(stream)
            let md = pe.GetMetadataReader()
            for mh in md.MethodDefinitions {
                let mdef = md.GetMethodDefinition(mh)
                let name = md.GetString(mdef.Name)
                if name != methodName {
                    continue
                }
                let gps = mdef.GetGenericParameters()
                Assert.True(gps.Count >= 1, "no generic parameters on '$methodName'")
                let gpHandle = gps.First()
                let gp = md.GetGenericParameter(gpHandle)
                return gp.Attributes
            }
            throw XunitException("could not find method '$methodName' in '$assemblyPath'")
        }

        private func CompileAndRun(source string, out output string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue775_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                // Stash the produced assembly outside the temp dir so the
                // caller can inspect metadata after the temp dir is cleaned.
                let keepDir = Directory.CreateTempSubdirectory("gs_issue775_keep_").FullName
                let keepPath = Path.Combine(keepDir, Path.GetFileName(outPath))
                File.Copy(outPath, keepPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                output = stdout.ReplaceLineEndings(Environment.NewLine)
                return keepPath
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
