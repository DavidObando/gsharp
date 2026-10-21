package GSharp.Compiler.Tests.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import Xunit

// Compiler.Tests serializes execution, so these tests can change the working directory.
class Issue5069EmitPreparationTests : IDisposable {
    private let originalDirectory string
    private let outputDirectory string

    init() {
        originalDirectory = Directory.GetCurrentDirectory()
        outputDirectory = Directory.CreateTempSubdirectory("gs_emitpreparation_").FullName
        Directory.SetCurrentDirectory(outputDirectory)
    }

    func Dispose() {
        Directory.SetCurrentDirectory(originalDirectory)
        Directory.Delete(outputDirectory, recursive: true)
    }

    @Fact
    func FileAndStreamEmitPreserveLoweredBytesExecutionAndDocumentationDiagnostics() {
        const Source = `package EmitPreparation
import System
import System.Linq.Expressions
import System.Threading.Tasks

class State {
    var Value int32 = (func() int32 { return 3 })()
    init() { Value += 1 }
}
func Values() sequence[int32] {
    try { yield 2 } finally { let finished = 3 }
}
async func Answer() int32 {
    await Task.Yield()
    return 6
}
/// Runs the prepared program.
/// @param missing No such parameter exists.
func Run() string {
    var parsed = 0
    Int32.TryParse("4", &parsed)
    var captured = 1
    let next = func() int32 {
        captured += 1
        return captured
    }
    let expression Expression[Func[int32, int32]] = (x int32) -> x + captured
    var total = 0
    for value in Values() { total += value }
    let sum = State().Value + parsed + next() + total + Answer().GetAwaiter().GetResult()
    let apply = expression.Compile()
    return "$sum:${apply(2)}"
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source, "preparation.gs"))
        let fileCompilation = Compilation(tree){DebugInformation = DebugInformationOptions{Deterministic: true}}
        let fileResult = fileCompilation.Emit()
        Assert.True(fileResult.Success, string.Join("\n", fileResult.Diagnostics.Select((d Diagnostic) -> d.Message)))
        let fileBytes = File.ReadAllBytes("EmitPreparation.dll")
        Assert.NotEmpty(fileBytes)
        Assert.Contains(fileResult.Diagnostics, (d Diagnostic) -> d.Id == "GS0229")
        let streamCompilation = Compilation(tree){DebugInformation = DebugInformationOptions{Deterministic: true}}
        using let stream = MemoryStream()
        let streamResult = streamCompilation.Emit(stream)
        Assert.True(
            streamResult.Success,
            string.Join("\n", streamResult.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        Assert.Equal(fileBytes, stream.ToArray())
        Assert.Equal(
            fileResult
                .Diagnostics
                .Select((d Diagnostic) -> (d.Id, d.Severity, d.Message, d.Location.FileName, d.Location.Span))
                .ToArray(),
            streamResult
                .Diagnostics
                .Select((d Diagnostic) -> (d.Id, d.Severity, d.Message, d.Location.FileName, d.Location.Span))
                .ToArray()
        )
        let assembly = EmittedFixture.Load(fileBytes)
        let method = assembly.GetType("EmitPreparation.<Program>", throwOnError: true)!!.GetMethod(
            "Run",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )!!
        Assert.Equal("18:4", method.Invoke(nil, nil))
    }

    @Fact
    func FileAndStreamEmitPreserveBindingErrorOrderAndLeaveDestinationsUntouched() {
        const Source = `package EmitPreparation
@SuppressDiagnostic("GS0125")
func First() int32 -> missingFirst
func Second() int32 -> missingSecond
`
        let tree = SyntaxTree.Parse(SourceText.From(Source, "errors.gs"))
        let sentinel = []uint8{1, 2, 3}
        File.WriteAllBytes("EmitPreparation.dll", sentinel)
        let fileResult = Compilation(tree).Emit()
        Assert.False(fileResult.Success)
        Assert.Equal(sentinel, File.ReadAllBytes("EmitPreparation.dll"))
        Assert.Equal([]string{"GS0125", "GS0125"}, fileResult.Diagnostics.Select((d Diagnostic) -> d.Id).ToArray())
        Assert.Equal(
            []int32{
                Source.IndexOf("missingFirst", StringComparison.Ordinal),
                Source.IndexOf("missingSecond", StringComparison.Ordinal)
            },
            fileResult.Diagnostics.Select((d Diagnostic) -> d.Location.Span.Start).ToArray()
        )
        Assert.All(
            fileResult.Diagnostics,
            (d Diagnostic) -> {
                Assert.True(d.IsError)
                Assert.Equal("errors.gs", d.Location.FileName)
            }
        )
        using let stream = MemoryStream()
        stream.Write(sentinel, 0, sentinel.Length)
        let streamResult = Compilation(tree).Emit(stream)
        Assert.False(streamResult.Success)
        Assert.Equal(sentinel, stream.ToArray())
        Assert.Equal(
            fileResult
                .Diagnostics
                .Select((d Diagnostic) -> (d.Id, d.Severity, d.Message, d.Location.FileName, d.Location.Span))
                .ToArray(),
            streamResult
                .Diagnostics
                .Select((d Diagnostic) -> (d.Id, d.Severity, d.Message, d.Location.FileName, d.Location.Span))
                .ToArray()
        )
    }
}
