// <copyright file="Issue2889LambdaThunkNestedGenericTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2889 — qualified imported generic types discarded symbolic nested
/// arguments before lambda target typing, so synthesized thunk signatures used
/// erased `List<object>` instead of `List<Src>`.
open class Issue2889LambdaThunkNestedGenericTests {
    @Fact
    func ImportedClrDelegates_PreserveNestedSourceShapes_VerifyAndRun() {
        const source = `package i2889imported
import System
import System.Collections.Generic
import System.Threading.Tasks

class Src {
    let N int32
    init(n int32) { N = n }
}

struct Pt { var X int32 }

enum Mode { First, Second }

interface IValue {
    func Value() int32;
}

class SourceValue : IValue {
    let N int32
    init(n int32) { N = n }
    func Value() int32 -> N
}

class MyBox[T any] {
    let Value T
    init(value T) { Value = value }
}

class Holder {
    let Field System.Action[List[Src]]
    prop Property System.Action[List[Src]] { get; init; }

    init() {
        Field = (items List[Src]) -> Console.WriteLine(items[0].N)
        Property = (items) -> Console.WriteLine(items[0].N + 1)
    }

    func Run(items List[Src]) {
        Field(items)
        Property(items)
    }
}

func PrintMethod(items List[Src]) {
    Console.WriteLine(items[0].N)
}

func MakePrinter() System.Action[List[Src]] {
    return (items List[Src]) -> Console.WriteLine(items[0].N)
}

func InvokePrinter(
    printer System.Action[List[Src]],
    items List[Src]) {
    printer(items)
}

func Main() {
    let classItems = List[Src]{ Src(10) }
    let classAction System.Action[List[Src]] =
        (items List[Src]) -> Console.WriteLine(items[0].N)
    classAction(classItems)

    var optional System.Action[List[Src]]? = classAction
    if optional != nil {
        optional(classItems)
    }

    var point Pt
    point.X = 12
    let pointAction System.Action[List[Pt]] =
        (items List[Pt]) -> Console.WriteLine(items[0].X)
    pointAction(List[Pt]{ point })

    let make System.Func[List[Src]] = () -> List[Src]{ Src(13) }
    Console.WriteLine(make()[0].N)

    let pair System.Action[List[Src], Dictionary[string, Src]] =
        (items List[Src], byName Dictionary[string, Src]) ->
            Console.WriteLine(items[0].N + byName["x"].N)
    let byName = Dictionary[string, Src]()
    byName.Add("x", Src(7))
    pair(List[Src]{ Src(7) }, byName)

    let deep System.Action[List[List[Src]]] =
        (items List[List[Src]]) -> Console.WriteLine(items[0][0].N)
    deep(List[List[Src]]{ List[Src]{ Src(15) } })

    let generic System.Action[List[MyBox[int32]]] =
        (items List[MyBox[int32]]) -> Console.WriteLine(items[0].Value)
    generic(List[MyBox[int32]]{ MyBox[int32](16) })

    let arrayAction System.Action[[]Src] =
        (items []Src) -> Console.WriteLine(items[0].N)
    arrayAction([]Src{ Src(17) })

    let nullableAction System.Action[List[Src?]] =
        (items List[Src?]) -> Console.WriteLine(items[1]!!.N)
    nullableAction(List[Src?]{ nil, Src(18) })

    let methodGroup System.Action[List[Src]] = PrintMethod
    methodGroup(List[Src]{ Src(19) })

    let inferred System.Action[List[Src]] =
        (items) -> Console.WriteLine(items[0].N)
    inferred(List[Src]{ Src(20) })

    Holder().Run(List[Src]{ Src(21) })

    let identity System.Func[List[Src], List[Src]] =
        (items List[Src]) -> items
    Console.WriteLine(identity(List[Src]{ Src(23) })[0].N)

    let offset = 1
    let captured System.Action[List[Src]] =
        (items List[Src]) -> Console.WriteLine(items[0].N + offset)
    captured(List[Src]{ Src(23) })

    MakePrinter()(List[Src]{ Src(25) })

    InvokePrinter(
        (items List[Src]) -> Console.WriteLine(items[0].N),
        List[Src]{ Src(26) })

    let enumAction System.Action[List[Mode]] =
        (items List[Mode]) -> Console.WriteLine(items.Count + 26)
    enumAction(List[Mode]{ Mode.Second })

    let interfaceAction System.Action[List[IValue]] =
        (items List[IValue]) -> Console.WriteLine(items[0].Value())
    interfaceAction(List[IValue]{ SourceValue(28) })

    let dictionaryAction System.Action[Dictionary[Src, List[Src]]] =
        (items Dictionary[Src, List[Src]]) ->
            Console.WriteLine(items.Count + 28)
    let bySource = Dictionary[Src, List[Src]]()
    bySource.Add(Src(1), List[Src]{ Src(1) })
    dictionaryAction(bySource)

    let listArrayAction System.Action[[]List[Src]] =
        (items []List[Src]) -> Console.WriteLine(items[0][0].N)
    listArrayAction([]List[Src]{ List[Src]{ Src(30) } })

    let taskFactory System.Func[Task[List[Src]]] =
        () -> Task.FromResult[List[Src]](List[Src]{ Src(31) })
    Console.WriteLine(taskFactory().Result[0].N)

    let taskAction System.Action[Task[List[Src]]] =
        (items Task[List[Src]]) -> Console.WriteLine(items.Result[0].N)
    taskAction(Task.FromResult[List[Src]](List[Src]{ Src(32) }))
}`
        Assert.Equal(
            "10${Environment.NewLine}10${Environment.NewLine}12${Environment.NewLine}13${Environment.NewLine}14${Environment.NewLine}15${Environment.NewLine}16${Environment.NewLine}17${Environment.NewLine}18${Environment.NewLine}19${Environment.NewLine}20${Environment.NewLine}21${Environment.NewLine}22${Environment.NewLine}" +
                "23${Environment.NewLine}24${Environment.NewLine}25${Environment.NewLine}26${Environment.NewLine}27${Environment.NewLine}28${Environment.NewLine}29${Environment.NewLine}30${Environment.NewLine}31${Environment.NewLine}32${Environment.NewLine}",
            CompileAndRun(source, expectedSourceTypeName: "i2889imported.Src", expectClosure: true)
        )
    }

