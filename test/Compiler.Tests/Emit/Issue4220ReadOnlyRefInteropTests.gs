// <copyright file="Issue4220ReadOnlyRefInteropTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

open class Issue4220ReadOnlyRefInteropTests : IDisposable {
    private let workspace string = Path.Combine(
        AppContext.BaseDirectory,
        "issue4220-artifacts",
        Guid.NewGuid().ToString("N")
    )

    @Fact
    func EmittedContractsMatchRoslyn_AndCSharpRetainsLiveAliases() {
        let directory = NewDirectory()
        let library = Compile(Source, directory, "Parity")
        let roslyn = CompileCSharp(Imported, directory, "Imported")
        let assemblies = EmittedFixture.LoadTogether(library, roslyn)
        let source = assemblies[0].GetType("Parity.Source")!!
        let control = assemblies[1].GetType("Imported.Source")!!.GetMethod("View")!!
        Assert.Equal(
            control.ReturnParameter.GetRequiredCustomModifiers().Select((t Type) -> t.FullName),
            assemblies[1].GetType("Imported.Reader")!!.GetMethod("Invoke")!!
                .ReturnParameter
                .GetRequiredCustomModifiers()
                .Select((t Type) -> t.FullName)
        )
        // ILVerify rejects incoming byref forwarders from Roslyn too. Compare
        // their complete IL; heap-backed producers and consumers verify below.
        Assert.Equal(
            control.GetMethodBody()!!.GetILAsByteArray(),
            source.GetMethod("View")!!.GetMethodBody()!!.GetILAsByteArray()
        )
        Assert.Equal(
            assemblies[1].GetType("Imported.Source")!!.GetMethod("Read")!!.GetMethodBody()!!.GetILAsByteArray(),
            source.GetMethod("Generic")!!.GetMethodBody()!!.GetILAsByteArray()
        )
        for method in[]MethodInfo{
            source.GetMethod("View")!!,
            source.GetMethod("Generic")!!,
            source.GetProperty("Property")!!.GetMethod!!,
            source.GetProperty("Item")!!.GetMethod!!,
            assemblies[0].GetType("Parity.IView`1")!!.GetMethod("View")!!
        } {
            Assert.True(method.ReturnType.IsByRef)
            Assert.Equal(
                control.ReturnParameter.GetRequiredCustomModifiers().Select((t Type) -> t.FullName),
                method.ReturnParameter.GetRequiredCustomModifiers().Select((t Type) -> t.FullName)
            )
            Assert.Contains(
                method.ReturnParameter.GetCustomAttributesData(),
                (a CustomAttributeData) -> a
                    .AttributeType
                    .FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute"
            )
        }
        Assert.Equal(
            assemblies[1].GetType("Imported.Source")!!.GetProperty("Property")!!.GetRequiredCustomModifiers().Select(
                (t Type) -> t.FullName
            ),
            source.GetProperty("Property")!!.GetRequiredCustomModifiers().Select((t Type) -> t.FullName)
        )
        let driver = CompileCSharp(`public static class Driver {
    public static int Run() {
        var source = new Parity.Source();
        ref readonly int property = ref source.Property;
        ref readonly int index = ref source[1];
        int input = 10;
        Parity.IView<int> contract = source;
        ref readonly int method = ref contract.View(ref input);
        Imported.Reader reader = source.View;
        ref readonly int viaDelegate = ref reader(ref input);
        string text = "old";
        ref readonly string generic = ref Parity.Source.Generic(ref text);
        source.Set(42); input = 42; text = "new";
        return property + index + method + viaDelegate + (generic == "new" ? 1 : 0);
    }
}`, directory, "Driver", library, roslyn)
        Assert.Equal(
            169,
            EmittedFixture.LoadTogether(library, roslyn, driver)[2].GetType("Driver")!!.GetMethod("Run")!!.Invoke(
                nil,
                nil
            )
        )
        let rejected = CreateCSharp(`class Bad {
    void Run() {
        var source = new Parity.Source();
        source.Property = 1;
        ref int alias = ref source[0];
        Imported.Writer write = source.View;
    }
}`, "Bad", library, roslyn).GetDiagnostics()
        Assert.Contains(rejected, (d Diagnostic) -> d.Id == "CS8331")
        Assert.Contains(rejected, (d Diagnostic) -> d.Id == "CS8329")
        Assert.Contains(rejected, (d Diagnostic) -> d.Id == "CS8189")
    }

