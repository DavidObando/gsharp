// <copyright file="Issue4220ReadOnlyRefInteropTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public class Issue4220ReadOnlyRefInteropTests : IDisposable
{
    private readonly string workspace = Path.Combine(AppContext.BaseDirectory, "issue4220-artifacts", Guid.NewGuid().ToString("N"));

    private const string Source = """
        package Parity
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
        }
        """;

    private const string Imported = """
        #nullable enable
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
        }
        """;

    [Fact]
    public void EmittedContractsMatchRoslyn_AndCSharpRetainsLiveAliases()
    {
        string directory = NewDirectory();
        string library = Compile(Source, directory, "Parity");
        string roslyn = CompileCSharp(Imported, directory, "Imported");
        var assemblies = EmittedFixture.LoadTogether(library, roslyn);
        Type source = assemblies[0].GetType("Parity.Source")!;
        MethodInfo control = assemblies[1].GetType("Imported.Source")!.GetMethod("View")!;
        Assert.Equal(
            control.ReturnParameter.GetRequiredCustomModifiers().Select(t => t.FullName),
            assemblies[1].GetType("Imported.Reader")!.GetMethod("Invoke")!.ReturnParameter.GetRequiredCustomModifiers().Select(t => t.FullName));
        // ILVerify rejects incoming byref forwarders from Roslyn too. Compare
        // their complete IL; heap-backed producers and consumers verify below.
        Assert.Equal(control.GetMethodBody()!.GetILAsByteArray(), source.GetMethod("View")!.GetMethodBody()!.GetILAsByteArray());
        Assert.Equal(
            assemblies[1].GetType("Imported.Source")!.GetMethod("Read")!.GetMethodBody()!.GetILAsByteArray(),
            source.GetMethod("Generic")!.GetMethodBody()!.GetILAsByteArray());
        foreach (MethodInfo method in new[] {
            source.GetMethod("View")!, source.GetMethod("Generic")!,
            source.GetProperty("Property")!.GetMethod!, source.GetProperty("Item")!.GetMethod!,
            assemblies[0].GetType("Parity.IView`1")!.GetMethod("View")!,
        })
        {
            Assert.True(method.ReturnType.IsByRef);
            Assert.Equal(
                control.ReturnParameter.GetRequiredCustomModifiers().Select(t => t.FullName),
                method.ReturnParameter.GetRequiredCustomModifiers().Select(t => t.FullName));
            Assert.Contains(method.ReturnParameter.GetCustomAttributesData(),
                a => a.AttributeType.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute");
        }

        Assert.Equal(
            assemblies[1].GetType("Imported.Source")!.GetProperty("Property")!.GetRequiredCustomModifiers().Select(t => t.FullName),
            source.GetProperty("Property")!.GetRequiredCustomModifiers().Select(t => t.FullName));
        string driver = CompileCSharp("""
            public static class Driver {
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
            }
            """, directory, "Driver", library, roslyn);
        Assert.Equal(169, EmittedFixture.LoadTogether(library, roslyn, driver)[2].GetType("Driver")!.GetMethod("Run")!.Invoke(null, null));

        var rejected = CreateCSharp("""
            class Bad {
                void Run() {
                    var source = new Parity.Source();
                    source.Property = 1;
                    ref int alias = ref source[0];
                    Imported.Writer write = source.View;
                }
            }
            """, "Bad", library, roslyn).GetDiagnostics();
        Assert.Contains(rejected, d => d.Id == "CS8331");
        Assert.Contains(rejected, d => d.Id == "CS8329");
        Assert.Contains(rejected, d => d.Id == "CS8189");
    }

    [Fact]
    public void ImportedValueReadsAndStructCallsPreserveReadOnlyStorage()
    {
        string directory = NewDirectory();
        string imported = CompileCSharp(Imported, directory, "Imported");
        string library = Compile("""
            package Consumer
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
            }
            """, directory, "Consumer", imported);
        IlVerifier.Verify(library, new[] { imported });
        Assert.Equal(136, EmittedFixture.LoadTogether(imported, library)[1].GetType("Consumer.Driver")!.GetMethod("Run")!.Invoke(null, null));
    }

    [Theory]
    [InlineData("ref readonly", true)]
    [InlineData("ref", false)]
    [InlineData("", false)]
    public void ImportedOverrideInterfaceAndDelegateRequireExactCapability(string refKind, bool valid)
    {
        string directory = NewDirectory();
        string imported = CompileCSharp(Imported, directory, "Imported");
        foreach (string declaration in new[] {
            $"public class Derived : Source {{ public override func View(ref value int32) {refKind} int32 {{ return {(refKind.Length > 0 ? "ref " : "")}value }} }}",
            $"public class Derived : Source {{ var values []int32 = []int32{{42}}\npublic override prop Property {refKind} int32 -> values[0] }}",
            $"public class Implementer : IView[int32] {{ public func View(ref value int32) {refKind} int32 {{ return {(refKind.Length > 0 ? "ref " : "")}value }} }}",
            $"public class Implementer[T] : IView[T] {{ public func View(ref value T) {refKind} T {{ return {(refKind.Length > 0 ? "ref " : "")}value }} }}",
            $"public class Implementer : IProperty[int32] {{ var value int32\nprivate prop (IProperty[int32]) Property {refKind} int32 -> value }}",
            $"func View(ref value int32) {refKind} int32 {{ return {(refKind.Length > 0 ? "ref " : "")}value }}\nfunc Convert() {{ let reader Reader = View }}",
        })
        {
            var result = CompileResult("package Consumer\nimport Imported\n" + declaration, directory, "Consumer", imported);
            Assert.True(valid == (result.ExitCode == 0), declaration + Environment.NewLine + result.Diagnostics);
            Assert.DoesNotContain("error GS9998", result.Diagnostics, StringComparison.Ordinal);
            if (valid)
            {
                Assert.NotEmpty(EmittedFixture.LoadTogether(imported, result.Path)[1].GetTypes());
            }
        }
    }

    [Fact]
    public void GSharpConvertsAndInvokesNativeAndImportedReadOnlyMethodGroups()
    {
        string directory = NewDirectory();
        string imported = CompileCSharp(Imported, directory, "Imported");
        string library = Compile("""
            package Consumer
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
            }
            """, directory, "Consumer", imported);
        Assert.Equal(189, EmittedFixture.LoadTogether(imported, library)[1].GetType("Consumer.Driver")!.GetMethod("Run")!.Invoke(null, null));
    }

    [Theory]
    [InlineData("let writer Writer = Source.Read")]
    [InlineData("let read = Source.Read\nlet writer Writer = read")]
    [InlineData("let read = Source.Read\nlet copy (int32) -> int32 = read")]
    [InlineData("let reader Reader = func(ref value int32) int32 { return value }")]
    [InlineData("let ref writable = source.Property")]
    [InlineData("let ref writable = Source.Read(ref value)")]
    [InlineData("Calls.Write(ref source[0])")]
    [InlineData("Calls.Fill(out source.Property)")]
    [InlineData("Calls.Write(in view)")]
    [InlineData("Calls.Fill(in view)")]
    [InlineData("counters.View.Value = 1")]
    [InlineData("counters.View.Value++")]
    [InlineData("Calls.Write(ref counters.View.Value)")]
    [InlineData("let ref readonly inner = counters.View\ninner.Value = 1")]
    [InlineData("let ref readonly inner = counters.View\ninner.Value++")]
    [InlineData("let ref readonly inner = counters.View\ninner.Property = 1")]
    [InlineData("let ref readonly inner = counters.View\ninner[0] = 1")]
    [InlineData("counters.View[0] = 1")]
    [InlineData("counters.View[0]++")]
    public void ImportedReadOnlyReferencesCannotBeLaundered(string operation)
    {
        string directory = NewDirectory();
        string imported = CompileCSharp(Imported, directory, "Imported");
        var result = CompileResult($$"""
            package Consumer
            import Imported
            func Run() {
                var value = 10
                let ref readonly view = value
                let source = Source()
                let counters = Counters()
                {{operation}}
            }
            """, directory, "Consumer", imported);
        Assert.NotEqual(0, result.ExitCode);
        Assert.DoesNotContain("error GS9998", result.Diagnostics, StringComparison.Ordinal);
        Assert.DoesNotContain("error GS0005", result.Diagnostics, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedAliasesRemainLive_AndReadonlyStructMethodUsesOriginalAddress()
    {
        string directory = NewDirectory();
        string imported = CompileCSharp(Imported, directory, "Imported");
        string library = Compile("""
            package Consumer
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
            }
            """, directory, "Consumer", imported);
        IlVerifier.Verify(library, new[] { imported });
        Assert.Equal(54, EmittedFixture.LoadTogether(imported, library)[1].GetType("Consumer.Driver")!.GetMethod("Run")!.Invoke(null, null));
    }

    [Fact]
    public void GSharpReimportsItsEmittedReadOnlyContracts()
    {
        string directory = NewDirectory();
        string producer = Compile(Source, directory, "Parity");
        string consumer = Compile("""
            package Consumer
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
            }
            """, directory, "Consumer", producer);
        IlVerifier.Verify(consumer, new[] { producer });
        Assert.Equal(126, EmittedFixture.LoadTogether(producer, consumer)[1].GetType("Consumer.Driver")!.GetMethod("Run")!.Invoke(null, null));
    }

    [Fact]
    public void HeapBackedReadOnlyContractsPassStrictIlVerification()
    {
        string directory = NewDirectory();
        string library = Compile("""
            package Verified
            public class Source {
                var values []int32 = []int32{42}
                public prop View ref readonly int32 -> values[0]
                public prop this[i int32] ref readonly int32 -> values[i]
                public func Read() ref readonly int32 { return ref values[0] }
                shared {
                    public func Generic[T](values []T) ref readonly T { return ref values[0] }
                }
            }
            """, directory, "Verified");
        IlVerifier.Verify(library);
    }

    [Fact]
    public void GenericImportedFieldAliasPreservesPointeeAndStorage()
    {
        string directory = NewDirectory();
        string imported = CompileCSharp(Imported, directory, "Imported");
        string library = Compile("""
            package Consumer
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
            }
            """, directory, "Consumer", imported);
        IlVerifier.Verify(library, new[] { imported });
        Assert.Equal(42, EmittedFixture.LoadTogether(imported, library)[1].GetType("Consumer.Driver")!.GetMethod("Run")!.Invoke(null, null));
    }

    [Theory]
    [InlineData("func Bad(value Counter) ref readonly int32 { return ref value.Value }")]
    [InlineData("func Bad() ref readonly int32 {\nvar value = Counter()\nlet ref readonly alias = value.Value\nreturn ref alias\n}")]
    public void ImportedFieldAliasDoesNotHideStackEscape(string source)
    {
        string directory = NewDirectory();
        string imported = CompileCSharp(Imported, directory, "Imported");
        var result = CompileResult("package Consumer\nimport Imported\n" + source, directory, "Consumer", imported);
        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains("error GS0254", result.Diagnostics, StringComparison.Ordinal);
        Assert.DoesNotContain("error GS0005", result.Diagnostics, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Write", "ref", "in view", "GS9009")]
    [InlineData("Fill", "out", "in view", "GS9009")]
    [InlineData("Write", "ref", "view", "GS9002")]
    [InlineData("Fill", "out", "view", "GS9002")]
    public void ReadOnlyArgumentDiagnosticExplainsMissingWritePermission(string methodName, string refKind, string argument, string diagnostic)
    {
        string directory = NewDirectory();
        string imported = CompileCSharp(Imported, directory, "Imported");
        var result = CompileResult($$"""
            package Consumer
            import Imported
            func Run() {
                var value = 10
                let ref readonly view = value
                Calls.{{methodName}}({{argument}})
            }
            """, directory, "Consumer", imported);
        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains("error " + diagnostic, result.Diagnostics, StringComparison.Ordinal);
        if (diagnostic == "GS9009")
        {
            Assert.Contains($"cannot be passed to a writable '{refKind}' parameter", result.Diagnostics, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9002", result.Diagnostics, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void ReferenceAssemblyGettersPreserveReadOnlyContracts()
    {
        string directory = NewDirectory();
        string reference = Path.Combine(directory, "Parity.ref.dll");
        var result = CompileResult(Source + """

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
            }
            """, directory, "Parity", Array.Empty<string>(), reference);
        Assert.True(result.ExitCode == 0, result.Diagnostics);

        foreach (string assemblyPath in new[] { result.Path, reference })
        {
            var paths = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator).Append(assemblyPath);
            using var metadata = new MetadataLoadContext(new PathAssemblyResolver(paths));
            Assembly assembly = metadata.LoadFromAssemblyPath(assemblyPath);
            foreach (var (typeName, propertyName) in new[] {
                ("Parity.Source", "Property"), ("Parity.Source", "Item"),
                ("Parity.Statics", "Value"), ("Parity.Box`1", "View"),
            })
            {
                PropertyInfo property = assembly.GetType(typeName)!.GetProperty(propertyName)!;
                Assert.True(property.PropertyType.IsByRef);
                Assert.Contains(property.GetCustomAttributesData(),
                    a => a.AttributeType.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute");
                Assert.Contains(property.GetMethod!.ReturnParameter.GetRequiredCustomModifiers(),
                    t => t.FullName == "System.Runtime.InteropServices.InAttribute");
                Assert.Contains(property.GetMethod.ReturnParameter.GetCustomAttributesData(),
                    a => a.AttributeType.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute");
            }
        }

        string consumer = CompileCSharp("""
            public static class Driver {
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
            }
            """, directory, "RefConsumer", reference);
        Assert.Equal(168, EmittedFixture.LoadTogether(result.Path, consumer)[1].GetType("Driver")!.GetMethod("Run")!.Invoke(null, null));
    }

    public void Dispose()
    {
        if (Directory.Exists(this.workspace))
        {
            Directory.Delete(this.workspace, recursive: true);
        }
    }

    private string NewDirectory()
    {
        Directory.CreateDirectory(this.workspace);
        return this.workspace;
    }

    private static CSharpCompilation CreateCSharp(string source, string name, params string[] references)
        => CSharpCompilation.Create(name, new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.CSharp13)) },
            ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
                .Concat(references).Select(p => MetadataReference.CreateFromFile(p)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

    private static string CompileCSharp(string source, string directory, string name, params string[] references)
    {
        string path = Path.Combine(directory, name + ".dll");
        var result = CreateCSharp(source, name, references).Emit(path);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return path;
    }

    private static string Compile(string source, string directory, string name, params string[] references)
    {
        var result = CompileResult(source, directory, name, references);
        Assert.True(result.ExitCode == 0, result.Diagnostics);
        return result.Path;
    }

    private static (int ExitCode, string Diagnostics, string Path) CompileResult(string source, string directory, string name, params string[] references)
        => CompileResult(source, directory, name, references, referenceOutputPath: null);

    private static (int ExitCode, string Diagnostics, string Path) CompileResult(
        string source, string directory, string name, string[] references, string referenceOutputPath)
    {
        string sourcePath = Path.Combine(directory, name + ".gs");
        string path = Path.Combine(directory, name + ".dll");
        File.WriteAllText(sourcePath, source);
        using var output = new StringWriter();
        var savedOut = Console.Out;
        var savedError = Console.Error;
        try
        {
            Console.SetOut(output);
            Console.SetError(output);
            int code = Program.Main(new[] { "/target:library", "/targetframework:net10.0", "/out:" + path, sourcePath }
                .Concat(referenceOutputPath == null ? Array.Empty<string>() : new[] { "/refout:" + referenceOutputPath })
                .Concat(references.Select(r => "/reference:" + r)).ToArray());
            return (code, output.ToString(), path);
        }
        finally
        {
            Console.SetOut(savedOut);
            Console.SetError(savedError);
        }
    }
}