    @Fact
    func ImportedNamedDelegates_PreserveNestedSourceShapes_VerifyAndRun() {
        const library = `package i2889contracts

delegate ImportedSink[T any](value T) void;
delegate ImportedPair[T any, U any](first T, second U) void;
delegate ImportedFactory[T any]() T;`
        const consumer = `package i2889nameduse
import System
import System.Collections.Generic
import i2889contracts

class Src {
    let N int32
    init(n int32) { N = n }
}

struct Pt { var X int32 }

class MyBox[T any] {
    let Value T
    init(value T) { Value = value }
}

func Print(items List[Src]) { Console.WriteLine(items[0].N) }

func Main() {
    let classSink i2889contracts.ImportedSink[List[Src]] =
        (items List[Src]) -> Console.WriteLine(items[0].N)
    classSink(List[Src]{ Src(70) })

    var point Pt
    point.X = 71
    let structSink i2889contracts.ImportedSink[List[Pt]] =
        (items List[Pt]) -> Console.WriteLine(items[0].X)
    structSink(List[Pt]{ point })

    let factory i2889contracts.ImportedFactory[List[Src]] =
        () -> List[Src]{ Src(72) }
    Console.WriteLine(factory()[0].N)

    let pair i2889contracts.ImportedPair[List[Src], Dictionary[string, Src]] =
        (items List[Src], byName Dictionary[string, Src]) ->
            Console.WriteLine(items[0].N + byName["x"].N)
    let byName = Dictionary[string, Src]()
    byName.Add("x", Src(36))
    pair(List[Src]{ Src(37) }, byName)

    let deep i2889contracts.ImportedSink[List[List[Src]]] =
        (items List[List[Src]]) -> Console.WriteLine(items[0][0].N)
    deep(List[List[Src]]{ List[Src]{ Src(74) } })

    let generic i2889contracts.ImportedSink[List[MyBox[int32]]] =
        (items List[MyBox[int32]]) -> Console.WriteLine(items[0].Value)
    generic(List[MyBox[int32]]{ MyBox[int32](75) })

    let arraySink i2889contracts.ImportedSink[[]Src] =
        (items []Src) -> Console.WriteLine(items[0].N)
    arraySink([]Src{ Src(76) })

    let nullableSink i2889contracts.ImportedSink[List[Src?]] =
        (items List[Src?]) -> Console.WriteLine(items[1]!!.N)
    nullableSink(List[Src?]{ nil, Src(77) })

    let group i2889contracts.ImportedSink[List[Src]] = Print
    group(List[Src]{ Src(78) })

    let inferred i2889contracts.ImportedSink[List[Src]] =
        (items) -> Console.WriteLine(items[0].N)
    inferred(List[Src]{ Src(79) })
}`
        Assert.Equal(
            "70${Environment.NewLine}71${Environment.NewLine}72${Environment.NewLine}73${Environment.NewLine}74${Environment.NewLine}75${Environment.NewLine}76${Environment.NewLine}77${Environment.NewLine}78${Environment.NewLine}79${Environment.NewLine}",
            CompileAndRun(
                consumer,
                expectedSourceTypeName: "i2889nameduse.Src",
                library: library,
                libraryAssemblyName: "i2889contracts"
            )
        )
    }