    @Fact
    func ImportedValueReadsAndStructCallsPreserveReadOnlyStorage() {
        let directory = NewDirectory()
        let imported = CompileCSharp(Imported, directory, "Imported")
        let library = Compile(`package Consumer
import Imported
public class Driver {
    shared {
        public func Run() int32 {
            let source = Source()
            var first = source.Property
            source.Set(42)
            let counters = Counters()
            counters.View.Bump()
            return first + source.Property + counters.Read() + counters.View.Read()
        }
    }
}`, directory, "Consumer", imported)
        IlVerifier.Verify(library, []string{imported})
        Assert.Equal(
            136,
            EmittedFixture.LoadTogether(imported, library)[1].GetType("Consumer.Driver")!!.GetMethod("Run")!!.Invoke(
                nil,
                nil
            )
        )
    }

    @Theory
    @InlineData("ref readonly", true)
    @InlineData("ref", false)
    @InlineData("", false)
    func ImportedOverrideInterfaceAndDelegateRequireExactCapability(refKind string, valid bool) {
        let directory = NewDirectory()
        let imported = CompileCSharp(Imported, directory, "Imported")
        for declaration in[]string{
            "public class Derived : Source { public override func View(ref value int32) $refKind int32 { return ${(if refKind.Length > 0 { "ref " } else { "" })}value } }",
            (`public class Derived : Source { var values []int32 = []int32{42}
public override prop Property ` + "$refKind" + ` int32 -> values[0] }`),
            "public class Implementer : IView[int32] { public func View(ref value int32) $refKind int32 { return ${(if refKind.Length > 0 { "ref " } else { "" })}value } }",
            "public class Implementer[T] : IView[T] { public func View(ref value T) $refKind T { return ${(if refKind.Length > 0 { "ref " } else { "" })}value } }",
            (`public class Implementer : IProperty[int32] { var value int32
private prop (IProperty[int32]) Property ` + "$refKind" + ` int32 -> value }`),
            (
                `func View(ref value int32) ` +
                    "$refKind" +
                    ` int32 { return ` +
                    "${(if refKind.Length > 0 { "ref " } else { "" })}" +
                    `value }
func Convert() { let reader Reader = View }`
            )
        } {
            let result = Issue4220ReadOnlyRefInteropTests.CompileResult(`package Consumer
import Imported
` + declaration, directory, "Consumer", imported)
            Assert.True(valid == (result.ExitCode == 0), declaration + Environment.NewLine + result.Diagnostics)
            Assert.DoesNotContain("error GS9998", result.Diagnostics, StringComparison.Ordinal)
            if valid {
                Assert.NotEmpty(EmittedFixture.LoadTogether(imported, result.Path)[1].GetTypes())
            }
        }
    }

