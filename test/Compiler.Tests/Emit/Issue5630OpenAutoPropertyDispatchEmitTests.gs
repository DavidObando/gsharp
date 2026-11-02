// <copyright file="Issue5630OpenAutoPropertyDispatchEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Issue #5630: an auto-property access inside its declaring type lowers to the
/// backing field only when the dispatch is exact.
/// @remarks The lowerer read and wrote the backing field of every auto-property
/// that the enclosing type declares. For an `open` or `override` property, a
/// subclass override was then skipped without a diagnostic. Each case compiles,
/// verifies and runs, and its output is the output of the equivalent C# program.
open class Issue5630OpenAutoPropertyDispatchEmitTests {
    /// Each case prints the same lines as the equivalent C# program.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func EveryAccessShape_MatchesCSharp(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_5630_").FullName
        try {
            let dllPath = Compile(tempDir, source)
            let expected = string.Join("\n", expectedLines) + "\n"
            Assert.Equal(expected, Run(tempDir, dllPath))
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    /// An access with exact dispatch still reads and writes the backing field, and an
    /// access that a subclass can override calls the accessor.
    /// @remarks `Final` is not open, so its `override` auto-property has exact
    /// dispatch. `Plain` is not open. `Closed` and `Pt` cannot have a subclass.
    /// `Base.Auto` is open in an open class, so `ReadAuto` must call `get_Auto`.
    @Fact
    func ExactDispatch_KeepsTheFieldAccess_AndOpenDispatch_CallsTheAccessor() {
        let tempDir = Directory.CreateTempSubdirectory("gs_5630_il_").FullName
        try {
            let dllPath = Compile(tempDir, ControlSource)
            using let stream = File.OpenRead(dllPath)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            AssertFieldAccess(pe, reader, "Final", "ReadFinal", OpCodes.Ldfld, "get_Auto")
            AssertFieldAccess(pe, reader, "Final", "WriteFinal", OpCodes.Stfld, "set_Auto")
            AssertFieldAccess(pe, reader, "Base", "ReadPlain", OpCodes.Ldfld, "get_Plain")
            AssertFieldAccess(pe, reader, "Base", "WritePlain", OpCodes.Stfld, "set_Plain")
            AssertFieldAccess(pe, reader, "Closed", "ReadValue", OpCodes.Ldfld, "get_Value")
            AssertFieldAccess(pe, reader, "Closed", "WriteValue", OpCodes.Stfld, "set_Value")
            AssertFieldAccess(pe, reader, "Pt", "ReadX", OpCodes.Ldfld, "get_X")
            let readAuto = Body(pe, reader, "Base", "ReadAuto")
            Assert.DoesNotContain(readAuto, (i IlInstruction) -> i.OpCode == OpCodes.Ldfld)
            Assert.Contains(
                readAuto,
                (i IlInstruction) -> i.OpCode == OpCodes.Callvirt && CalleeName(reader, i) == "get_Auto"
            )
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    shared {
        func Cases() sequence[[]object] {
            yield[]object{
                "an-open-auto-property-read-runs-the-override",
                ReadsSource,
                []string{"42", "42", "42", "42", "7", "9"}
            }
            yield[]object{
                "an-open-auto-property-write-runs-the-override",
                WritesSource,
                []string{"set 1;set 2;set 3;set 41;", "6"}
            }
            yield[]object{"a-base-access-reads-the-base-storage", BaseAccessSource, []string{"110", "110"}}
            yield[]object{
                "an-interface-property-runs-the-override",
                InterfaceSource,
                []string{"Derived.set_Tag 3", "46", "46", "8", "8"}
            }
            yield[]object{
                "a-constructor-store-matches-csharp",
                CtorSource,
                []string{"Derived.set_Auto 1", "Derived.init_Init 3", "42", "44", "1", "12", "43", "53"}
            }
            yield[]object{"an-exact-dispatch-keeps-the-field-access", ControlSource, []string{"4", "4", "6", "8", "9"}}
        }

        private const ReadsSource string = `package Issue5630Reads
import System

open class Base {
    open prop Auto int32 { get; set; }
    func ReadImplicit() int32 -> Auto
    func ReadThis() int32 -> this.Auto
    func ReadOther(o Base) int32 -> o.Auto
    func ReadNarrowed(o Base) int32 {
        if o is Derived {
            return o.Auto
        }
        return -1
    }
}

class Derived : Base {
    override prop Auto int32 {
        get -> 42
        set { }
    }
}

open class Box[T] {
    open prop Value T { get; set; }
    func Read() T -> Value
}

class IntBox : Box[int32] {
    override prop Value int32 {
        get -> 7
        set { }
    }
}

open class Root {
    open prop Auto int32 { get; set; }
}

sealed class Shape : Root {
    override prop Auto int32 { get; set; }
    func Read() int32 -> Auto
}

class Circle : Shape {
    override prop Auto int32 {
        get -> 9
        set { }
    }
}

func Main() {
    let d = Derived()
    Console.WriteLine(d.ReadImplicit())
    Console.WriteLine(d.ReadThis())
    Console.WriteLine(Base().ReadOther(d))
    Console.WriteLine(Base().ReadNarrowed(d))
    Console.WriteLine(IntBox().Read())
    Console.WriteLine(Circle().Read())
}
`

        private const WritesSource string = `package Issue5630Writes
import System

open class Base {
    open prop Auto int32 { get; set; }
    func WriteImplicit(v int32) { Auto = v }
    func WriteThis(v int32) { this.Auto = v }
    func WriteOther(o Base, v int32) { o.Auto = v }
    func Bump() { Auto += 1 }
    func Read() int32 -> Auto
}

class Derived : Base {
    var log string = ""
    override prop Auto int32 {
        get -> 40
        set { log = log + "set " + value.ToString() + ";" }
    }
    func Log() string -> log
}

func Main() {
    let d = Derived()
    d.WriteImplicit(1)
    d.WriteThis(2)
    Base().WriteOther(d, 3)
    d.Bump()
    Console.WriteLine(d.Log())
    let b = Base()
    b.WriteImplicit(5)
    b.Bump()
    Console.WriteLine(b.Read())
}
`

        private const BaseAccessSource string = `package Issue5630Base
import System

open class Base {
    open prop Auto int32 { get; set; }
    func Store(v int32) { Auto = v }
    func Read() int32 -> Auto
}

class Derived : Base {
    override prop Auto int32 {
        get -> base.Auto + 100
        set { base.Auto = value * 2 }
    }
}

func Main() {
    let d = Derived()
    d.Store(5)
    Console.WriteLine(d.Auto)
    Console.WriteLine(d.Read())
}
`

        private const InterfaceSource string = `package Issue5630Interface
import System

interface IHas {
    prop Tag int32 { get; set; }
}

open class Base : IHas {
    open prop Tag int32 { get; set; }
    func ReadTag() int32 -> Tag
    func WriteTag(v int32) { Tag = v }
}

class Derived : Base {
    override prop Tag int32 {
        get -> 46
        set { Console.WriteLine("Derived.set_Tag " + value.ToString()) }
    }
}

class Plain : IHas {
    prop Tag int32 { get; set; }
    func Store(v int32) int32 {
        Tag = v
        return Tag
    }
}

func Main() {
    let d = Derived()
    d.WriteTag(3)
    let i IHas = d
    Console.WriteLine(d.ReadTag())
    Console.WriteLine(i.Tag)
    let p = Plain()
    let j IHas = p
    Console.WriteLine(p.Store(8))
    Console.WriteLine(j.Tag)
}
`

        private const CtorSource string = `package Issue5630Ctor
import System

open class Base {
    init() {
        Auto = 1
        Init = 3
    }
    open prop Auto int32 { get; set; }
    open prop Init int32 { get; init; }
}

class Derived : Base {
    override prop Auto int32 {
        get -> 42
        set { Console.WriteLine("Derived.set_Auto " + value.ToString()) }
    }
    override prop Init int32 {
        get -> 44
        init { Console.WriteLine("Derived.init_Init " + value.ToString()) }
    }
}

open class Mid : Base {
    override prop Auto int32 { get; set; }
    func ReadMid() int32 -> Auto
}

open class G0 {
    open prop Fixed int32 { get -> 0 }
}

open class G1 : G0 {
    init() {
        Fixed = 2
        Fixed += 10
    }
    override prop Fixed int32 { get; }
    func ReadFixed() int32 -> Fixed
}

class G2 : G1 {
    override prop Fixed int32 { get -> 43 }
    func ReadBaseFixed() int32 -> base.Fixed
}

func Main() {
    let d = Derived()
    Console.WriteLine(d.Auto)
    Console.WriteLine(d.Init)
    Console.WriteLine(Mid().ReadMid())
    let g2 = G2()
    Console.WriteLine(G1().ReadFixed())
    Console.WriteLine(g2.ReadFixed())
    Console.WriteLine(g2.ReadBaseFixed())
}
`

        private const ControlSource string = `package Issue5630Control
import System

open class Base {
    open prop Auto int32 { get; set; }
    prop Plain int32 { get; set; }
    func ReadAuto() int32 -> Auto
    func ReadPlain() int32 -> Plain
    func WritePlain(v int32) { Plain = v }
}

class Final : Base {
    override prop Auto int32 { get; set; }
    func ReadFinal() int32 -> Auto
    func WriteFinal(v int32) { Auto = v }
}

class Closed {
    prop Value int32 { get; set; }
    func ReadValue() int32 -> Value
    func WriteValue(v int32) { Value = v }
}

struct Pt {
    prop X int32 { get; set; }
    func ReadX() int32 -> X
}

func Main() {
    let f = Final()
    f.WriteFinal(4)
    f.WritePlain(6)
    let c = Closed()
    c.WriteValue(8)
    var p = Pt{}
    p.X = 9
    Console.WriteLine(f.ReadFinal())
    Console.WriteLine(f.ReadAuto())
    Console.WriteLine(f.ReadPlain())
    Console.WriteLine(c.ReadValue())
    Console.WriteLine(p.ReadX())
}
`

        private func AssertFieldAccess(
            pe PEReader,
            reader MetadataReader,
            typeName string,
            methodName string,
            fieldOpCode OpCode,
            accessorName string
        ) {
            let body = Body(pe, reader, typeName, methodName)
            Assert.Contains(body, (i IlInstruction) -> i.OpCode == fieldOpCode)
            Assert.DoesNotContain(body, (i IlInstruction) -> CalleeName(reader, i) == accessorName)
        }

        private func Body(pe PEReader, reader MetadataReader, typeName string, methodName string)[]IlInstruction {
            for typeHandle in reader.TypeDefinitions {
                let type = reader.GetTypeDefinition(typeHandle)
                if reader.GetString(type.Name) != typeName {
                    continue
                }
                for methodHandle in type.GetMethods() {
                    let method = reader.GetMethodDefinition(methodHandle)
                    if reader.GetString(method.Name) == methodName {
                        let instructions = IlInstructionReader.Read(
                            pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes()
                        )
                        Assert.NotEmpty(instructions)
                        return instructions
                    }
                }
            }
            throw InvalidOperationException("No method ${typeName}.${methodName} in the emitted assembly.")
        }

        private func CalleeName(reader MetadataReader, instruction IlInstruction) string? {
            if instruction.OpCode != OpCodes.Call && instruction.OpCode != OpCodes.Callvirt {
                return nil
            }
            let handle = MetadataTokens.EntityHandle(instruction.MetadataToken.GetValueOrDefault())
            return if handle.Kind == HandleKind.MethodDefinition {
                reader.GetString(reader.GetMethodDefinition(MethodDefinitionHandle(handle)).Name)
            } else if handle.Kind == HandleKind.MemberReference {
                reader.GetString(reader.GetMemberReference(MemberReferenceHandle(handle)).Name)
            } else {
                nil
            }
        }

        private func Compile(tempDir string, source string) string {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let dllPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, "gsc failed:\n${stdoutWriter}\n${stderrWriter}")
            IlVerifier.Verify(dllPath)
            return dllPath
        }

        private func Run(tempDir string, dllPath string) string {
            let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
            if !File.Exists(rtConfig) {
                File.WriteAllText(
                    rtConfig,
                    "{\"runtimeOptions\":{\"tfm\":\"net10.0\",\"framework\":{\"name\":\"Microsoft.NETCore.App\",\"version\":\"10.0.0\"}}}"
                )
            }
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir
            }
            psi.ArgumentList.Add("exec")
            psi.ArgumentList.Add("--runtimeconfig")
            psi.ArgumentList.Add(rtConfig)
            psi.ArgumentList.Add(dllPath)
            using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(proc.ExitCode == 0, "exited ${proc.ExitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}")
            return stdout.ReplaceLineEndings("\n")
        }
    }
}