    @Fact
    func SourceNamedAndFunctionTypeControls_PreserveNestedSourceShapes_VerifyAndRun() {
        const source = `package i2889controls
import System
import System.Collections.Generic

class Src {
    let N int32
    init(n int32) { N = n }
}

struct Pt { var X int32 }

class MyBox[T any] {
    let Value T
    init(value T) { Value = value }
}

delegate Sink[T any](value T) void;
delegate PairSink[T any, U any](first T, second U) void;
delegate Factory[T any]() T;

func PrintNamed(items List[Src]) { Console.WriteLine(items[0].N) }
func PrintBare(items List[Src]) { Console.WriteLine(items[0].N) }

class NamedHolder {
    let Field Sink[List[Src]]
    prop Property Sink[List[Src]] { get; init; }

    init() {
        Field = (items List[Src]) -> Console.WriteLine(items[0].N)
        Property = (items) -> Console.WriteLine(items[0].N + 1)
    }

    func Run(items List[Src]) {
        Field(items)
        Property(items)
    }
}

class BareHolder {
    let Field (List[Src]) -> void
    prop Property (List[Src]) -> void { get; init; }

    init() {
        Field = (items List[Src]) -> Console.WriteLine(items[0].N)
        Property = (items) -> Console.WriteLine(items[0].N + 1)
    }

    func Run(items List[Src]) {
        Field(items)
        Property(items)
    }
}

func Main() {
    let named Sink[List[Src]] =
        (items List[Src]) -> Console.WriteLine(items[0].N)
    named(List[Src]{ Src(30) })

    var namedPoint Pt
    namedPoint.X = 32
    let namedStruct Sink[List[Pt]] =
        (items List[Pt]) -> Console.WriteLine(items[0].X)
    namedStruct(List[Pt]{ namedPoint })

    let namedFactory Factory[List[Src]] = () -> List[Src]{ Src(33) }
    Console.WriteLine(namedFactory()[0].N)

    let namedPair PairSink[List[Src], Dictionary[string, Src]] =
        (items List[Src], byName Dictionary[string, Src]) ->
            Console.WriteLine(items[0].N + byName["x"].N)
    let namedByName = Dictionary[string, Src]()
    namedByName.Add("x", Src(17))
    namedPair(List[Src]{ Src(17) }, namedByName)

    let namedDeep Sink[List[List[Src]]] =
        (items List[List[Src]]) -> Console.WriteLine(items[0][0].N)
    namedDeep(List[List[Src]]{ List[Src]{ Src(35) } })

    let namedGeneric Sink[List[MyBox[int32]]] =
        (items List[MyBox[int32]]) -> Console.WriteLine(items[0].Value)
    namedGeneric(List[MyBox[int32]]{ MyBox[int32](36) })

    let namedArray Sink[[]Src] =
        (items []Src) -> Console.WriteLine(items[0].N)
    namedArray([]Src{ Src(37) })

    let namedNullable Sink[List[Src?]] =
        (items List[Src?]) -> Console.WriteLine(items[1]!!.N)
    namedNullable(List[Src?]{ nil, Src(38) })

    let namedGroup Sink[List[Src]] = PrintNamed
    namedGroup(List[Src]{ Src(39) })
    let namedInferred Sink[List[Src]] =
        (items) -> Console.WriteLine(items[0].N)
    namedInferred(List[Src]{ Src(40) })
    NamedHolder().Run(List[Src]{ Src(41) })

    let bare (List[Src]) -> void =
        (items List[Src]) -> Console.WriteLine(items[0].N)
    bare(List[Src]{ Src(50) })

    var barePoint Pt
    barePoint.X = 52
    let bareStruct (List[Pt]) -> void =
        (items List[Pt]) -> Console.WriteLine(items[0].X)
    bareStruct(List[Pt]{ barePoint })

    let bareFactory () -> List[Src] = () -> List[Src]{ Src(53) }
    Console.WriteLine(bareFactory()[0].N)

    let barePair (List[Src], Dictionary[string, Src]) -> void =
        (items List[Src], byName Dictionary[string, Src]) ->
            Console.WriteLine(items[0].N + byName["x"].N)
    let bareByName = Dictionary[string, Src]()
    bareByName.Add("x", Src(27))
    barePair(List[Src]{ Src(27) }, bareByName)

    let bareDeep (List[List[Src]]) -> void =
        (items List[List[Src]]) -> Console.WriteLine(items[0][0].N)
    bareDeep(List[List[Src]]{ List[Src]{ Src(55) } })

    let bareGeneric (List[MyBox[int32]]) -> void =
        (items List[MyBox[int32]]) -> Console.WriteLine(items[0].Value)
    bareGeneric(List[MyBox[int32]]{ MyBox[int32](56) })

    let bareArray ([]Src) -> void =
        (items []Src) -> Console.WriteLine(items[0].N)
    bareArray([]Src{ Src(57) })

    let bareNullable (List[Src?]) -> void =
        (items List[Src?]) -> Console.WriteLine(items[1]!!.N)
    bareNullable(List[Src?]{ nil, Src(58) })

    let bareGroup (List[Src]) -> void = PrintBare
    bareGroup(List[Src]{ Src(59) })
    let bareInferred (List[Src]) -> void =
        (items) -> Console.WriteLine(items[0].N)
    bareInferred(List[Src]{ Src(60) })
    BareHolder().Run(List[Src]{ Src(61) })

    let importedPin System.Action[List[Src]] =
        (items List[Src]) -> Console.WriteLine(items[0].N)
    importedPin(List[Src]{ Src(63) })
}`
        Assert.Equal(
            "30${Environment.NewLine}32${Environment.NewLine}33${Environment.NewLine}34${Environment.NewLine}35${Environment.NewLine}36${Environment.NewLine}37${Environment.NewLine}38${Environment.NewLine}39${Environment.NewLine}40${Environment.NewLine}41${Environment.NewLine}42${Environment.NewLine}" +
                "50${Environment.NewLine}52${Environment.NewLine}53${Environment.NewLine}54${Environment.NewLine}55${Environment.NewLine}56${Environment.NewLine}57${Environment.NewLine}58${Environment.NewLine}59${Environment.NewLine}60${Environment.NewLine}61${Environment.NewLine}62${Environment.NewLine}63${Environment.NewLine}",
            CompileAndRun(source, expectedSourceTypeName: "i2889controls.Src")
        )
    }