    @Fact
    func GSharpConvertsAndInvokesNativeAndImportedReadOnlyMethodGroups() {
        let directory = NewDirectory()
        let imported = CompileCSharp(Imported, directory, "Imported")
        let library = Compile(`package Consumer
import Imported
func View(ref value int32) ref readonly int32 { return ref value }
func Generic[T](ref value T) ref readonly T { return ref value }
class NativeCalls { prop Callback Reader -> Source.Read }
public class Driver {
    shared {
        public func Run() int32 {
            var value = 21
            let native Reader = View
            let external Reader = Source.Read
            let generic GenericReader[int32] = Generic
            let callbacks = Callbacks()
            let local = NativeCalls()
            return Calls.Invoke(native, ref value) + Calls.Invoke(external, ref value) + Calls.InvokeGeneric(generic, ref value) + native(ref value) + external(ref value) + generic(ref value) + callbacks.Callback(ref value) + callbacks.Field(ref value) + local.Callback(ref value)
        }
    }
}`, directory, "Consumer", imported)
        Assert.Equal(
            189,
            EmittedFixture.LoadTogether(imported, library)[1].GetType("Consumer.Driver")!!.GetMethod("Run")!!.Invoke(
                nil,
                nil
            )
        )
    }

    @Theory
    @InlineData("let writer Writer = Source.Read")
    @InlineData("let read = Source.Read\nlet writer Writer = read")
    @InlineData("let read = Source.Read\nlet copy (int32) -> int32 = read")
    @InlineData("let reader Reader = func(ref value int32) int32 { return value }")
    @InlineData("let ref writable = source.Property")
    @InlineData("let ref writable = Source.Read(ref value)")
    @InlineData("Calls.Write(ref source[0])")
    @InlineData("Calls.Fill(out source.Property)")
    @InlineData("Calls.Write(in view)")
    @InlineData("Calls.Fill(in view)")
    @InlineData("counters.View.Value = 1")
    @InlineData("counters.View.Value++")
    @InlineData("Calls.Write(ref counters.View.Value)")
    @InlineData("let ref readonly inner = counters.View\ninner.Value = 1")
    @InlineData("let ref readonly inner = counters.View\ninner.Value++")
    @InlineData("let ref readonly inner = counters.View\ninner.Property = 1")
    @InlineData("let ref readonly inner = counters.View\ninner[0] = 1")
    @InlineData("counters.View[0] = 1")
    @InlineData("counters.View[0]++")
    func ImportedReadOnlyReferencesCannotBeLaundered(operation string) {
        let directory = NewDirectory()
        let imported = CompileCSharp(Imported, directory, "Imported")
        let result = Issue4220ReadOnlyRefInteropTests.CompileResult((`package Consumer
import Imported
func Run() {
    var value = 10
    let ref readonly view = value
    let source = Source()
    let counters = Counters()
    ` + "$operation" + `
}`), directory, "Consumer", imported)
        Assert.NotEqual(0, result.ExitCode)
        Assert.DoesNotContain("error GS9998", result.Diagnostics, StringComparison.Ordinal)
        Assert.DoesNotContain("error GS0005", result.Diagnostics, StringComparison.Ordinal)
    }

    @Fact
    func ImportedAliasesRemainLive_AndReadonlyStructMethodUsesOriginalAddress() {
        let directory = NewDirectory()
        let imported = CompileCSharp(Imported, directory, "Imported")
        let library = Compile(`package Consumer
import Imported
public class Driver {
    shared {
        public func Run() int32 {
            let source = Source()
            let ref readonly alias = source.Property
            source.Set(42)
            let counters = Counters()
            let ref readonly counter = counters.View
            let ref readonly field = counter.Value
            counters.Set(10)
            var immutable = ReadOnlyCounter()
            let ref readonly immutableView = immutable
            return alias + field + (counters.View.Same(in counter) ? 1 : 0) + (immutableView.Same(in immutableView) ? 1 : 0)
        }
    }
}`, directory, "Consumer", imported)
        IlVerifier.Verify(library, []string{imported})
        Assert.Equal(
            54,
            EmittedFixture.LoadTogether(imported, library)[1].GetType("Consumer.Driver")!!.GetMethod("Run")!!.Invoke(
                nil,
                nil
            )
        )
    }

