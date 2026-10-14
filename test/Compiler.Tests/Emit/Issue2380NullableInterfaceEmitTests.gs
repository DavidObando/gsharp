// <copyright file="Issue2380NullableInterfaceEmitTests.cs" company="GSharp">
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
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #2380: a G# class property or value-type (struct) method that
/// implicitly implements an IMPORTED CLR interface member using
/// `Nullable<T>` (e.g. `DateTime?`) compiled without
/// diagnostics but was emitted WITHOUT the required `Virtual|NewSlot`
/// metadata, because two emitter-side implicit-interface-match helpers
/// ((cref:GSharp.Core.CodeAnalysis.Emit.MemberDefEmitter.PropertyImplicitlyImplementsInterface)
/// and (cref:GSharp.Core.CodeAnalysis.Emit.MethodInfoHelpers.MethodImplicitlyImplementsInterface))
/// compared the raw (non-effective) CLR type instead of
/// (cref:GSharp.Core.CodeAnalysis.Symbols.NullableLifting.GetEffectiveClrType),
/// which the binder-side matching logic (`MemberLookup.FindMatchingProperty`,
/// `MemberLookup.ClrParamTypeMatchesGenericMethodParam`) already used
/// correctly. This left the class compiling clean while ILVerify (and the CLR
/// loader) reported "Class implements interface but not method" for the
/// omitted virtual slot. This also audits (and, for events, fixes an entirely
/// missing `ImplementedClrInterfaces` branch in)
/// (cref:GSharp.Core.CodeAnalysis.Emit.MemberDefEmitter.EventImplicitlyImplementsInterface),
/// and indexers (which reuse the property code path via
/// `PropertySymbol.IsIndexer`).
///
/// Oahu.Data (round 15 migration) hit this exact shape through an imported
/// `IBookMeta` interface's `DateTime? ReleaseDate` /
/// `DateTime? PurchaseDate` properties.
open class Issue2380NullableInterfaceEmitTests {
    @Fact
    func ClassProperty_NullablePrimitive_ImportedInterface_IsVirtualNewSlotAndIlVerifies() {
        // Exact Oahu.Data shape: an imported interface with a Nullable<T>
        // (value-type) property, implemented via a plain G# auto-property.
        let csSource = `using System;

namespace ProbeRef
{
    public interface IBookMeta
    {
        DateTime? ReleaseDate { get; }
    }
}`
        let gSource = `package Probe
import System
import ProbeRef

class BookMeta : IBookMeta {
    prop ReleaseDate DateTime?
}

var b IBookMeta = BookMeta{ ReleaseDate: DateTime(2020, 1, 1) }
Console.WriteLine(b.ReleaseDate.HasValue)`
        let output = CompileAndRunWithSiblingCs(csSource, gSource, "ProbeRef2380a")
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func ClassProperty_NullablePrimitive_MetadataIsVirtualNewSlot() {
        let csSource = `using System;

namespace ProbeRef
{
    public interface IBookMeta
    {
        DateTime? ReleaseDate { get; }
        DateTime? PurchaseDate { get; }
    }
}`
        let gSource = `package Probe
import System
import ProbeRef

class BookMeta : IBookMeta {
    prop ReleaseDate DateTime?
    prop PurchaseDate DateTime?
}`
        let (dllPath, siblingDll) = CompileLibraryWithSiblingCs(csSource, gSource, "ProbeRef2380b")
        try {
            let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let resolver = PathAssemblyResolver(
                Directory.GetFiles(runtimeDir, "*.dll").Concat([]string{dllPath, siblingDll})
            )
            using let mlc = MetadataLoadContext(resolver, "System.Private.CoreLib")
            let asm = mlc.LoadFromAssemblyPath(dllPath)
            let type = asm.GetType("Probe.BookMeta") ?? throw InvalidOperationException("type not found")
            for propName in[]string{"ReleaseDate", "PurchaseDate"} {
                let getter = type.GetMethod("get_" + propName) ??
                    throw InvalidOperationException("get_$propName not found")
                Assert.True(getter.IsVirtual, "get_$propName must be virtual to implement the interface")
                Assert.True(getter.Attributes.HasFlag(MethodAttributes.NewSlot), "get_$propName must be NewSlot")
            }
        } finally {
            TryCleanup(dllPath)
            TryCleanup(siblingDll)
        }
    }

    @Fact
    func StructMethod_NullablePrimitiveReturn_ImportedInterface_IsVirtualAndIlVerifies() {
        // RequiresVirtualOnValueType path (issue #409): a struct method's
        // virtual promotion depends on MethodImplicitlyImplementsInterface,
        // which had the identical raw-ClrType bug for the return type.
        let csSource = `using System;

namespace ProbeRef
{
    public interface ISizeSource
    {
        long? GetSizeBytes();
    }
}`
        let gSource = `package Probe
import System
import ProbeRef

struct FileMeta : ISizeSource {
    var size int64?

    func GetSizeBytes() int64? {
        return this.size
    }
}

var f ISizeSource = FileMeta{ size: 42 }
Console.WriteLine(f.GetSizeBytes())`
        let output = CompileAndRunWithSiblingCs(csSource, gSource, "ProbeRef2380c")
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func StructMethod_NullablePrimitiveParameter_ImportedInterface_IsVirtualAndIlVerifies() {
        let csSource = `using System;

namespace ProbeRef
{
    public interface IFinder
    {
        bool Matches(Guid? id);
    }
}`
        let gSource = (`package Probe
import System
import ProbeRef

struct RecordFinder : IFinder {
    var target Guid?

    func Matches(id Guid?) bool {
        // Note: ` + "`" + `this.target == id` + "`" + ` (comparing two Nullable<Guid>
        // values directly) hits an unrelated, pre-existing gsc
        // codegen defect (StackUnexpected on Nullable<T> == Nullable<T>
        // for imported struct types with a custom == operator, e.g.
        // Guid/DateTime) that is out of scope for issue #2380. Use
        // the ` + "`" + `!!` + "`" + ` unwrap operator (see NullableValueEmitTests) to
        // exercise only the Virtual/NewSlot promotion this issue
        // targets, guarding both sides for nil first.
        if this.target == nil || id == nil {
            return false
        }
        return this.target!! == id!!
    }
}

var g Guid = Guid.NewGuid()
var f IFinder = RecordFinder{ target: g }
Console.WriteLine(f.Matches(g))
Console.WriteLine(f.Matches(nil))`)
        let output = CompileAndRunWithSiblingCs(csSource, gSource, "ProbeRef2380d")
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func ClassIndexer_NullablePrimitiveReturn_ImportedInterface_IsVirtualAndIlVerifies() {
        // Indexers are PropertySymbol (IsIndexer=true), so they share
        // PropertyImplicitlyImplementsInterface's code path — this exercises
        // it with an index parameter list rather than a plain getter.
        let csSource = `using System;

namespace ProbeRef
{
    public interface ITable
    {
        int? this[int row] { get; }
    }
}`
        let gSource = `package Probe
import System
import ProbeRef

class SparseTable : ITable {
    prop this[row int32] int32? {
        get {
            if row == 1 {
                return 100
            }
            return nil
        }
    }
}

var t ITable = SparseTable{}
Console.WriteLine(t[1])
Console.WriteLine(t[2])`
        let output = CompileAndRunWithSiblingCs(csSource, gSource, "ProbeRef2380e")
        Assert.Equal("100${Environment.NewLine}${Environment.NewLine}", output)
    }

    @Fact
    func ClassEvent_ImportedInterface_IsVirtualNewSlotAndIlVerifies() {
        // Issue #2380 also audits/fixes EventImplicitlyImplementsInterface,
        // which previously had NO ImplementedClrInterfaces branch at all
        // (imported-interface events were never promoted to Virtual|NewSlot,
        // regardless of handler-type shape).
        let csSource = `using System;

namespace ProbeRef
{
    public interface INotifier
    {
        event EventHandler Changed;
    }
}`
        let gSource = (`package Probe
import System
import ProbeRef

class Notifier : INotifier {
    event Changed EventHandler

    func Raise() {
        this.Changed?.Invoke(this, EventArgs.Empty)
    }
}

var n = Notifier{}
// Note: untyped-lambda parameter inference against an imported
// CLR delegate type (EventHandler) on the ` + "`" + `+=` + "`" + ` operator is a
// separate, pre-existing gsc gap (GS0304/GS0155) unrelated to
// issue #2380; use explicit lambda parameter types to isolate
// this test to the Virtual/NewSlot promotion under test.
n.Changed += (sender object, e EventArgs) -> Console.WriteLine("handled")
n.Raise()`)
        let output = CompileAndRunWithSiblingCs(csSource, gSource, "ProbeRef2380f")
        Assert.Equal("handled${Environment.NewLine}", output)
    }

    @Fact
    func ClassEvent_ImportedInterface_MetadataIsVirtualNewSlot() {
        let csSource = `using System;

namespace ProbeRef
{
    public interface INotifier
    {
        event EventHandler Changed;
    }
}`
        let gSource = `package Probe
import System
import ProbeRef

class Notifier : INotifier {
    event Changed EventHandler
}`
        let (dllPath, siblingDll) = CompileLibraryWithSiblingCs(csSource, gSource, "ProbeRef2380g")
        try {
            let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let resolver = PathAssemblyResolver(
                Directory.GetFiles(runtimeDir, "*.dll").Concat([]string{dllPath, siblingDll})
            )
            using let mlc = MetadataLoadContext(resolver, "System.Private.CoreLib")
            let asm = mlc.LoadFromAssemblyPath(dllPath)
            let type = asm.GetType("Probe.Notifier") ?? throw InvalidOperationException("type not found")
            let add = type.GetMethod("add_Changed") ?? throw InvalidOperationException("add_Changed not found")
            Assert.True(add.IsVirtual, "add_Changed must be virtual to implement the interface")
            Assert.True(add.Attributes.HasFlag(MethodAttributes.NewSlot), "add_Changed must be NewSlot")
            let remove = type.GetMethod("remove_Changed") ?? throw InvalidOperationException("remove_Changed not found")
            Assert.True(remove.IsVirtual, "remove_Changed must be virtual to implement the interface")
            Assert.True(remove.Attributes.HasFlag(MethodAttributes.NewSlot), "remove_Changed must be NewSlot")
            let interfaces = type.GetInterfaces().Select((i Type) -> i.FullName!!).ToArray()
            Assert.Contains("ProbeRef.INotifier", interfaces)
        } finally {
            TryCleanup(dllPath)
            TryCleanup(siblingDll)
        }
    }

    @Fact
    func ClassMethod_NullableImportedEnumReturn_ImportedInterface_IsVirtualAndIlVerifies() {
        let csSource = `using System;

namespace ProbeRef
{
    public enum Status { Active, Retired }

    public interface IStatusSource
    {
        Status? GetStatus();
    }
}`
        let gSource = `package Probe
import System
import ProbeRef

class Widget : IStatusSource {
    func GetStatus() Status? {
        return Status.Retired
    }
}

var w IStatusSource = Widget{}
Console.WriteLine(w.GetStatus())`
        let output = CompileAndRunWithSiblingCs(csSource, gSource, "ProbeRef2380h")
        Assert.Equal("Retired${Environment.NewLine}", output)
    }

    @Fact
    func ClassMethod_NullableReturn_GenericClosedImportedInterface_IsVirtualAndIlVerifies() {
        // "Generic interfaces" coverage: a non-symbolic (BCL-argument-closed)
        // generic imported interface — IRepo<Guid> — reaches the SAME
        // `ifaceSym?.ClrType` / raw-return-type comparison branch this issue
        // fixes (as opposed to the #949 symbolic-substitution branch, which
        // only fires when a type argument is itself a G# type and already
        // delegates to the binder's correct GetEffectiveClrType usage).
        let csSource = `using System;

namespace ProbeRef
{
    public interface IRepo<T>
        where T : struct
    {
        T? Find();
    }
}`
        let gSource = `package Probe
import System
import ProbeRef

class GuidRepo : IRepo[Guid] {
    func Find() Guid? {
        return nil
    }
}

var r IRepo[Guid] = GuidRepo{}
Console.WriteLine(r.Find())`
        let output = CompileAndRunWithSiblingCs(csSource, gSource, "ProbeRef2380i")
        Assert.Equal(Environment.NewLine, output)
    }

    @Fact
    func ClassMethod_NullableReturn_SymbolicGenericInterfaceOverSourceEnum_StillIlVerifies() {
        // Regression/consistency guard: a generic imported interface closed
        // over a SAME-COMPILATION G# enum (`IRepo[Color]`) routes through the
        // #949 symbolic-substitution branch
        // (MemberLookup.TryGetSymbolicClrGenericInterface /
        // FindMatchingMethodForSymbolicClrInterface). Before this issue's
        // follow-up fix to `ParameterTypeMatchesSubstituted` (which now
        // unwraps a `Nullable<T>` contract position against a G#
        // `NullableTypeSymbol` candidate), `IRepo<T>.Find()`'s `T?` contract
        // position — a constructed `Nullable<T>` over the interface's OWN
        // generic parameter — was never recognized as satisfied, producing a
        // spurious GS0187 "does not implement interface method" error. This
        // proves the class now compiles (and the emitted virtual slot
        // ILVerifies) with a same-compilation enum in this position.
        //
        // Note: calling `.Find()` through the INTERFACE-typed reference
        // (`r.Find()`) and boxing a same-compilation `Nullable<enum>` for
        // `Console.WriteLine(object)` both hit separate, pre-existing gsc
        // gaps (substituted-return-type computation for symbolic-interface
        // call sites, and Nullable<T>-over-same-compilation-enum boxing,
        // respectively) that are unrelated to #2380's Virtual/NewSlot scope;
        // this test intentionally avoids both by verifying only that the
        // interface upcast compiles and that a direct, non-boxing call on
        // the concrete class produces the expected value.
        let csSource = `using System;

namespace ProbeRef
{
    public interface IRepo<T>
        where T : struct
    {
        T? Find();
    }
}`
        let gSource = `package Probe
import System
import ProbeRef

enum Color { Red, Green, Blue }

class ColorRepo : IRepo[Color] {
    func Find() Color? {
        return Color.Green
    }
}

// Proves ColorRepo is recognized as implementing IRepo[Color]
// (the GS0187 binder-matching bug this fix addresses).
var r IRepo[Color] = ColorRepo{}

var cr = ColorRepo{}
Console.WriteLine(cr.Find() == Color.Green)`
        let output = CompileAndRunWithSiblingCs(csSource, gSource, "ProbeRef2380j")
        Assert.Equal("True${Environment.NewLine}", output)
    }

    shared {
        private func CompileLibraryWithSiblingCs(csSource string, gSource string, siblingName string)(
            DllPath string,
            SiblingDllPath string
        ) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2380_lib_sib_").FullName
            let csDir = Path.Combine(tempDir, "csref")
            Directory.CreateDirectory(csDir)
            File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSource)
            File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <AssemblyName>` + "$siblingName" + `</AssemblyName>
    <RootNamespace>` + "$siblingName" + `</RootNamespace>
  </PropertyGroup>
</Project>`))
            let siblingDll = BuildCsProject(csDir, siblingName)
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, gSource)
            let gscArgs = List[string]{
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                "/reference:" + siblingDll
            }
            for reference in TrustedPlatformAssemblies() {
                gscArgs.Add("/reference:" + reference)
            }
            gscArgs.Add("/nowarn:GS9100")
            gscArgs.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(gscArgs.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath, additionalReferences: []string{siblingDll})
            return (outPath, siblingDll)
        }

        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2380_sib_").FullName
            try {
                let csDir = Path.Combine(tempDir, "csref")
                Directory.CreateDirectory(csDir)
                File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSource)
                File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <AssemblyName>` + "$siblingName" + `</AssemblyName>
    <RootNamespace>` + "$siblingName" + `</RootNamespace>
  </PropertyGroup>
</Project>`))
                let siblingDll = BuildCsProject(csDir, siblingName)
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, gSource)
                let gscArgs = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/reference:" + siblingDll
                }
                for reference in TrustedPlatformAssemblies() {
                    gscArgs.Add("/reference:" + reference)
                }
                gscArgs.Add("/nowarn:GS9100")
                gscArgs.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(gscArgs.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                File.Copy(siblingDll, Path.Combine(tempDir, Path.GetFileName(siblingDll)), overwrite: true)
                IlVerifier.Verify(outPath, additionalReferences: []string{siblingDll})
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
                } catch { }
            }
        }

        private func BuildCsProject(csDir string, siblingName string) string {
            RunDotnet(csDir, "restore")
            RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore")
            let dll = Path.Combine(csDir, "bin", "Release", "net10.0", siblingName + ".dll")
            Assert.True(File.Exists(dll), "sibling assembly not found at $dll")
            return dll
        }

        private func RunDotnet(workingDir string, args ...string) string {
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDir
            }
            for a in args {
                psi.ArgumentList.Add(a)
            }
            using let proc = Process.Start(psi) ??
                throw InvalidOperationException("failed to start dotnet ${string.Join(" ", args)}")
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            Assert.True(proc.WaitForExit(120_000), "dotnet ${args[0]} timed out")
            Assert.True(
                proc.ExitCode == 0,
                (`dotnet ` + "${string.Join(" ", args)}" + ` failed (exit ` + "${proc.ExitCode}" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
            )
            return stdout
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }

        private func TryCleanup(dllPath string) {
            try {
                let dir string? = Path.GetDirectoryName(dllPath)
                if dir != nil && Directory.Exists(dir) {
                    Directory.Delete(dir, recursive: true)
                }
            } catch { }
        }
    }
}