    @Fact
    func PublicLibraryDelegateSignature_RoundTripsThroughCSharp() {
        let directory = Path.Combine(AppContext.BaseDirectory, "Issue2889_PublicApi_" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let librarySourcePath = Path.Combine(directory, "library.gs")
            let libraryPath = Path.Combine(directory, "i2889publicapi.dll")
            File.WriteAllText(librarySourcePath, `package i2889publicapi
import System
import System.Collections.Generic

class Src {}

class Api {
    shared {
        func Register(callback System.Action[List[Src]]) {
            callback(List[Src]{ Src() })
        }
    }
}`)
            Compile([]string{"/out:" + libraryPath, "/target:library", "/targetframework:net10.0", librarySourcePath})
            IlVerifier.Verify(libraryPath)
            let syntaxTree = CSharpSyntaxTree.ParseText(`using System.Collections.Generic;
using i2889publicapi;

namespace Consumer;

public static class Runner
{
    public static int Run()
    {
        var count = 0;
        Api.Register((List<Src> items) => count = items.Count);
        return count;
    }
}`)
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists)
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
                .Append(MetadataReference.CreateFromFile(libraryPath))
            let consumerPath = Path.Combine(directory, "consumer.dll")
            let consumer = CSharpCompilation.Create(
                "Issue2889CSharpConsumer",
                []SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let peStream = File.Create(consumerPath)
                let result = consumer.Emit(peStream)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
            let loadContext = AssemblyLoadContext(
                "Issue2889_PublicApi_" + Guid.NewGuid().ToString("N"),
                isCollectible: true
            )
            try {
                let libraryAssembly = loadContext.LoadFromAssemblyPath(libraryPath)
                loadContext.Resolving += (_ AssemblyLoadContext, name AssemblyName) -> if name.Name == libraryAssembly
                    .GetName().Name {
                    libraryAssembly
                } else {
                    default(Assembly?)
                }
                let api = libraryAssembly.GetTypes().Single((type Type) -> type.Name == "Api")
                let parameterType = api.GetMethod("Register")!!.GetParameters().Single().ParameterType
                Assert.Equal(typeof(Action[_]), parameterType.GetGenericTypeDefinition())
                let listType = parameterType.GetGenericArguments().Single()
                Assert.Equal(typeof(List[_]), listType.GetGenericTypeDefinition())
                let sourceType = listType.GetGenericArguments().Single()
                Assert.Equal("i2889publicapi.Src", sourceType.FullName)
                Assert.NotEqual(typeof(object), sourceType)
                let consumerAssembly = loadContext.LoadFromAssemblyPath(consumerPath)
                let run = consumerAssembly.GetType("Consumer.Runner")!!.GetMethod("Run")!!
                Assert.Equal(1, run.Invoke(nil, nil))
            } finally {
                loadContext.Unload()
            }
        } finally {
            TryDeleteDirectory(directory)
        }
    }

