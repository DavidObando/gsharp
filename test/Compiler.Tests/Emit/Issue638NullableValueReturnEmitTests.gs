// <copyright file="Issue638NullableValueReturnEmitTests.cs" company="GSharp">
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
import Xunit

/// Issue #638: a G# class implementing a CLR interface method that returns
/// `Nullable<T>` for a value-type `T` was rejected with
/// GS0187 because the interface-satisfaction check compared the G# binder's
/// `NullableTypeSymbol.ClrType` (the underlying `T`) against the
/// interface's `Nullable<T>` without lifting through
/// `NullableLifting.GetEffectiveClrType`.
open class Issue638NullableValueReturnEmitTests {
    @Fact
    func NullableIntReturn_SingleMethodInterface_ReturnsNilAndRealValue() {
        let sibling = `namespace Probe.CSharp
{
    public interface IMaybeInt
    {
        int? Try(bool give);
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class MaybeIntImpl : IMaybeInt {
    func Try(give bool) int32? {
        if give {
            return 42
        }
        return nil
    }
}

var m IMaybeInt = MaybeIntImpl{}
var v = m.Try(true)
Console.WriteLine(v)
var n = m.Try(false)
Console.WriteLine(n == nil)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("42${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func NullableBoolReturn_Interface() {
        let sibling = `namespace Probe.CSharp
{
    public interface IMaybeBool
    {
        bool? Check();
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class MaybeBoolImpl : IMaybeBool {
    func Check() bool? {
        return true
    }
}

var m IMaybeBool = MaybeBoolImpl{}
Console.WriteLine(m.Check())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func NullableDoubleReturn_Interface() {
        let sibling = `namespace Probe.CSharp
{
    public interface IMaybeDouble
    {
        double? Compute();
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class MaybeDoubleImpl : IMaybeDouble {
    func Compute() float64? {
        return 3.14
    }
}

var m IMaybeDouble = MaybeDoubleImpl{}
Console.WriteLine(m.Compute())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("3.14${Environment.NewLine}", output)
    }

    @Fact
    func NullableLongReturn_Interface_ReturnsNilAndRealValue() {
        let sibling = `namespace Probe.CSharp
{
    public interface IMaybeLong
    {
        long? Big();
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class MaybeLongImplNil : IMaybeLong {
    func Big() int64? {
        return nil
    }
}

class MaybeLongImplValue : IMaybeLong {
    func Big() int64? {
        return 42
    }
}

var n IMaybeLong = MaybeLongImplNil{}
Console.WriteLine(n.Big() == nil)
var v IMaybeLong = MaybeLongImplValue{}
Console.WriteLine(v.Big())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("True${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func NullableCharReturn_Interface() {
        let sibling = `namespace Probe.CSharp
{
    public interface IMaybeChar
    {
        char? Letter();
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class MaybeCharImpl : IMaybeChar {
    func Letter() char? {
        return 'A'
    }
}

var m IMaybeChar = MaybeCharImpl{}
Console.WriteLine(m.Letter())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("A${Environment.NewLine}", output)
    }

    @Fact
    func NullableDateTimeReturn_CustomStruct() {
        let sibling = `namespace Probe.CSharp
{
    public interface IMaybeDateTime
    {
        System.DateTime? When();
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class MaybeDateTimeImpl : IMaybeDateTime {
    func When() DateTime? {
        return nil
    }
}

var m IMaybeDateTime = MaybeDateTimeImpl{}
Console.WriteLine(m.When() == nil)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func NullableIntProperty_Interface() {
        let sibling = `namespace Probe.CSharp
{
    public interface IHasNullableIntProp
    {
        int? Value { get; }
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class HasNullableIntProp : IHasNullableIntProp {
    prop Value int32? { get { return 7 } }
}

var p IHasNullableIntProp = HasNullableIntProp{}
Console.WriteLine(p.Value)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func MethodWithMultipleParams_AndNullableReturn() {
        let sibling = `namespace Probe.CSharp
{
    public interface IAdder
    {
        int? Sum(int a, int b);
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class Adder : IAdder {
    func Sum(a int32, b int32) int32? {
        return a + b
    }
}

var adder IAdder = Adder{}
Console.WriteLine(adder.Sum(3, 4))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func NullableParamAndNullableReturn() {
        let sibling = `namespace Probe.CSharp
{
    public interface IEcho
    {
        int? Echo(int? input);
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class Echoer : IEcho {
    func Echo(input int32?) int32? {
        return input
    }
}

var e IEcho = Echoer{}
Console.WriteLine(e.Echo(99))
Console.WriteLine(e.Echo(nil) == nil)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("99${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func MultipleMethodsMixedReturnShapes() {
        let sibling = `namespace Probe.CSharp
{
    public interface IMixed
    {
        int? NullableInt();
        string PlainString();
        bool? NullableBool();
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class Mixed : IMixed {
    func NullableInt() int32? { return 10 }
    func PlainString() string { return "hi" }
    func NullableBool() bool? { return nil }
}

var m IMixed = Mixed{}
Console.WriteLine(m.NullableInt())
Console.WriteLine(m.PlainString())
Console.WriteLine(m.NullableBool() == nil)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("10${Environment.NewLine}hi${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func NullableStringReturn_ReferenceNullable_Regression() {
        let sibling = `namespace Probe.CSharp
{
    public interface IMaybeString
    {
        string? Try();
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class MaybeStringImpl : IMaybeString {
    func Try() string? {
        return nil
    }
}

var m IMaybeString = MaybeStringImpl{}
Console.WriteLine(m.Try() == nil)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func InheritedInterface_NullableReturn() {
        let sibling = `namespace Probe.CSharp
{
    public interface IBase
    {
        int? GetId();
    }
    public interface IDerived : IBase
    {
        string Name { get; }
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class Impl : IDerived {
    func GetId() int32? { return 123 }
    prop Name string { get { return "test" } }
}

var d IDerived = Impl{}
Console.WriteLine(d.GetId())
Console.WriteLine(d.Name)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("123${Environment.NewLine}test${Environment.NewLine}", output)
    }

    @Fact
    func ConsoleKeyInfoNullableReturn_FromIssue() {
        let sibling = `namespace Probe.CSharp
{
    public interface IKeyReader
    {
        System.ConsoleKeyInfo? ReadKey();
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class KeyReader : IKeyReader {
    func ReadKey() ConsoleKeyInfo? {
        return nil
    }
}

var k IKeyReader = KeyReader{}
Console.WriteLine(k.ReadKey() == nil)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func NullableLongReturn_ComputedValue() {
        let sibling = `namespace Probe.CSharp
{
    public interface ILongAdder
    {
        long? Add(long a, long b);
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class LongAdder : ILongAdder {
    func Add(a int64, b int64) int64? {
        return a + b
    }
}

var adder ILongAdder = LongAdder{}
Console.WriteLine(adder.Add(1000000000, 2000000000))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("3000000000${Environment.NewLine}", output)
    }

    @Fact
    func NullableULongReturn_Interface() {
        let sibling = `namespace Probe.CSharp
{
    public interface IMaybeULong
    {
        ulong? Value();
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class MaybeULongImpl : IMaybeULong {
    func Value() uint64? {
        return uint64(1024)
    }
}

var m IMaybeULong = MaybeULongImpl{}
var v = m.Value()
Console.WriteLine(v)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("1024${Environment.NewLine}", output)
    }

    @Fact
    func NullableLongParam_Interface() {
        let sibling = `namespace Probe.CSharp
{
    public interface ILongEcho
    {
        long? Echo(long? input);
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class LongEchoer : ILongEcho {
    func Echo(input int64?) int64? {
        return input
    }
}

var e ILongEcho = LongEchoer{}
var v = e.Echo(int64(99))
Console.WriteLine(v)
Console.WriteLine(e.Echo(nil) == nil)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("99${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func NullableLongProperty_Interface() {
        let sibling = `namespace Probe.CSharp
{
    public interface IHasNullableLongProp
    {
        long? Value { get; }
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class HasNullableLongProp : IHasNullableLongProp {
    prop Value int64? { get { return 42 } }
}

var p IHasNullableLongProp = HasNullableLongProp{}
var v = p.Value
Console.WriteLine(v)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func NullableDoubleReturn_NonNilRoundTrip() {
        let sibling = `namespace Probe.CSharp
{
    public interface IDoubleRoundTrip
    {
        double? Echo(double? input);
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class DoubleRoundTrip : IDoubleRoundTrip {
    func Echo(input float64?) float64? {
        return input
    }
}

var d IDoubleRoundTrip = DoubleRoundTrip{}
var v = d.Echo(2.718)
Console.WriteLine(v)
Console.WriteLine(d.Echo(nil) == nil)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource)
        Assert.Equal("2.718${Environment.NewLine}True${Environment.NewLine}", output)
    }

    shared {
        // ----- helpers -----
        private func CompileAndRunWithSiblingCs(
            csSource string,
            gSource string,
            siblingName string = "Probe.CSharp"
        ) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue638_").FullName
            try {
                // Step 1: compile the sibling C# library.
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
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`))
                let siblingDll = BuildCsProject(csDir, siblingName)
                // Step 2: compile the G# code referencing the sibling.
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

        private func RunDotnet(workingDir string, args ...string) {
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
    }
}
