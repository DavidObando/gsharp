package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import Xunit

class Issue5070ImportedMetadataDriverTests {
    @Fact
    func RealDriver_ReusesImportedDefinitionsAndPreservesOutputAndDiagnostics() {
        let directory = Path.Combine(AppContext.BaseDirectory, "metadata-driver-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        let originalOut = Console.Out
        let originalError = Console.Error
        try {
            let library = Path.Combine(directory, "Contract.dll")
            let contract = CSharpCompilation.Create("Contract", []SyntaxTree{CSharpSyntaxTree.ParseText(`#nullable enable
namespace Contracts {
    public class Box<T> {
        public T Value;
        public Box(T value) { Value = value; }
        public T Echo(T value) => value;
        public string? Maybe(string value) => null;
    }
}`)}, ReferenceResolver
                    .HostTrustedPlatformAssemblyPaths()
                    .Select(
                    (path string) -> MetadataReference.CreateFromFile(path)
                ), CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
            {
                using let stream = File.Create(library)
                let result = contract.Emit(stream)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            let source = Path.Combine(directory, "input.gs")
            let output = Path.Combine(directory, "result.dll")
            File.WriteAllText(source, `package Imported
import Contracts
func Value(box Box[string], value string) string {
    let first = box.Echo(value)
    let second = box.Echo(first)
    let third = box.Echo(second)
    return box.Echo(third)
}`)
            let args = []string{
                "/target:library",
                "/deterministic+",
                "/debug:none",
                "/out:" + output,
                "/reference:" + library,
                source
            }
            using let firstOut = StringWriter()
            using let firstError = StringWriter()
            Console.SetOut(firstOut)
            Console.SetError(firstError)
            {
                using let measurements = CompilationMeasurements.Start("test")
                Assert.Equal(0, Program.Main(args))
                Assert.True(measurements.GetCounter("metadata.definition-scans") > 0)
                Assert.True(
                    measurements.GetCounter("metadata.definition-requests") > measurements.GetCounter(
                        "metadata.definition-scans"
                    ),
                    "repeated imported call sites must reuse their open declaration"
                )
            }
            let firstBytes = File.ReadAllBytes(output)
            Assert.NotEmpty(firstBytes)
            using let nextOut = StringWriter()
            using let nextError = StringWriter()
            Console.SetOut(nextOut)
            Console.SetError(nextError)
            Assert.Equal(0, Program.Main(args))
            Assert.Equal(firstBytes, File.ReadAllBytes(output))
            Assert.Equal(firstOut.ToString(), nextOut.ToString())
            Assert.Equal(firstError.ToString(), nextError.ToString())
            File.WriteAllText(
                source,
                "package Imported\nimport Contracts\nfunc Value(box Box[string]) string -> box.Maybe(\"x\")"
            )
            using let rejectedOut = StringWriter()
            using let rejectedError = StringWriter()
            Console.SetOut(rejectedOut)
            Console.SetError(rejectedError)
            Assert.NotEqual(0, Program.Main(args))
            let rejected = rejectedOut.ToString() + rejectedError.ToString()
            Assert.Contains("GS0155", rejected, StringComparison.Ordinal)
            Assert.Contains("input.gs(3,", rejected, StringComparison.Ordinal)
            rejectedOut.GetStringBuilder().Clear()
            rejectedError.GetStringBuilder().Clear()
            Assert.NotEqual(0, Program.Main(args))
            Assert.Equal(rejected, rejectedOut.ToString() + rejectedError.ToString())
        } finally {
            Console.SetOut(originalOut)
            Console.SetError(originalError)
            Directory.Delete(directory, recursive: true)
        }
    }
}