    @Fact
    func GSharpReimportsItsEmittedReadOnlyContracts() {
        let directory = NewDirectory()
        let producer = Compile(Source, directory, "Parity")
        let consumer = Compile(`package Consumer
import Parity
public class Driver {
    shared {
        public func Run() int32 {
            let source = Source()
            let ref readonly view = source.Property
            source.Set(42)
            var value = 42
            return view + source[0] + source.View(ref value)
        }
    }
}`, directory, "Consumer", producer)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            126,
            EmittedFixture.LoadTogether(producer, consumer)[1].GetType("Consumer.Driver")!!.GetMethod("Run")!!.Invoke(
                nil,
                nil
            )
        )
    }

    @Fact
    func HeapBackedReadOnlyContractsPassStrictIlVerification() {
        let directory = NewDirectory()
        let library = Compile(`package Verified
public class Source {
    var values []int32 = []int32{42}
    public prop View ref readonly int32 -> values[0]
    public prop this[i int32] ref readonly int32 -> values[i]
    public func Read() ref readonly int32 { return ref values[0] }
    shared {
        public func Generic[T](values []T) ref readonly T { return ref values[0] }
    }
}`, directory, "Verified")
        IlVerifier.Verify(library)
    }

    @Fact
    func GenericImportedFieldAliasPreservesPointeeAndStorage() {
        let directory = NewDirectory()
        let imported = CompileCSharp(Imported, directory, "Imported")
        let library = Compile(`package Consumer
import Imported
func Alias[T](holder Holder[T]) ref readonly T { return ref holder.Value }
public class Driver {
    shared {
        public func Run() int32 {
            let holder = Holder[int32]()
            let ref readonly view = holder.Value
            holder.Value = 21
            return view + Alias(holder)
        }
    }
}`, directory, "Consumer", imported)
        IlVerifier.Verify(library, []string{imported})
        Assert.Equal(
            42,
            EmittedFixture.LoadTogether(imported, library)[1].GetType("Consumer.Driver")!!.GetMethod("Run")!!.Invoke(
                nil,
                nil
            )
        )
    }

    @Theory
    @InlineData("func Bad(value Counter) ref readonly int32 { return ref value.Value }")
    @InlineData(`func Bad() ref readonly int32 {
var value = Counter()
let ref readonly alias = value.Value
return ref alias
}`)
    func ImportedFieldAliasDoesNotHideStackEscape(source string) {
        let directory = NewDirectory()
        let imported = CompileCSharp(Imported, directory, "Imported")
        let result = Issue4220ReadOnlyRefInteropTests.CompileResult(`package Consumer
import Imported
` + source, directory, "Consumer", imported)
        Assert.NotEqual(0, result.ExitCode)
        Assert.Contains("error GS0254", result.Diagnostics, StringComparison.Ordinal)
        Assert.DoesNotContain("error GS0005", result.Diagnostics, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("Write", "ref", "in view", "GS9009")
    @InlineData("Fill", "out", "in view", "GS9009")
    @InlineData("Write", "ref", "view", "GS9002")
    @InlineData("Fill", "out", "view", "GS9002")
    func ReadOnlyArgumentDiagnosticExplainsMissingWritePermission(
        methodName string,
        refKind string,
        argument string,
        diagnostic string
    ) {
        let directory = NewDirectory()
        let imported = CompileCSharp(Imported, directory, "Imported")
        let result = Issue4220ReadOnlyRefInteropTests.CompileResult((`package Consumer
import Imported
func Run() {
    var value = 10
    let ref readonly view = value
    Calls.` + "$methodName" + `(` + "$argument" + `)
}`), directory, "Consumer", imported)
        Assert.NotEqual(0, result.ExitCode)
        Assert.Contains("error " + diagnostic, result.Diagnostics, StringComparison.Ordinal)
        if diagnostic == "GS9009" {
            Assert.Contains(
                "cannot be passed to a writable '$refKind' parameter",
                result.Diagnostics,
                StringComparison.Ordinal
            )
            Assert.DoesNotContain("GS9002", result.Diagnostics, StringComparison.Ordinal)
        }
    }

    @Fact
    func ReferenceAssemblyGettersPreserveReadOnlyContracts() {
        let directory = NewDirectory()
        let reference = Path.Combine(directory, "Parity.ref.dll")
        let result = Issue4220ReadOnlyRefInteropTests.CompileResult(Source + `
public class Statics {
    shared {
        var value int32 = 10
        public prop Value ref readonly int32 -> value
        public func Set(next int32) { value = next }
    }
}
public class Box[T] {
    public var Value T
    public prop View ref readonly T -> Value
}`, directory, "Parity", Array.Empty[string](), reference)
        Assert.True(result.ExitCode == 0, result.Diagnostics)
        for assemblyPath in[]string{result.Path, reference} {
            let paths = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!)).Split(Path.PathSeparator)
                .Append(assemblyPath)
            using let metadata = MetadataLoadContext(PathAssemblyResolver(paths))
            let assembly = metadata.LoadFromAssemblyPath(assemblyPath)
            for (typeName, propertyName) in[](string, string){
                ("Parity.Source", "Property"),
                ("Parity.Source", "Item"),
                ("Parity.Statics", "Value"),
                ("Parity.Box`1", "View")
            } {
                let property = assembly.GetType(typeName)!!.GetProperty(propertyName)!!
                Assert.True(property.PropertyType.IsByRef)
                Assert.Contains(
                    property.GetCustomAttributesData(),
                    (a CustomAttributeData) -> a
                        .AttributeType
                        .FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute"
                )
                Assert.Contains(
                    property.GetMethod!!.ReturnParameter.GetRequiredCustomModifiers(),
                    (t Type) -> t.FullName == "System.Runtime.InteropServices.InAttribute"
                )
                Assert.Contains(
                    property.GetMethod!!.ReturnParameter.GetCustomAttributesData(),
                    (a CustomAttributeData) -> a
                        .AttributeType
                        .FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute"
                )
            }
        }
        let consumer = CompileCSharp(`public static class Driver {
    public static int Run() {
        var source = new Parity.Source();
        var box = new Parity.Box<int>();
        ref readonly int property = ref source.Property;
        ref readonly int index = ref source[1];
        ref readonly int shared = ref Parity.Statics.Value;
        ref readonly int generic = ref box.View;
        source.Set(42);
        Parity.Statics.Set(42);
        box.Value = 42;
        return property + index + shared + generic;
    }
}`, directory, "RefConsumer", reference)
        Assert.Equal(
            168,
            EmittedFixture.LoadTogether(result.Path, consumer)[1].GetType("Driver")!!.GetMethod("Run")!!.Invoke(
                nil,
                nil
            )
        )
    }

    func Dispose() {
        if Directory.Exists(this.workspace) {
            Directory.Delete(this.workspace, recursive: true)
        }
    }

    private func NewDirectory() string {
        Directory.CreateDirectory(this.workspace)
        return this.workspace
    }

    shared {
        private const Source string = `package Parity
public interface IView[T] {
    func View(ref value T) ref readonly T;
}
public class Source : IView[int32] {
    var values []int32 = []int32{10, 20}
    public prop Property ref readonly int32 -> values[0]
    public prop this[i int32] ref readonly int32 -> values[i]
    public func View(ref value int32) ref readonly int32 { return ref value }
    public func Set(next int32) {
        values[0] = next
        values[1] = next
    }
    shared {
        public func Generic[T](ref value T) ref readonly T { return ref value }
    }
}`

        private const Imported string = `#nullable enable
namespace Imported {
    public delegate ref readonly int Reader(ref int value);
    public delegate ref readonly T GenericReader<T>(ref T value);
    public delegate ref int Writer(ref int value);
    public interface IView<T> { ref readonly T View(ref T value); }
    public interface IProperty<T> { ref readonly T Property { get; } }
    public class Holder<T> { public T Value = default!; }
    public class Callbacks {
        public Reader Callback => Source.Read;
        public Reader Field = Source.Read;
    }
    public class Source {
        private int value = 10;
        public virtual ref readonly int Property => ref value;
        public ref readonly int this[int index] => ref value;
        public virtual ref readonly int View(ref int input) => ref input;
        public void Set(int next) { value = next; }
        public static ref readonly int Read(ref int input) => ref input;
    }
    public struct Counter {
        public int Value;
        public int Property { get => Value; set => Value = value; }
        public int this[int index] { get => Value; set => Value = value; }
        public void Bump() { Value++; }
        public readonly int Read() => Value;
        public readonly bool Same(in Counter other) =>
            System.Runtime.CompilerServices.Unsafe.AreSame(
                ref System.Runtime.CompilerServices.Unsafe.AsRef(in this),
                ref System.Runtime.CompilerServices.Unsafe.AsRef(in other));
    }
    public readonly struct ReadOnlyCounter {
        public bool Same(in ReadOnlyCounter other) =>
            System.Runtime.CompilerServices.Unsafe.AreSame(
                ref System.Runtime.CompilerServices.Unsafe.AsRef(in this),
                ref System.Runtime.CompilerServices.Unsafe.AsRef(in other));
    }
    public class Counters {
        private Counter value = new Counter { Value = 42 };
        public ref readonly Counter View => ref value;
        public int Read() => value.Value;
        public void Set(int next) { value.Value = next; }
    }
    public static class Calls {
        public static void Write(ref int value) { value = 1; }
        public static void Fill(out int value) { value = 1; }
        public static int Invoke(Reader reader, ref int value) => reader(ref value);
        public static T InvokeGeneric<T>(GenericReader<T> reader, ref T value) => reader(ref value);
    }
}`

        private func CreateCSharp(
            source string,
            name string,
            references ...string
        ) CSharpCompilation -> CSharpCompilation
            .Create(
            name,
            []SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.CSharp13))},
            (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!))
                .Split(Path.PathSeparator)
                .Concat(references)
                .Select((p string) -> MetadataReference.CreateFromFile(p)),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )

        private func CompileCSharp(source string, directory string, name string, references ...string) string {
            let path = Path.Combine(directory, name + ".dll")
            let result = CreateCSharp(source, name, references).Emit(path)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return path
        }

        private func Compile(source string, directory string, name string, references ...string) string {
            let result = Issue4220ReadOnlyRefInteropTests.CompileResult(source, directory, name, references)
            Assert.True(result.ExitCode == 0, result.Diagnostics)
            return result.Path
        }

        private func CompileResult(source string, directory string, name string, references ...string)(
            ExitCode int32,
            Diagnostics string,
            Path string
        ) -> Issue4220ReadOnlyRefInteropTests.CompileResult(
            source,
            directory,
            name,
            references,
            referenceOutputPath: nil
        )

        private func CompileResult(
            source string,
            directory string,
            name string,
            references[]string,
            referenceOutputPath string?
        )(ExitCode int32, Diagnostics string, Path string) {
            let sourcePath = Path.Combine(directory, name + ".gs")
            let path = Path.Combine(directory, name + ".dll")
            File.WriteAllText(sourcePath, source)
            using let output = StringWriter()
            let savedOut = Console.Out
            let savedError = Console.Error
            try {
                Console.SetOut(output)
                Console.SetError(output)
                let code = Program.Main(
                    []string{"/target:library", "/targetframework:net10.0", "/out:" + path, sourcePath}
                        .Concat(
                        if referenceOutputPath == nil {
                            Array.Empty[string]()
                        } else {
                            []string{"/refout:" + referenceOutputPath}
                        }
                    )
                        .Concat(references.Select((r string) -> ("/reference:" + r)))
                        .ToArray()
                )
                return (code, output.ToString(), path)
            } finally {
                Console.SetOut(savedOut)
                Console.SetError(savedError)
            }
        }
    }
}