    shared {
        private func CompileAndRun(
            source string,
            expectedSourceTypeName string,
            library string? = nil,
            libraryAssemblyName string? = nil,
            expectClosure bool = false
        ) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2889_" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                var libraryPath string? = nil
                if library != nil {
                    let librarySourcePath = Path.Combine(directory, libraryAssemblyName + ".gs")
                    libraryPath = Path.Combine(directory, libraryAssemblyName + ".dll")
                    File.WriteAllText(librarySourcePath, library)
                    Compile(
                        []string{
                            "/out:" + libraryPath,
                            "/target:library",
                            "/targetframework:net10.0",
                            librarySourcePath
                        }
                    )
                    IlVerifier.Verify(libraryPath)
                }
                let sourcePath = Path.Combine(directory, "test.gs")
                let assemblyPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let args = List[string]{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0"}
                if libraryPath != nil {
                    args.Add("/nowarn:GS9100")
                    args.Add("/r:" + libraryPath)
                }
                args.Add(sourcePath)
                Compile(args.ToArray())
                IlVerifier.Verify(
                    assemblyPath,
                    if libraryPath != nil {
                        []string{libraryPath}
                    } else {
                        default([]?string)
                    }
                )
                AssertLambdaSignatures(assemblyPath, expectedSourceTypeName, libraryPath, expectClosure)
                let runtimeConfigPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json")
                if !File.Exists(runtimeConfigPath) {
                    File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(runtimeConfigPath)
                startInfo.ArgumentList.Add(assemblyPath)
                using let process = Process.Start(startInfo) ??
                    throw InvalidOperationException("Failed to start dotnet exec.")
                let stdout = process.StandardOutput.ReadToEnd()
                let stderr = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
                Assert.True(process.ExitCode == 0, (`dotnet exec exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                TryDeleteDirectory(directory)
            }
        }

        private func AssertLambdaSignatures(
            assemblyPath string,
            expectedSourceTypeName string,
            libraryPath string?,
            expectClosure bool
        ) {
            let loadContext = AssemblyLoadContext("Issue2889_" + Guid.NewGuid().ToString("N"), isCollectible: true)
            if libraryPath != nil {
                loadContext.Resolving += (_ AssemblyLoadContext, name AssemblyName) -> if string.Equals(
                    name.Name,
                    Path.GetFileNameWithoutExtension(libraryPath),
                    StringComparison.Ordinal
                ) {
                    loadContext.LoadFromAssemblyPath(libraryPath)
                } else {
                    default(Assembly?)
                }
            }
            try {
                let assembly = loadContext.LoadFromAssemblyPath(assemblyPath)
                let lambdaMethods = assembly
                    .GetTypes()
                    .SelectMany(
                    func (type Type) IEnumerable[(Type Type, Method MethodInfo)] {
                        return type
                            .GetMethods(
                            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance
                        )
                            .Where(
                            (method MethodInfo) -> method.Name.Contains("<lambda", StringComparison.Ordinal) ||
                                (
                                type.FullName?.Contains("<closure", StringComparison.Ordinal) == true &&
                                    method.Name == "Invoke"
                            )
                        )
                            .Select((method MethodInfo) -> (Type: type, Method: method))
                    }
                )
                    .ToArray()
                Assert.NotEmpty(lambdaMethods)
                if expectClosure {
                    Assert.Contains(
                        lambdaMethods,
                        (candidate(Type Type, Method MethodInfo)) -> candidate
                            .Item1
                            .FullName
                            ?.Contains("<closure", StringComparison.Ordinal) == true &&
                            candidate
                            .Item2
                            .Name == "Invoke"
                    )
                }
                let rendered = string.Join(
                    "\n",
                    lambdaMethods.Select(
                        (candidate(Type Type, Method MethodInfo)) -> candidate
                            .Item2
                            .ReturnType
                            .ToString() +
                            "(" +
                            string.Join(
                            ",",
                            candidate.Item2.GetParameters().Select((parameter ParameterInfo) -> parameter.ParameterType)
                        ) +
                            ")"
                    )
                )
                Assert.Contains(
                    "System.Collections.Generic.List`1[" + expectedSourceTypeName + "]",
                    rendered,
                    StringComparison.Ordinal
                )
                Assert.DoesNotMatch("(?:\\[|,)System\\.Object(?=[\\],\\[])", rendered)
            } finally {
                loadContext.Unload()
            }
        }

        private func Compile(args[]string) {
            let result = RunCompiler(args)
            Assert.True(result.ExitCode == 0, (`gsc failed:
` + "${result.Diagnostics}"))
        }

        private func RunCompiler(args[]string)(ExitCode int32, Diagnostics string) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var exitCode int32
            try {
                exitCode = Program.Main(args)
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return (exitCode, (`stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
        }

        private func TryDeleteDirectory(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }
}
