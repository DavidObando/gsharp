// <copyright file="Issue4312ReferenceReceiverAccessorOpcodeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Text
import Xunit

/// Issue #4312: an instance accessor on a reference receiver must be a `callvirt`.
/// @remarks <b>Cause.</b> `MethodBodyEmitter` chose the opcode for a user property
/// read, a user property write and a user event add/remove with three different
/// tests, none of them "is the receiver a reference at run time". The property
/// sites asked `is StructSymbol {IsClass: true}` or `is InterfaceSymbol` (a wrapped
/// receiver type such as `T?` answers neither). The event sites asked whether the
/// EVENT was declared `open` or `override`, so a plain event on a class took `call`
/// for every receiver. A `call` performs no null check on the receiver, so the
/// accessor ran with a null `this`, and it binds to the declaring type's
/// implementation instead of dispatching on the run-time type.
///
/// <b>Fix.</b> One helper, `InstanceAccessorOpCode`, is the complement of the
/// predicate `EmitInstanceReceiver` uses to decide whether the receiver is loaded
/// as a managed pointer: a value-type receiver takes `call`, anything else takes
/// `callvirt`. All four sites ask it.
///
/// <b>What stays `call`.</b> Value-type receivers (the receiver is an address), a
/// static accessor, a constructor chain, and a `base.` access, which is lowered to
/// a synthesized forwarder that calls the base implementation non-virtually on
/// `this`.
open class Issue4312ReferenceReceiverAccessorOpcodeTests {
    /// Every shape compiles, verifies, runs, and prints what the runtime saw.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func EveryReceiverShape_VerifiesAndBehaves(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4312_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, Array.Empty[string]())
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal(expectedLines, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The emitter invariant the issue asks for: no `call` opcode targets an
    /// instance method of a reference type unless it is a constructor or a
    /// `this`-rooted base call inside the type's own hierarchy.
    /// @remarks The scan decodes opcode by opcode through `IlInstructionReader`.
    /// It must also have SEEN reference-receiver `callvirt` calls and at least one
    /// legitimate non-virtual base call, so an invariant that matched nothing could
    /// not pass.
    @Fact
    func NoCallOpcodeTargetsAnInstanceMethodOfAReferenceTypeFromOutsideItsHierarchy() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4312_inv_").FullName
        try {
            let appPath = Path.Combine(tempDir, "Invariant.dll")
            let appLog = Compile(tempDir, "App.gs", FullSource, appPath, "/target:exe")
            Assert.True(File.Exists(appPath), (`the invariant program must compile. Log:
` + "$appLog"))
            let violations = List[string]()
            var virtualCalls = 0
            var baseCalls = 0
            using let stream = File.OpenRead(appPath)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            for methodHandle in reader.MethodDefinitions {
                let method = reader.GetMethodDefinition(methodHandle)
                if method.RelativeVirtualAddress == 0 {
                    continue
                }
                let il = pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes()
                let enclosingType = method.GetDeclaringType()
                let enclosingIsInstance = (method.Attributes & System.Reflection.MethodAttributes.Static) == 0
                for instruction in IlInstructionReader.Read(il) {
                    if instruction.MetadataToken == nil {
                        continue
                    }
                    let isCall = instruction.OpCode == OpCodes.Call
                    let isCallvirt = instruction.OpCode == OpCodes.Callvirt
                    if !isCall && !isCallvirt {
                        continue
                    }
                    let target = DescribeTarget(
                        reader,
                        MetadataTokens.EntityHandle(instruction.MetadataToken.GetValueOrDefault())
                    )
                    if !target.IsInstance || !target.IsReference || target.Name == ".ctor" {
                        continue
                    }
                    if isCallvirt {
                        virtualCalls++
                        continue
                    }
                    if enclosingIsInstance &&
                        !target
                        .Owner
                        .IsNil &&
                        IsSameOrAncestor(reader, target.Owner, enclosingType) {
                        baseCalls++
                        continue
                    }
                    violations.Add(reader.GetString(method.Name) + " calls " + target.Name)
                }
            }
            Assert.Empty(violations)
            Assert.True(virtualCalls > 10, "the scan saw only $virtualCalls reference-receiver callvirt calls")
            Assert.True(baseCalls > 0, "the scan saw no this-rooted base call, so the exemption is untested")
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const RunTimeout int32 = 60_000

        private const Declarations string = `package Demo
import System
import System.Collections.Generic

open class Base {
    open prop Name string { get { return "base" } }
    open prop Auto string { get; set; }
    event Plain EventHandler { add { Console.WriteLine("plain add ran") } remove { } }
    open event Virt EventHandler { add { Console.WriteLine("base virt add") } remove { } }
}
class Derived : Base {
    override prop Name string { get { return "derived:" + base.Name } }
    override prop Auto string { get { return "d" } set { Console.WriteLine("derived set " + value) } }
    override event Virt EventHandler { add { Console.WriteLine("derived virt add") } remove { } }
}
class Gen[T] {
    event Plain EventHandler { add { Console.WriteLine("gen add ran") } remove { } }
    prop Item string { get { return "gen" } set { Console.WriteLine("gen set") } }
}
interface IHaving {
    prop Tag string { get; set; }
}
class Impl : IHaving {
    var tag string = "t"
    prop Tag string { get { return tag } set { tag = value } }
}
struct Pt {
    var x int32
    prop X int32 { get { return x } set { x = value } }
}

func viaTypeParam[T Base](t T) string {
    t.Auto = "tp"
    return t.Name
}

func probe(name string, f func()) {
    try {
        f()
        Console.WriteLine(name + ": no exception")
    } catch (NullReferenceException) {
        Console.WriteLine(name + ": NRE")
    }
}

`

        /// The receiver is a null reference that arrived from a CLR call: the
        /// accessor itself must not run.
        private const NullBody string = `func nullMain() {
    let handler = (s object?, e EventArgs) -> Console.WriteLine("evt")
    let d = Dictionary[string, Base]()
    let g = Dictionary[string, Gen[int32]]()
    let i = Dictionary[string, IHaving]()
    probe("null-event", () -> { d.GetValueOrDefault("k").Plain += handler })
    probe("null-event-generic", () -> { g.GetValueOrDefault("k").Plain += handler })
    probe("null-virt-event", () -> { d.GetValueOrDefault("k").Virt += handler })
    probe("null-prop-get", () -> { Console.WriteLine(d.GetValueOrDefault("k").Name) })
    probe("null-prop-set", () -> { d.GetValueOrDefault("k").Auto = "x" })
    probe("null-generic-prop-set", () -> { g.GetValueOrDefault("k").Item = "x" })
    probe("null-interface-prop-get", () -> { Console.WriteLine(i.GetValueOrDefault("k").Tag) })
}
`

        /// Live receivers of every form: class, generic class, interface,
        /// type-parameter, value type (local, array element), narrowed nullable,
        /// and a `base.` access.
        private const LiveBody string = `func liveMain() {
    let handler = (s object?, e EventArgs) -> Console.WriteLine("evt")
    let d = Dictionary[string, Base]()
    let g = Dictionary[string, Gen[int32]]()
    let i = Dictionary[string, IHaving]()
    d["a"] = Derived()
    g["a"] = Gen[int32]()
    i["a"] = Impl()
    d["a"].Plain += handler
    d["a"].Virt += handler
    g["a"].Plain += handler
    Console.WriteLine(d["a"].Name)
    d["a"].Auto = "x"
    g["a"].Item = "y"
    i["a"].Tag = "z"
    Console.WriteLine(i["a"].Tag)
    Console.WriteLine(viaTypeParam[Derived](Derived()))
    var p = Pt{}
    p.X = 5
    Console.WriteLine(p.X)
    var arr = []Pt{Pt{}}
    arr[0].X = 7
    Console.WriteLine(arr[0].X)
    let n Base? = Derived()
    if n != nil {
        Console.WriteLine(n.Name)
        n.Auto = "narrowed"
    }
}
`

        private const NullSource string = Declarations + NullBody + "nullMain()\n"

        private const LiveSource string = Declarations + LiveBody + "liveMain()\n"

        private const FullSource string = Declarations + NullBody + LiveBody + "nullMain()\nliveMain()\n"

        func Cases() sequence[[]object] {
            yield[]object{
                "a-null-receiver-fails-at-the-accessor-call",
                NullSource,
                []string{
                    "null-event: NRE",
                    "null-event-generic: NRE",
                    "null-virt-event: NRE",
                    "null-prop-get: NRE",
                    "null-prop-set: NRE",
                    "null-generic-prop-set: NRE",
                    "null-interface-prop-get: NRE"
                }
            }
            yield[]object{
                "a-live-receiver-keeps-its-dispatch-and-its-base-calls",
                LiveSource,
                []string{
                    "plain add ran",
                    "derived virt add",
                    "gen add ran",
                    "derived:base",
                    "derived set x",
                    "gen set",
                    "z",
                    "derived set tp",
                    "derived:base",
                    "5",
                    "7",
                    "derived:base",
                    "derived set narrowed"
                }
            }
        }

        /// Describes a call target.
        /// @param reader The metadata reader.
        /// @param target The call's method token.
        /// @returns Whether it takes `this`, its name, its declaring TypeDef (nil
        /// when the owner is not a TypeDef), and whether the owner is known to be a
        /// reference type.
        private func DescribeTarget(reader MetadataReader, target EntityHandle)(
            IsInstance bool,
            Name string,
            Owner TypeDefinitionHandle,
            IsReference bool
        ) {
            var handle = target
            if handle.Kind == HandleKind.MethodSpecification {
                handle = reader.GetMethodSpecification(MethodSpecificationHandle(handle)).Method
            }
            if handle.Kind == HandleKind.MethodDefinition {
                let def = reader.GetMethodDefinition(MethodDefinitionHandle(handle))
                let owner = def.GetDeclaringType()
                let hasThis = (reader.GetBlobReader(def.Signature).ReadByte() & uint8(0x20)) != 0
                return (hasThis, reader.GetString(def.Name), owner, !IsValueTypeDef(reader, owner))
            }
            if handle.Kind == HandleKind.MemberReference {
                let member = reader.GetMemberReference(MemberReferenceHandle(handle))
                let hasThis = (reader.GetBlobReader(member.Signature).ReadByte() & uint8(0x20)) != 0
                let name = reader.GetString(member.Name)
                if member.Parent.Kind == HandleKind.TypeDefinition {
                    let owner = TypeDefinitionHandle(member.Parent)
                    return (hasThis, name, owner, !IsValueTypeDef(reader, owner))
                }
                if member.Parent.Kind == HandleKind.TypeSpecification {
                    var blob = reader.GetBlobReader(
                        reader.GetTypeSpecification(TypeSpecificationHandle(member.Parent)).Signature
                    )
                    if blob.ReadByte() == uint8(0x15) {
                        let kind = blob.ReadByte()
                        let genericOwner = blob.ReadTypeHandle()
                        var owner TypeDefinitionHandle = default(TypeDefinitionHandle)
                        if genericOwner.Kind == HandleKind.TypeDefinition {
                            owner = TypeDefinitionHandle(genericOwner)
                        }
                        return (hasThis, name, owner, kind == uint8(0x12))
                    }
                }
                // A TypeRef owner is not resolvable from metadata alone.
                return (hasThis, name, default(TypeDefinitionHandle), false)
            }
            return (false, "", default(TypeDefinitionHandle), false)
        }

        private func IsValueTypeDef(reader MetadataReader, type TypeDefinitionHandle) bool {
            let baseType = reader.GetTypeDefinition(type).BaseType
            if baseType.Kind != HandleKind.TypeReference {
                return false
            }
            let name = reader.GetString(reader.GetTypeReference(TypeReferenceHandle(baseType)).Name)
            return name == "ValueType" || name == "Enum"
        }

        private func IsSameOrAncestor(
            reader MetadataReader,
            ancestor TypeDefinitionHandle,
            type TypeDefinitionHandle
        ) bool {
            var current = type
            while !current.IsNil {
                if current == ancestor {
                    return true
                }
                let baseType = reader.GetTypeDefinition(current).BaseType
                if baseType.Kind == HandleKind.TypeDefinition {
                    current = TypeDefinitionHandle(baseType)
                } else if baseType.Kind == HandleKind.TypeSpecification {
                    var blob = reader.GetBlobReader(
                        reader.GetTypeSpecification(TypeSpecificationHandle(baseType)).Signature
                    )
                    blob.ReadByte()
                    blob.ReadByte()
                    let inner = blob.ReadTypeHandle()
                    if inner.Kind != HandleKind.TypeDefinition {
                        return false
                    }
                    current = TypeDefinitionHandle(inner)
                } else {
                    return false
                }
            }
            return false
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
