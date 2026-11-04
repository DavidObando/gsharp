// <copyright file="Issue4760And4761SequenceIteratorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Runtime.ExceptionServices
import Xunit

/// Regression tests for issues #4760 and #4761:
/// - #4760: explicit `GetEnumerator()` on a `sequence[MaybeBox]` iterator over an
///   imported (`MetadataLoadContext`) or same-compilation element type, and
///   tokenless `TypeBuilderInstantiation` method metadata/nullability reads.
/// - #4761: implicit conversions from source-declared `struct`, `class`,
///   inherited source base class, and `interface` implementations of
///   `IEnumerable[T]` / `IAsyncEnumerable[T]` to `sequence[U]` /
///   `async sequence[U]`.
open class Issue4760And4761SequenceIteratorEmitTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func Issue4760_ExplicitGetEnumerator_OnImportedAndSourceIterator_CompilesVerifiesAndExecutes(obliviousMode bool) {
        let tempDir = CreateScratchDirectory("gs_4760_")
        try {
            let fixturePath = CompileCSharpFixture(tempDir, "MaybeBoxFixture", `#nullable enable
namespace MaybeBoxLib;

public sealed class MaybeBox
{
    public string? Tag { get; }

    public MaybeBox(string? tag)
    {
        Tag = tag;
    }

    public static implicit operator MaybeBox?(string? value) =>
        value == "null" ? null : new MaybeBox(value);
}

public readonly struct ImportedPair
{
    public int Code { get; }

    public ImportedPair(int code)
    {
        Code = code;
    }
}

#nullable disable
public sealed class ObliviousMaybeBox
{
    public string Tag { get; }

    public ObliviousMaybeBox(string tag)
    {
        Tag = tag;
    }

    public static implicit operator ObliviousMaybeBox(string value) =>
        value == "null" ? null : new ObliviousMaybeBox(value);
}
`)
            let thirdYield = if obliviousMode {
                "if local != nil { yield \"null\" }"
            } else {
                "if local != nil { yield ObliviousMaybeBox(\"second\") }"
            }
            let readCurrent = if obliviousMode {
                "parts.Add(if current == nil { \"nil\" } else { current.Tag })"
            } else {
                "parts.Add(current.Tag)"
            }
            let expectedMiddle = if obliviousMode {
                "nil"
            } else {
                "second"
            }
            let source = `package Issue4760Repro
import System
import System.Collections.Generic
import System.Threading.Tasks
import MaybeBoxLib

class SourceBox {
    public let Label string
    init(label string) {
        Label = label
    }
}

func ImportedRows(value string?) sequence[MaybeBox] {
    if value != nil {
        yield MaybeBox(value)
    }
}

func ObliviousConvertedRows(value string?) sequence[ObliviousMaybeBox] {
    let local = value
    if value != nil {
        yield value
    }
    ` + thirdYield + `
}

func PairRows(seed int32) sequence[ImportedPair] {
    yield ImportedPair(seed)
    yield ImportedPair(seed + 5)
}

func SourceRows(label string) sequence[SourceBox] {
    yield SourceBox(label)
}

async func AsyncImportedRows(value string) sequence[MaybeBox] {
    await Task.Yield()
    yield MaybeBox(value)
}

async func RunAsync() string {
    var parts = List[string]()

    using let e1 = ImportedRows("alpha").GetEnumerator()
    if e1.MoveNext() {
        parts.Add(e1.Current.Tag ?? "nil")
    }

    using let e2 = ObliviousConvertedRows("beta").GetEnumerator()
    while e2.MoveNext() {
        let current = e2.Current
        ` + readCurrent + `
    }

    using let e3 = PairRows(10).GetEnumerator()
    var pairSum = 0
    while e3.MoveNext() {
        pairSum += e3.Current.Code
    }
    parts.Add(pairSum.ToString())

    using let e4 = SourceRows("src").GetEnumerator()
    if e4.MoveNext() {
        parts.Add(e4.Current.Label)
    }

    await using let e5 = AsyncImportedRows("omega").GetAsyncEnumerator()
    if await e5.MoveNextAsync() {
        parts.Add(e5.Current.Tag ?? "nil")
    }

    return string.Join("|", parts)
}

Console.WriteLine(RunAsync().GetAwaiter().GetResult())
`
            let extraArgs = if obliviousMode {
                []string{"/nullability:oblivious"}
            } else {
                Array.Empty[string]()
            }
            let output = CompileVerifyAndRun(tempDir, source, fixturePath, extraArgs)
            Assert.Equal("alpha|beta|" + expectedMiddle + "|25|src|omega" + Environment.NewLine, output)
        } finally {
            DeleteScratchDirectory(tempDir)
        }
    }

    @Fact
    func Issue4760_SyntheticTypeBuilderInstantiationMethod_ResolvesMetadataDefinitionWithoutThrowing() {
        let trusted = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
            .Split(Path.PathSeparator)
            .Where((p string) -> !string.IsNullOrEmpty(p))
            .ToArray()
        let mlc = MetadataLoadContext(PathAssemblyResolver(trusted), coreAssemblyName: "System.Private.CoreLib")
        try {
            let core = mlc.CoreAssembly!!
            let contextString = core.GetType("System.String", throwOnError: true)!!
            let hostOpenEnumerable = typeof(IEnumerable[_])
            let hybridEnumerable = hostOpenEnumerable.MakeGenericType(contextString)
            Assert.True(ClrTypeUtilities.IsTypeBuilderInstantiation(hybridEnumerable))

            let openGetEnumerator = hostOpenEnumerable.GetMethod("GetEnumerator")!!
            let mappedMethod = Assert.Single(
                MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(hybridEnumerable, "GetEnumerator"),
                (m MethodInfo) -> m.DeclaringType == hybridEnumerable
            )
            let rawUnmappedMethod = TypeBuilder.GetMethod(hybridEnumerable, openGetEnumerator)

            var mappedDef MemberInfo? = nil
            var unmappedDef MemberInfo? = nil
            var decodedReturn TypeSymbol? = nil
            let flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
            let thrown = CountFirstChanceExceptions(
                func () {
                    mappedDef = ClrTypeUtilities.FindMetadataDefinition(hostOpenEnumerable, mappedMethod, flags)
                    unmappedDef = ClrTypeUtilities.FindMetadataDefinition(hostOpenEnumerable, rawUnmappedMethod, flags)
                    decodedReturn = ClrNullability.GetReturnTypeSymbol(mappedMethod)
                }
            )
            Assert.Empty(thrown)
            Assert.Same(openGetEnumerator, mappedDef)
            Assert.Same(openGetEnumerator, unmappedDef)
            Assert.NotNull(decodedReturn)
        } finally {
            mlc.Dispose()
        }
    }

    @Fact
    func Issue4761_SourceDeclaredStructClassAndInterfaceSequenceConversions_CompileVerifyAndExecute() {
        let tempDir = CreateScratchDirectory("gs_4761_pos_")
        try {
            let source = `package SourceSequenceReview
import System
import System.Collections
import System.Collections.Generic
import System.Threading
import System.Threading.Tasks

open class BaseItem {
    public let Id int32
    init(id int32) {
        Id = id
    }
}

class DerivedItem : BaseItem {
    init(id int32) : base(id) {}
}

struct StructBag : IEnumerable[BaseItem] {
    public let Seed int32
    init(seed int32) {
        Seed = seed
    }
    func GetEnumerator() IEnumerator[BaseItem] ->
        List[BaseItem]{BaseItem(Seed), BaseItem(Seed + 1)}.GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}

struct DerivedStructBag : IEnumerable[DerivedItem] {
    public let Seed int32
    init(seed int32) {
        Seed = seed
    }
    func GetEnumerator() IEnumerator[DerivedItem] ->
        List[DerivedItem]{DerivedItem(Seed)}.GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}

open class ClassBag : IEnumerable[DerivedItem] {
    public let Seed int32
    init(seed int32) {
        Seed = seed
    }
    func GetEnumerator() IEnumerator[DerivedItem] ->
        List[DerivedItem]{DerivedItem(Seed), DerivedItem(Seed + 2)}.GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}

class InheritedClassBag : ClassBag {
    init(seed int32) : base(seed) {}
}

interface ISourceBag : IEnumerable[DerivedItem] {}

struct StructViaInterface : ISourceBag {
    public let Seed int32
    init(seed int32) {
        Seed = seed
    }
    func GetEnumerator() IEnumerator[DerivedItem] ->
        List[DerivedItem]{DerivedItem(Seed)}.GetEnumerator()
    func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
}

class ClassViaInterface : ISourceBag {
    public let Seed int32
    init(seed int32) {
        Seed = seed
    }
    func GetEnumerator() IEnumerator[DerivedItem] ->
        List[DerivedItem]{DerivedItem(Seed)}.GetEnumerator()
    func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
}

struct GenericStructBag[T] : IEnumerable[T] {
    public let Item T
    init(item T) {
        Item = item
    }
    func GetEnumerator() IEnumerator[T] ->
        List[T]{Item}.GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}

async func SingleAsync(item DerivedItem) sequence[DerivedItem] {
    await Task.Yield()
    yield item
}

struct AsyncStructBag : IAsyncEnumerable[DerivedItem] {
    public let Seed int32
    init(seed int32) {
        Seed = seed
    }
    func GetAsyncEnumerator(cancellationToken CancellationToken) IAsyncEnumerator[DerivedItem] ->
        SingleAsync(DerivedItem(Seed)).GetAsyncEnumerator(cancellationToken)
}

open class AsyncClassBag : IAsyncEnumerable[DerivedItem] {
    public let Seed int32
    init(seed int32) {
        Seed = seed
    }
    func GetAsyncEnumerator(cancellationToken CancellationToken) IAsyncEnumerator[DerivedItem] ->
        SingleAsync(DerivedItem(Seed)).GetAsyncEnumerator(cancellationToken)
}

class InheritedAsyncClassBag : AsyncClassBag {
    init(seed int32) : base(seed) {}
}

interface IAsyncSourceBag : IAsyncEnumerable[DerivedItem] {}

func ConvertStruct(value StructBag) sequence[BaseItem] -> value
func ConvertDerivedStructCovariant(value DerivedStructBag) sequence[BaseItem] -> value
func ConvertClassExact(value ClassBag) sequence[DerivedItem] -> value
func ConvertClassCovariant(value ClassBag) sequence[BaseItem] -> value
func ConvertInheritedClass(value InheritedClassBag) sequence[BaseItem] -> value
func ConvertInterface(value ISourceBag) sequence[BaseItem] -> value
func ConvertStructViaInterface(value StructViaInterface) sequence[BaseItem] -> value
func ConvertClassViaInterface(value ClassViaInterface) sequence[BaseItem] -> value
func ConvertGenericStruct[T](value GenericStructBag[T]) sequence[T] -> value

func ConvertAsyncStruct(value AsyncStructBag) async sequence[DerivedItem] -> value
func ConvertAsyncStructCovariant(value AsyncStructBag) async sequence[BaseItem] -> value
func ConvertAsyncClass(value AsyncClassBag) async sequence[BaseItem] -> value
func ConvertInheritedAsyncClass(value InheritedAsyncClassBag) async sequence[BaseItem] -> value
func ConvertAsyncInterface(value IAsyncSourceBag) async sequence[BaseItem] -> value

func SumSync(items sequence[BaseItem]) int32 {
    var total = 0
    for item in items {
        total += item.Id
    }
    return total
}

async func SumAsync(items async sequence[BaseItem]) int32 {
    var total = 0
    await for item in items {
        total += item.Id
    }
    return total
}

async func RunAll() string {
    let sb = StructBag(1)
    let dsb = DerivedStructBag(10)
    let cb = ClassBag(100)
    let icb = InheritedClassBag(200)
    let svi = StructViaInterface(30)
    let cvi = ClassViaInterface(40)
    let iface ISourceBag = cvi
    let gsb = GenericStructBag[BaseItem](BaseItem(50))

    let cbExact = ConvertClassExact(cb)
    let cbCovariant = ConvertClassCovariant(cb)
    let icbSeq = ConvertInheritedClass(icb)
    let ifaceSeq = ConvertInterface(iface)
    let cviSeq = ConvertClassViaInterface(cvi)

    let sameRef = Object.ReferenceEquals(cb, cbExact) &&
        Object.ReferenceEquals(cb, cbCovariant) &&
        Object.ReferenceEquals(icb, icbSeq) &&
        Object.ReferenceEquals(cvi, ifaceSeq) &&
        Object.ReferenceEquals(cvi, cviSeq)

    let syncTotal = SumSync(ConvertStruct(sb)) +
        SumSync(ConvertDerivedStructCovariant(dsb)) +
        SumSync(cbCovariant) +
        SumSync(icbSeq) +
        SumSync(ifaceSeq) +
        SumSync(ConvertStructViaInterface(svi)) +
        SumSync(cviSeq) +
        SumSync(ConvertGenericStruct(gsb))

    let asb = AsyncStructBag(5)
    let acb = InheritedAsyncClassBag(15)
    let asyncTotal = await SumAsync(ConvertAsyncStructCovariant(asb)) +
        await SumAsync(ConvertAsyncClass(acb)) +
        await SumAsync(ConvertInheritedAsyncClass(acb))

    var exactAsync = 0
    await for item in ConvertAsyncStruct(asb) {
        exactAsync += item.Id
    }

    return "${syncTotal}|${asyncTotal}|${exactAsync}|${sameRef}"
}

Console.WriteLine(RunAll().GetAwaiter().GetResult())
`
            let output = CompileVerifyAndRun(tempDir, source)
            // syncTotal: (1+2) + 10 + (100+102) + (200+202) + 40 + 30 + 40 + 50 = 777
            // asyncTotal: 5 + 15 + 15 = 35
            // exactAsync: 5
            Assert.Equal("777|35|5|True" + Environment.NewLine, output)
        } finally {
            DeleteScratchDirectory(tempDir)
        }
    }

    @Theory
    @InlineData("StructItemBag", "sequence[OtherItem]", "GS0155")
    @InlineData("StructItemBag", "IEnumerable[OtherItem]", "GS0155")
    @InlineData("ClassItemBag", "sequence[OtherItem]", "GS0155")
    @InlineData("ISourceItemBag", "sequence[OtherItem]", "GS0156")
    @InlineData("StructBaseBag", "sequence[DerivedItem]", "GS0155")
    @InlineData("StructIntBag", "sequence[object]", "GS0155")
    @InlineData("StructItemBag", "async sequence[BaseItem]", "GS0155")
    @InlineData("AsyncStructItemBag", "sequence[BaseItem]", "GS0155")
    @InlineData("StructNullableIntBag", "IEnumerable[int32]", "GS0155")
    func Issue4761_IncompatibleSourceSequenceConversions_AreRejected(
        sourceType string,
        targetType string,
        expectedDiagnostic string
    ) {
        let tempDir = CreateScratchDirectory("gs_4761_neg_")
        try {
            let source = `package SourceSequenceNegative
import System.Collections
import System.Collections.Generic
import System.Threading

open class BaseItem {}
class DerivedItem : BaseItem {}
class OtherItem {}

struct StructItemBag : IEnumerable[BaseItem] {
    func GetEnumerator() IEnumerator[BaseItem] -> List[BaseItem]().GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}

class ClassItemBag : IEnumerable[BaseItem] {
    func GetEnumerator() IEnumerator[BaseItem] -> List[BaseItem]().GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}

interface ISourceItemBag : IEnumerable[BaseItem] {}

struct StructBaseBag : IEnumerable[BaseItem] {
    func GetEnumerator() IEnumerator[BaseItem] -> List[BaseItem]().GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}

struct StructIntBag : IEnumerable[int32] {
    func GetEnumerator() IEnumerator[int32] -> List[int32]().GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}

struct StructNullableIntBag : IEnumerable[int32?] {
    func GetEnumerator() IEnumerator[int32?] -> List[int32?]().GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}

struct AsyncStructItemBag : IAsyncEnumerable[BaseItem] {
    func GetAsyncEnumerator(cancellationToken CancellationToken) IAsyncEnumerator[BaseItem] ->
        throw System.NotImplementedException()
}

func Reject(value ` + sourceType + `) ` + targetType + ` -> value
`
            let srcPath = Path.Combine(tempDir, "neg.gs")
            let outPath = Path.Combine(tempDir, "neg.dll")
            File.WriteAllText(srcPath, source)
            let (exitCode, log) = InvokeCompiler(
                []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            )
            Assert.NotEqual(0, exitCode)
            Assert.Contains("error " + expectedDiagnostic + ":", log, StringComparison.Ordinal)
            Assert.False(File.Exists(outPath))
        } finally {
            DeleteScratchDirectory(tempDir)
        }
    }

    shared {
        private func CreateScratchDirectory(prefix string) string {
            let path = Path.Combine(AppContext.BaseDirectory, prefix + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(path)
            return path
        }

        private func DeleteScratchDirectory(path string) {
            try {
                if Directory.Exists(path) {
                    Directory.Delete(path, recursive: true)
                }
            } catch { }
        }

        private func CountFirstChanceExceptions(probe Action) List[string] {
            let thrown = List[string]()
            let thread = Environment.CurrentManagedThreadId
            let handler = func (sender object?, args FirstChanceExceptionEventArgs) {
                if Environment.CurrentManagedThreadId == thread {
                    thrown.Add(args.Exception.GetType().Name)
                }
            }
            AppDomain.CurrentDomain.FirstChanceException += handler
            try {
                probe()
            } finally {
                AppDomain.CurrentDomain.FirstChanceException -= handler
            }
            return thrown
        }

        private func CompileCSharpFixture(tempDir string, assemblyName string, csharpSource string) string {
            let trusted = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Select((p string) -> MetadataReference.CreateFromFile(p))
                .ToArray()
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{CSharpSyntaxTree.ParseText(csharpSource)},
                trusted,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let dllPath = Path.Combine(tempDir, assemblyName + ".dll")
            let emitResult = compilation.Emit(dllPath)
            Assert.True(
                emitResult.Success,
                string.Join(Environment.NewLine, emitResult.Diagnostics.Select((d Diagnostic) -> d.ToString()))
            )
            return dllPath
        }

        private func InvokeCompiler(args[]string)(ExitCode int32, Log string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exitCode int32
            try {
                exitCode = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (exitCode, compileOut.ToString() + compileErr.ToString())
        }

        private func CompileVerifyAndRun(
            tempDir string,
            source string,
            referencePath string? = nil,
            extraArgs[]?string = nil
        ) string {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            if referencePath != nil {
                args.Add("/reference:" + referencePath)
            }
            if extraArgs != nil {
                args.AddRange(extraArgs)
            }
            args.Add(srcPath)
            let (compileExit, compileLog) = InvokeCompiler(args.ToArray())
            Assert.True(compileExit == 0, "gsc failed:\n" + compileLog)
            if referencePath != nil {
                IlVerifier.Verify(outPath, additionalReferences: []string{referencePath})
            } else {
                IlVerifier.Verify(outPath)
            }
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
            let stdoutTask = proc.StandardOutput.ReadToEndAsync()
            let stderrTask = proc.StandardError.ReadToEndAsync()
            if !proc.WaitForExit(30_000) {
                proc.Kill(entireProcessTree: true)
                Assert.Fail("dotnet exec timed out")
            }
            proc.WaitForExit()
            let stdout = stdoutTask.GetAwaiter().GetResult()
            let stderr = stderrTask.GetAwaiter().GetResult()
            Assert.True(proc.ExitCode == 0, "exited ${proc.ExitCode}\nstdout:\n$stdout\nstderr:\n$stderr")
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
