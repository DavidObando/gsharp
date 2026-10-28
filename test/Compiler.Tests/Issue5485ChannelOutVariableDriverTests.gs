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

class Issue5485ChannelOutVariableDriverTests {
    @Theory
    @InlineData("class C { var Value int32 }", "C")
    @InlineData("struct C { var Value int32 }", "C")
    @InlineData("class C[T] { var Value T }", "C[int32]")
    func ReturnedReader_InferredOutVariableRetainsSourceElement(declaration string, element string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = Path.Combine(fixture.Directory, "Reader.gs")
        let image = Path.Combine(fixture.Directory, "Reader.dll")
        let reference = Path.Combine(fixture.Directory, "Reader.ref.dll")
        let pdb = Path.ChangeExtension(image, ".pdb")
        File.WriteAllText(source, `package ChannelOut
import System
import System.Threading.Channels
` + declaration + `
func Reader[T](channel chan[T]) in chan[T] {
    Console.Write("R")
    return channel.Reader
}
func Take[T](reader in chan[T]) T {
    Console.Write("T")
    if reader.TryRead(out var value) {
        return value
    }
    throw InvalidOperationException("Empty channel")
}
func Read[T](reader in chan[T]) T {
    Console.Write("A")
    return reader.ReadAsync().AsTask().GetAwaiter().GetResult()
}
func Main() {
    let channel chan[` + element + `] = Channel.CreateUnbounded[` + element + `]()
    Console.Write(channel.Writer.TryWrite(` + element + `{Value:37}))
    let direct = channel.Reader
    if direct.TryRead(out var control) {
        Console.Write(control.Value)
    } else {
        throw InvalidOperationException("Direct read failed")
    }
    Console.Write(channel.Writer.TryWrite(` + element + `{Value:19}))
    let reader = Reader[` + element + `](channel)
    if reader.TryRead(out var value) {
        Console.Write(value.Value)
    } else {
        throw InvalidOperationException("Returned read failed")
    }
    Console.Write(channel.Writer.TryWrite(` + element + `{Value:23}))
    Console.Write(Take[` + element + `](Reader[` + element + `](channel)).Value)
    Console.Write(channel.Writer.TryWrite(` + element + `{Value:29}))
    Console.Write(Read[` + element + `](Reader[` + element + `](channel)).Value)
}
`)
        let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
        let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
            .Split(Path.PathSeparator)
            .Where((path string) -> Path.GetDirectoryName(path) == runtimeDirectory)
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        Assert.NotEmpty(references)
        let arguments = List[string]{
            typeof(Program).Assembly.Location,
            source,
            "/target:exe",
            "/targetframework:net10.0",
            "--nullability=platform-types",
            "/deterministic+",
            "/debug:portable",
            "/out:" + image,
            "/refout:" + reference
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
        for path in references {
            verify.Add("-r")
            verify.Add(path)
        }
        let verified = Run(verify)
        Assert.True(verified.Code == 0, Encoding.UTF8.GetString(verified.Output) + verified.Error)
        Assert.Empty(verified.Error)
        let metadata = NormalizedIlDump.Create(image)
        Assert.Contains(
            "System.Threading.Channels.ChannelReader`1<!!0>::TryRead(!0&) : Boolean",
            metadata,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("ChannelReader`1<Object>", metadata, StringComparison.Ordinal)
        let executed = Run([]string{image})
        Assert.Equal(0, executed.Code)
        Assert.Empty(executed.Error)
        Assert.Equal(Encoding.UTF8.GetBytes("True37TrueR19TrueRT23TrueRA29"), executed.Output)
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
            Assert.True(exited, "Channel out-variable driver exceeded 30 seconds.")
            return (process.ExitCode, output.ToArray(), error.GetAwaiter().GetResult())
        }
    }
}
