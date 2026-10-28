package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Compiler.Tests.LanguageConformance
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

class Issue5481ChannelMemberOwnerDriverTests {
    @Theory
    @InlineData("class")
    @InlineData("struct")
    func SymbolicElement_PreservesDeclaringOwnerAndSingleReceiverEvaluation(kind string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = Path.Combine(fixture.Directory, "Channel.gs")
        let image = Path.Combine(fixture.Directory, "Channel.dll")
        let reference = Path.Combine(fixture.Directory, "Channel.ref.dll")
        let pdb = Path.ChangeExtension(image, ".pdb")
        let producerReference = Path.Combine(fixture.Directory, "OwnerContract.ref.dll")
        let producer = fixture.CompileCSharpWithReference(`#nullable enable
using System;
namespace OwnerContract;
public class Base<TWrite, TRead> {
    public TRead Current { get; set; } = default!;
    public TRead View => Current;
    public TRead Echo(TRead value) { Console.Write("E"); return value; }
}
public class Forward<T> : Base<string, T> { }
`, "OwnerContract", producerReference)
        File.WriteAllText(source, `package ChannelGetter
import System
import System.Threading.Channels
import OwnerContract
public ` + kind + ` C { public var Value int32 }
public func Read(channel chan[C]) object -> channel.Reader
public func Write(channel chan[C]) object -> channel.Writer
func Reader[T](channel chan[T]) in chan[T] -> channel.Reader
func Writer[T](channel chan[T]) out chan[T] -> channel.Writer
func Target(channel chan[C]) chan[C] {
    Console.Write("R")
    return channel
}
func Count(channel in chan[C]) int32 -> channel.Count
func Push(channel out chan[C], value C) bool -> channel.TryWrite(value)
func Named(channel Channel[C]) object -> channel.Reader
func Main() {
    let channel chan[C] = Channel.CreateUnbounded[C]()
    Console.Write(Object.ReferenceEquals(Read(Target(channel)), channel.Reader))
    Console.Write(Object.ReferenceEquals(Write(Target(channel)), channel.Writer))
    Console.Write(Object.ReferenceEquals(Named(channel), channel.Reader))
    Console.Write(Object.ReferenceEquals(Reader[C](channel), channel.Reader))
    Console.Write(Object.ReferenceEquals(Writer[C](channel), channel.Writer))
    let writer = channel.Writer
    let reader = channel.Reader
    Console.Write(Push(writer, C{Value:37}))
    Console.Write(Count(reader))
    Console.Write(reader.TryRead(out var value))
    Console.Write(value.Value)
    let constructed = chan[C](1)
    Console.Write(constructed.Writer.TryWrite(C{Value:19}))
    Console.Write(constructed.Reader.TryRead(out var next))
    Console.Write(next.Value)
    let forwarded = Forward[C]()
    forwarded.Current = C{Value:23}
    Console.Write(forwarded.View.Value)
    Console.Write(forwarded.Echo(C{Value:29}).Value)
}
`)
        let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
        let references = Directory
            .GetFiles(runtimeDirectory, "*.dll")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        Assert.NotEmpty(references)
        let channelRuntime = Path.Combine(
            Path.GetDirectoryName(typeof(Program).Assembly.Location)!!,
            "Gsharp.Runtime.Channels.dll"
        )
        let arguments = List[string]{
            typeof(Program).Assembly.Location,
            source,
            "/target:exe",
            "/targetframework:net10.0",
            "--nullability=platform-types",
            "/deterministic+",
            "/debug:portable",
            "/out:" + image,
            "/refout:" + reference,
            "/r:" + channelRuntime,
            "/r:" + producerReference
        }
        arguments.AddRange(references.Select((path string) -> "/r:" + path))
        let compiled = Run(arguments)
        Assert.True(compiled.Code == 0, Encoding.UTF8.GetString(compiled.Output) + compiled.Error)
        Assert.Empty(compiled.Error)
        let bytes = File.ReadAllBytes(image)
        let referenceBytes = File.ReadAllBytes(reference)
        let pdbBytes = File.ReadAllBytes(pdb)
        Assert.NotEmpty(bytes)
        Assert.NotEmpty(referenceBytes)
        Assert.NotEmpty(pdbBytes)
        let verify = List[string]{"tool", "run", "ilverify", "--", image, "-s", "System.Private.CoreLib"}
        for path in references.Concat([]string{channelRuntime, producer}) {
            verify.Add("-r")
            verify.Add(path)
        }
        let verified = Run(verify)
        Assert.True(verified.Code == 0, Encoding.UTF8.GetString(verified.Output) + verified.Error)
        Assert.Empty(verified.Error)
        let metadata = NormalizedIlDump.Create(image)
        Assert.Contains(
            "System.Threading.Channels.Channel`2<ChannelGetter.C, ChannelGetter.C>::get_Reader() : System.Threading.Channels.ChannelReader`1<!1>",
            metadata,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "System.Threading.Channels.Channel`2<!!0, !!0>::get_Writer() : System.Threading.Channels.ChannelWriter`1<!0>",
            metadata,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("Channel`2<Object, Object>", metadata, StringComparison.Ordinal)
        Assert.Contains(
            "OwnerContract.Base`2<String, ChannelGetter.C>::get_View() : !1",
            metadata,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "OwnerContract.Base`2<String, ChannelGetter.C>::Echo(!1) : !1",
            metadata,
            StringComparison.Ordinal
        )
        File.Copy(channelRuntime, Path.Combine(fixture.Directory, Path.GetFileName(channelRuntime)), overwrite: true)
        let executed = Run([]string{image})
        Assert.Equal(0, executed.Code)
        Assert.Empty(executed.Error)
        Assert.Equal(Encoding.UTF8.GetBytes("RTrueRTrueTrueTrueTrueTrue1True37TrueTrue1923E29"), executed.Output)
        let repeated = Run(arguments)
        Assert.Equal(0, repeated.Code)
        Assert.Equal(compiled.Output, repeated.Output)
        Assert.Equal(compiled.Error, repeated.Error)
        Assert.Equal(bytes, File.ReadAllBytes(image))
        Assert.Equal(referenceBytes, File.ReadAllBytes(reference))
        Assert.Equal(pdbBytes, File.ReadAllBytes(pdb))
    }

    shared {
        private func Run(arguments IEnumerable[string])(Code int32, Output[]uint8, Error string) {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            for argument in arguments {
                start.ArgumentList.Add(argument)
            }
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
            using let output = MemoryStream()
            let read = process.StandardOutput.BaseStream.CopyToAsync(output)
            let error = process.StandardError.ReadToEndAsync()
            var exited bool
            try {
                exited = process.WaitForExit(30_000)
            } finally {
                if !process.HasExited {
                    process.Kill(entireProcessTree: true)
                }
                process.WaitForExit()
                try {
                    read.GetAwaiter().GetResult()
                } finally {
                    error.GetAwaiter().GetResult()
                }
            }
            Assert.True(exited, "Channel member driver exceeded 30 seconds.")
            return (process.ExitCode, output.ToArray(), error.GetAwaiter().GetResult())
        }
    }
}
