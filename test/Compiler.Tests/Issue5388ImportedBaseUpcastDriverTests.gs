package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import NominalConversion = GSharp.Core.CodeAnalysis.Binding.Conversion
import SymbolAccessibility = GSharp.Core.CodeAnalysis.Symbols.Accessibility
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Security.Cryptography
import System.Text
import System.Text.RegularExpressions
import Xunit
import Xunit.Abstractions

class Issue5388ImportedBaseUpcastDriverTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func SourceClassObjectRelation_PreservesNarrowingAndReceiverRecovery() {
        let source = StructSymbol(
            "Source",
            ImmutableArray[FieldSymbol].Empty,
            SymbolAccessibility.Public,
            nil,
            "probe",
            false,
            false,
            true
        )
        Assert.True(NominalConversion.IsRepresentationPreservingImplicit(source, TypeSymbol.Object))
        Assert.True(NarrowingState.IsNoStrongerThan(TypeSymbol.Object, source))
        Assert.True(ExpressionBinder.CanRecoverDeclaredMemberWriteReceiver(source, TypeSymbol.Object))
        Assert.False(NominalConversion.IsRepresentationPreservingImplicit(TypeSymbol.Object, source))
        let parent = StructSymbol(
            "Parent",
            ImmutableArray[FieldSymbol].Empty,
            SymbolAccessibility.Public,
            nil,
            "probe",
            false,
            false,
            true
        )
        source.SetBaseClass(parent)
        let path = AccessPath.ForVariable(LocalVariableSymbol("value", false, TypeSymbol.Object))
        Assert.Same(parent, NarrowingState.JoinTypes(path, []TypeSymbol{source, parent}))
        Assert.Same(parent, NarrowingState.JoinTypes(path, []TypeSymbol{parent, source}))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SourceClrInterface_PreservesDispatchIdentityAndReceiverOnce(inherited bool) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import UpcastControl
open class Resource : IDisposable {
    func Dispose() { Console.Write("D") }
}
class Derived : Resource {}
shared class Counts { var Receivers int32 = 0 }
func Target(value @TYPE@) @TYPE@ {
    Counts.Receivers += 1
    Console.Write("R")
    return value
}
func Main() {
    let value = @TYPE@()
    let view IDisposable = Target(value)
    view.Dispose()
    Console.Write(Counts.Receivers)
    Console.Write(Object.ReferenceEquals(view, value))
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`.Replace(
            "@TYPE@",
            if inherited {
                "Derived"
            } else {
                "Resource"
            }
        )
        let oracle = `using System;
using UpcastControl;
class Resource : IDisposable { public void Dispose() { Console.Write("D"); } }
class Derived : Resource {}
class Program {
    static int receivers;
    static @TYPE@ Target(@TYPE@ value) { receivers++; Console.Write("R"); return value; }
    static void Main() {
        var value = new @TYPE@();
        IDisposable view = Target(value);
        view.Dispose();
        Console.Write(receivers);
        Console.Write(Object.ReferenceEquals(view, value));
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`.Replace(
            "@TYPE@",
            if inherited {
                "Derived"
            } else {
                "Resource"
            }
        )
        Check(fixture, source, oracle, "RD1True1")
    }

    @Fact
    func SourceConstructedBaseJoin_PreservesValidBaseMember() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import UpcastControl
open class Parent[T] { func Read() int32 -> 7 }
class Child : Parent[int32] {}
func Read(value object, flag bool) int32 {
    if flag {
        if value !is Child { return 0 }
    } else {
        if value !is Parent[int32] { return 0 }
    }
    return value.Read()
}
func Main() {
    let value = Child()
    Console.Write(Read(value, true))
    Console.Write(Read(value, false))
    let boxed object = value
    Console.Write(Object.ReferenceEquals(boxed, value))
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`
        let oracle = `using System;
using UpcastControl;
class Parent<T> { public int Read() => 7; }
class Child : Parent<int> {}
class Program {
    static int Read(object value, bool flag) {
        if (flag) { if (value is not Child) return 0; }
        else if (value is not Parent<int>) return 0;
        return ((Parent<int>)value).Read();
    }
    static void Main() {
        var value = new Child();
        Console.Write(Read(value, true));
        Console.Write(Read(value, false));
        object boxed = value;
        Console.Write(Object.ReferenceEquals(boxed, value));
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`
        Check(fixture, source, oracle, "77True1")
    }

    @Fact
    func SourceConstructedBase_RejectsWrongOwner() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let result = Compile(
            fixture,
            "open class Parent[T] {}\nclass Child : Parent[int32] {}\n" +
                "func Up(value Child) Parent[string] -> value\nfunc Main() {}\n"
        )
        Assert.NotEqual(0, result.Code)
        let error = Assert.Single(
            Regex.Matches(
                Encoding.UTF8.GetString(result.Bytes) + result.Error,
                `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`
            )
        )
        Assert.Equal("GS0155", error.Groups[5].Value)
        Assert.Equal("3", error.Groups[1].Value)
        Assert.Equal("40", error.Groups[2].Value)
        Assert.Equal("3", error.Groups[3].Value)
        Assert.Equal("45", error.Groups[4].Value)
        for path in[]string{"Consumer.dll", "Consumer.ref.dll", "Consumer.pdb"} {
            Assert.False(File.Exists(Path.Combine(fixture.DirectoryPath, path)))
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SourceStruct_UpcastsToImportedUnmanagedBase(nullable bool) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import UpcastControl
struct Payload { var Value uint32 }
class Derived : Base[Payload] {}
func Main() {
    let value = Derived()
    System.Console.Write(Base[Payload].Read(value))
` + (
            if nullable {
                `    let present Base[Payload]? = value
    System.Console.Write(System.Object.ReferenceEquals(present, value))
    let missing Base[Payload]? = nil
    System.Console.Write(missing == nil)
`
            } else {
                ""
            }
        ) + "}\n"
        let oracle = `using UpcastControl;
struct Payload { public uint Value; }
class Derived : Base<Payload> {}
class Program {
    static void Main() {
        var value = new Derived();
        System.Console.Write(Base<Payload>.Read(value));
` + (
            if nullable {
                `        Base<Payload>? present = value;
        System.Console.Write(System.Object.ReferenceEquals(present, value));
        Base<Payload>? missing = null;
        System.Console.Write(missing == null);
`
            } else {
                ""
            }
        ) + `    }
    }
`
        Check(
            fixture,
            source,
            oracle,
            if nullable {
                "1TrueTrue"
            } else {
                "1"
            }
        )
    }

    @Fact
    func ReorderedImportedOwner_PreservesIdentityDispatchAndNilContracts() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        Check(fixture, `import UpcastControl
import System
struct Payload { var Value uint32 }
open class Derived[T] : Forward[T] {
    override func Tag() int32 {
        Console.Write("V")
        return 7
    }
}
class Leaf : Derived[Payload] {}
shared class Counts { var Receivers int32 = 0 }
func Target(value Leaf) Leaf {
    Counts.Receivers += 1
    Console.Write("R")
    return value
}
func Up[T](value Derived[T]) Pair[string, T] -> value
func Main() {
    let value = Leaf()
    let parent Pair[string, Payload] = Up[Payload](Target(value))
    Console.Write(Pair[string, Payload].Read(parent))
    Console.Write("|")
    Console.Write(Counts.Receivers)
    Console.Write("|")
    Console.Write(Object.ReferenceEquals(parent, value))
    let missing Pair[string, Payload]? = nil
    Console.Write("|")
    Console.Write(Pair[string, Payload].IsNil(missing))
    Console.Write("|")
    Console.Write(Pair[string, Payload].IsNil(value))
}
`, `using UpcastControl;
using System;
struct Payload { public uint Value; }
class Derived<T> : Forward<T> {
    public override int Tag() { Console.Write("V"); return 7; }
}
class Leaf : Derived<Payload> {}
class Program {
    static int receivers;
    static Leaf Target(Leaf value) { receivers++; Console.Write("R"); return value; }
    static Pair<string,T> Up<T>(Derived<T> value) => value;
    static void Main() {
        var value = new Leaf();
        Pair<string,Payload> parent = Up<Payload>(Target(value));
        Console.Write(Pair<string,Payload>.Read(parent));
        Console.Write("|");
        Console.Write(receivers);
        Console.Write("|");
        Console.Write(Object.ReferenceEquals(parent, value));
        Pair<string,Payload>? missing = null;
        Console.Write("|");
        Console.Write(Pair<string,Payload>.IsNil(missing));
        Console.Write("|");
        Console.Write(Pair<string,Payload>.IsNil(value));
    }
}
`, "RV7|1|True|True|False")
    }

    @Theory
    @InlineData("class Derived : Base[Payload] {}", "Base[Other]", "Derived()")
    @InlineData("class Derived : Base[Other] {}", "Base[Payload]", "Derived()")
    @InlineData("class Derived {}", "Base[Payload]", "Derived()")
    @InlineData("class Derived : Forward[Payload] {}", "Pair[Payload, string]", "Derived()")
    @InlineData("class Derived : Forward[Payload] {}", "Pair[string, Payload]", "nil as Pair[string, Payload]")
    func RejectsWrongIdentityAndGenericInstantiation(declaration string, target string, initializer string) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = "import UpcastControl\nstruct Payload { var Value uint32 }\n" +
            "struct Other { var Value uint32 }\n" +
            declaration +
            "\nfunc Main() {\n    let value = " +
            initializer +
            "\n    let rejected " +
            target +
            " = value\n}\n"
        let result = Compile(fixture, source)
        Assert.NotEqual(0, result.Code)
        let errors = Regex.Matches(
            Encoding.UTF8.GetString(result.Bytes) + result.Error,
            `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`
        )
        let error = Assert.Single(errors)
        Assert.Equal("GS0155", error.Groups[5].Value)
        Assert.Equal("7", error.Groups[1].Value)
        let column = (5 + "let rejected ".Length + target.Length + " = ".Length).ToString()
        Assert.Equal(column, error.Groups[2].Value)
        Assert.Equal("7", error.Groups[3].Value)
        Assert.Equal((int32.Parse(column) + 5).ToString(), error.Groups[4].Value)
        for path in[]string{"Consumer.dll", "Consumer.ref.dll", "Consumer.pdb"} {
            Assert.False(File.Exists(Path.Combine(fixture.DirectoryPath, path)))
        }
    }

    @Theory
    @InlineData("Reader", "int32")
    @InlineData("Writer", "int32")
    @InlineData("Reader", "Payload")
    @InlineData("Writer", "Payload")
    @InlineData("in chan", "int32")
    @InlineData("out chan", "int32")
    @InlineData("in chan", "Payload")
    @InlineData("out chan", "Payload")
    func SourceClass_DoesNotInheritReferenceChangingProjection(view string, element string) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let target = if view == "Reader" || view == "Writer" {
            "Channel" + view
        } else {
            view
        }
        let declaration = "func View(value Wrap) " + target + "[" + element + "] -> "
        let source = "import System.Threading.Channels\nstruct Payload { var Value uint32 }\n" +
            "class Wrap : Channel[" +
            element +
            "] {}\n" +
            declaration +
            "value\nfunc Main() {}\n"
        let result = Compile(fixture, source, RuntimeReferences())
        Assert.NotEqual(0, result.Code)
        let errors = Regex.Matches(
            Encoding.UTF8.GetString(result.Bytes) + result.Error,
            `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`
        )
        let error = Assert.Single(errors)
        Assert.Equal("GS0155", error.Groups[5].Value)
        Assert.Equal("4", error.Groups[1].Value)
        Assert.Equal((declaration.Length + 1).ToString(), error.Groups[2].Value)
        Assert.Equal("4", error.Groups[3].Value)
        Assert.Equal((declaration.Length + 6).ToString(), error.Groups[4].Value)
        for path in[]string{"Consumer.dll", "Consumer.ref.dll", "Consumer.pdb"} {
            Assert.False(File.Exists(Path.Combine(fixture.DirectoryPath, path)))
        }
    }

    @Theory
    @InlineData("Reader")
    @InlineData("Writer")
    func DirectChannelProjection_UsesGetterAndPreservesNominalBaseUpcast(view string) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import System.Threading.Channels
import UpcastControl
class Wrap : Channel[int32] {}
shared class Counts { var Receivers int32 = 0 }
func Target(value Channel[int32]) Channel[int32] {
    Counts.Receivers += 1
    Console.Write("R")
    return value
}
func View(value Channel[int32]) Channel@VIEW@[int32] -> value
func Up(value Wrap) Channel[int32] -> value
func Main() {
    let channel = Channel.CreateUnbounded[int32]()
    let view = View(Target(channel))
    Console.Write(Object.ReferenceEquals(view, channel.@VIEW@))
    Console.Write("|")
    Console.Write(Counts.Receivers)
    Console.Write("|")
    @TRANSFER@
    Console.Write(value)
    Console.Write("|")
    let wrap = Wrap()
    Console.Write(Object.ReferenceEquals(Up(wrap), wrap))
    Console.Write("|")
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`.Replace("@VIEW@", view).Replace(
            "@TRANSFER@",
            if view == "Reader" {
                "Console.Write(channel.Writer.TryWrite(37))\n    Console.Write(view.TryRead(out var value))"
            } else {
                "Console.Write(view.TryWrite(37))\n    Console.Write(channel.Reader.TryRead(out var value))"
            }
        )
        let oracle = `using System;
using System.Threading.Channels;
using UpcastControl;
class Wrap : Channel<int> {}
class Program {
    static int receivers;
    static Channel<int> Target(Channel<int> value) { receivers++; Console.Write("R"); return value; }
    static Channel@VIEW@<int> View(Channel<int> value) => value.@VIEW@;
    static Channel<int> Up(Wrap value) => value;
    static void Main() {
        var channel = Channel.CreateUnbounded<int>();
        var view = View(Target(channel));
        Console.Write(Object.ReferenceEquals(view, channel.@VIEW@));
        Console.Write("|");
        Console.Write(receivers);
        Console.Write("|");
        @TRANSFER@
        Console.Write(value);
        Console.Write("|");
        var wrap = new Wrap();
        Console.Write(Object.ReferenceEquals(Up(wrap), wrap));
        Console.Write("|");
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`.Replace("@VIEW@", view).Replace(
            "@TRANSFER@",
            if view == "Reader" {
                "Console.Write(channel.Writer.TryWrite(37));\n        Console.Write(view.TryRead(out var value));"
            } else {
                "Console.Write(view.TryWrite(37));\n        Console.Write(channel.Reader.TryRead(out var value));"
            }
        )
        Check(fixture, source, oracle, "RTrue|1|TrueTrue37|True|1", RuntimeReferences())
    }

    @Theory
    @InlineData("Reader", "in chan")
    @InlineData("Writer", "out chan")
    func NativeChannelProjection_UsesGetterAndPreservesSymbolicNominalUpcast(view string, alias string) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import System.Threading.Channels
import UpcastControl
struct Payload { var Value int32 }
class Wrap : Channel[Payload] {}
shared class Counts { var Receivers int32 = 0 }
func Target(value chan[Payload]) chan[Payload] {
    Counts.Receivers += 1
    Console.Write("R")
    return value
}
func View(value chan[Payload]) @ALIAS@[Payload] -> value
func Up(value Wrap) chan[Payload] -> value
func Main() {
    let channel = Channel.CreateUnbounded[Payload]()
    let view = View(Target(channel))
    Console.Write(Object.ReferenceEquals(view, channel.@VIEW@))
    Console.Write("|")
    Console.Write(Counts.Receivers)
    Console.Write("|")
    @TRANSFER@
    Console.Write(value.Value)
    Console.Write("|")
    let wrap = Wrap()
    Console.Write(Object.ReferenceEquals(Up(wrap), wrap))
    Console.Write("|")
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`.Replace(
            "@ALIAS@",
            alias
        ).Replace(
            "@VIEW@",
            view
        ).Replace(
            "@TRANSFER@",
            if view == "Reader" {
                "Console.Write(channel.Writer.TryWrite(Payload{Value: 37}))\n    Console.Write(view.TryRead(out var value))"
            } else {
                "Console.Write(view.TryWrite(Payload{Value: 37}))\n    Console.Write(channel.Reader.TryRead(out var value))"
            }
        )
        let oracle = `using System;
using System.Threading.Channels;
using UpcastControl;
struct Payload { public int Value; }
class Wrap : Channel<Payload> {}
class Program {
    static int receivers;
    static Channel<Payload> Target(Channel<Payload> value) { receivers++; Console.Write("R"); return value; }
    static Channel@VIEW@<Payload> View(Channel<Payload> value) => value.@VIEW@;
    static Channel<Payload> Up(Wrap value) => value;
    static void Main() {
        var channel = Channel.CreateUnbounded<Payload>();
        var view = View(Target(channel));
        Console.Write(Object.ReferenceEquals(view, channel.@VIEW@));
        Console.Write("|");
        Console.Write(receivers);
        Console.Write("|");
        @TRANSFER@
        Console.Write(value.Value);
        Console.Write("|");
        var wrap = new Wrap();
        Console.Write(Object.ReferenceEquals(Up(wrap), wrap));
        Console.Write("|");
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`.Replace("@VIEW@", view).Replace(
            "@TRANSFER@",
            if view == "Reader" {
                "Console.Write(channel.Writer.TryWrite(new Payload {Value = 37}));\n        Console.Write(view.TryRead(out var value));"
            } else {
                "Console.Write(view.TryWrite(new Payload {Value = 37}));\n        Console.Write(channel.Reader.TryRead(out var value));"
            }
        )
        Check(fixture, source, oracle, "RTrue|1|TrueTrue37|True|1", RuntimeReferences())
    }

    @Theory
    @InlineData("Closed")
    @InlineData("Middle")
    func SourceClass_UpcastsThroughClosedImportedBase(parent string) {
        using let fixture = CSharpFixture(ClosedContract, assemblyName: "ClosedContract", deterministic: true)
        let source = `import System
import ClosedControl
class Derived : @PARENT@ {
    override func Tag() int32 {
        Console.Write("V")
        return 9
    }
}
shared class Counts { var Receivers int32 = 0 }
func Target(value Derived) Derived {
    Counts.Receivers += 1
    Console.Write("R")
    return value
}
func Up(value Derived) Base[int32] -> value
func Main() {
    let value = Derived()
    let parent = Up(Target(value))
    Console.Write(Base[int32].Read(parent))
    Console.Write("|")
    Console.Write(Counts.Receivers)
    Console.Write("|")
    Console.Write(Object.ReferenceEquals(parent, value))
}
`.Replace("@PARENT@", parent)
        let oracle = `using System;
using ClosedControl;
class Derived : @PARENT@ {
    public override int Tag() { Console.Write("V"); return 9; }
}
class Program {
    static int receivers;
    static Derived Target(Derived value) { receivers++; Console.Write("R"); return value; }
    static Base<int> Up(Derived value) => value;
    static void Main() {
        var value = new Derived();
        var parent = Up(Target(value));
        Console.Write(Base<int>.Read(parent));
        Console.Write("|");
        Console.Write(receivers);
        Console.Write("|");
        Console.Write(Object.ReferenceEquals(parent, value));
    }
}
`.Replace("@PARENT@", parent)
        Check(fixture, source, oracle, "RV9|1|True", contractSource: ClosedContract)
    }

    @Theory
    @InlineData("Closed", "string")
    @InlineData("Middle", "uint32")
    func ClosedImportedBase_RejectsMismatchedOwner(parent string, argument string) {
        using let fixture = CSharpFixture(ClosedContract, assemblyName: "ClosedContract", deterministic: true)
        output.WriteLine("Contract source:\n" + ClosedContract)
        let declaration = "func Up(value Derived) Base[" + argument + "] -> "
        let source = "import ClosedControl\nclass Derived : " +
            parent +
            " {}\n" +
            declaration +
            "value\nfunc Main() {}\n"
        let result = Compile(fixture, source)
        Assert.NotEqual(0, result.Code)
        let errors = Regex.Matches(
            Encoding.UTF8.GetString(result.Bytes) + result.Error,
            `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`
        )
        let error = Assert.Single(errors)
        Assert.Equal("GS0155", error.Groups[5].Value)
        Assert.Equal("3", error.Groups[1].Value)
        Assert.Equal((declaration.Length + 1).ToString(), error.Groups[2].Value)
        Assert.Equal("3", error.Groups[3].Value)
        Assert.Equal((declaration.Length + 6).ToString(), error.Groups[4].Value)
        for path in[]string{"Consumer.dll", "Consumer.ref.dll", "Consumer.pdb"} {
            Assert.False(File.Exists(Path.Combine(fixture.DirectoryPath, path)))
        }
    }

    @Fact
    func RuntimeReferenceDiscovery_ExcludesUntrustedFiles() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let unmanaged = Path.Combine(fixture.DirectoryPath, "not-managed.dll")
        File.WriteAllBytes(unmanaged, []uint8{0, 1, 2, 3})
        Assert.NotEmpty(RuntimeReferences())
        Assert.Contains(typeof(object).Assembly.Location, RuntimeReferences())
        Assert.True(File.Exists(fixture.AssemblyPath))
        Assert.True(File.Exists(unmanaged))
        Assert.Empty(RuntimeReferences(fixture.DirectoryPath))
    }

    private func Check(
        fixture CSharpFixture,
        source string,
        oracle string,
        expected string,
        references IEnumerable[string]? = nil,
        contractSource string? = nil
    ) {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
        output.WriteLine("Contract source:\n" + (contractSource ?? Contract))
        output.WriteLine("Oracle source:\n" + oracle)
        let result = Compile(fixture, source, references)
        Assert.True(result.Code == 0, Encoding.UTF8.GetString(result.Bytes) + result.Error)
        Assert.Empty(result.Error)
        let image = Path.Combine(fixture.DirectoryPath, "Consumer.dll")
        let paths = []string{
            image,
            Path.Combine(fixture.DirectoryPath, "Consumer.ref.dll"),
            Path.Combine(fixture.DirectoryPath, "Consumer.pdb")
        }
        let bytes = paths.Select((path string) -> File.ReadAllBytes(path)).ToArray()
        for content in bytes {
            Assert.NotEmpty(content)
        }
        let repeat = Compile(fixture, source, references)
        Assert.Equal(0, repeat.Code)
        Assert.Equal(result.Bytes, repeat.Bytes)
        Assert.Equal(result.Error, repeat.Error)
        for var index = 0; index < paths.Length; index++ {
            Assert.Equal(bytes[index], File.ReadAllBytes(paths[index]))
        }
        let oraclePath = Path.Combine(fixture.DirectoryPath, "Oracle.dll")
        let compilation = CSharpCompilation.Create(
            "Oracle",
            []SyntaxTree{CSharpSyntaxTree.ParseText(oracle)},
            RuntimeReferences().Concat([]string{fixture.AssemblyPath}).Select(
                (path string) -> MetadataReference.CreateFromFile(path)
            ),
            CSharpCompilationOptions(
                OutputKind.ConsoleApplication,
                nullableContextOptions: NullableContextOptions.Enable,
                deterministic: true
            )
        )
        let emitted = compilation.Emit(oraclePath)
        Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics))
        for path in paths.Concat([]string{oraclePath}) {
            RecordArtifact(path)
        }
        File.Copy(
            Path.ChangeExtension(image, ".runtimeconfig.json"),
            Path.ChangeExtension(oraclePath, ".runtimeconfig.json")
        )
        Verify(fixture.AssemblyPath, nil)
        Verify(image, fixture.AssemblyPath)
        Verify(oraclePath, fixture.AssemblyPath)
        let missing = VerifyResult(image, nil)
        Assert.NotEqual(0, missing.Code)
        Assert.Contains(
            Path.GetFileNameWithoutExtension(fixture.AssemblyPath),
            Encoding.UTF8.GetString(missing.Bytes) + missing.Error,
            StringComparison.Ordinal
        )
        for executable in[]string{image, oraclePath} {
            let executed = Run([]string{executable})
            Assert.Equal(0, executed.Code)
            Assert.Empty(executed.Error)
            Assert.Equal(Encoding.UTF8.GetBytes(expected), executed.Bytes)
        }
    }

    private func Compile(fixture CSharpFixture, source string, references IEnumerable[string]? = nil)(
        Code int32,
        Bytes[]uint8,
        Error string
    ) {
        let path = Path.Combine(fixture.DirectoryPath, "Consumer.gs")
        File.WriteAllText(path, source)
        output.WriteLine("G# source:\n" + source)
        RecordArtifact(fixture.AssemblyPath)
        RecordArtifact(typeof(Issue5388ImportedBaseUpcastDriverTests).Assembly.Location)
        RecordArtifact(typeof(Program).Assembly.Location)
        RecordArtifact(Path.Combine(Path.GetDirectoryName(typeof(Program).Assembly.Location)!!, "GSharp.Core.dll"))
        let arguments = List[string]{
            typeof(Program).Assembly.Location,
            path,
            "/target:exe",
            "/targetframework:net10.0",
            "/deterministic+",
            "/debug:portable",
            "/out:" + Path.Combine(fixture.DirectoryPath, "Consumer.dll"),
            "/refout:" + Path.Combine(fixture.DirectoryPath, "Consumer.ref.dll"),
            "/reference:" + fixture.AssemblyPath
        }
        if references != nil {
            arguments.AddRange(references.Select((reference string) -> "/reference:" + reference))
        }
        return Run(arguments)
    }

    private func Verify(image string, contract string?) {
        let verified = VerifyResult(image, contract)
        Assert.True(verified.Code == 0, Encoding.UTF8.GetString(verified.Bytes) + verified.Error)
        Assert.Empty(verified.Error)
    }

    private func VerifyResult(image string, contract string?)(Code int32, Bytes[]uint8, Error string) {
        let arguments = List[string]{"tool", "run", "ilverify", "--", image, "-s", "System.Private.CoreLib"}
        for path in RuntimeReferences() {
            arguments.Add("-r")
            arguments.Add(path)
        }
        if contract != nil {
            arguments.Add("-r")
            arguments.Add(contract)
        }
        return Run(arguments)
    }

    private func Run(arguments IEnumerable[string])(Code int32, Bytes[]uint8, Error string) {
        let start = ProcessStartInfo("dotnet"){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        for argument in arguments {
            start.ArgumentList.Add(argument)
        }
        output.WriteLine("argv: dotnet " + string.Join(" ", arguments))
        output.WriteLine("cwd: " + Environment.CurrentDirectory)
        for name in start.Environment.Keys.OrderBy((name string) -> name, StringComparer.Ordinal) {
            if name == "PATH" || name == "HOME" || name == "TMPDIR" || name.StartsWith(
                "DOTNET_",
                StringComparison.Ordinal
            ) ||
                name.StartsWith("GSHARP_", StringComparison.Ordinal) {
                output.WriteLine("env " + name + "=" + start.Environment[name])
            }
        }
        using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
        using let stdout = MemoryStream()
        let read = process.StandardOutput.BaseStream.CopyToAsync(stdout)
        let error = process.StandardError.ReadToEndAsync()
        let exited = process.WaitForExit(30_000)
        if !exited {
            process.Kill(entireProcessTree: true)
        }
        process.WaitForExit()
        read.GetAwaiter().GetResult()
        let stderr = error.GetAwaiter().GetResult()
        output.WriteLine(
            "exit: " + process.ExitCode.ToString() + "; stdout hex: " + Convert.ToHexString(stdout.ToArray()) +
                "; stderr: " +
                stderr
        )
        Assert.True(exited, "Imported-base driver exceeded 30 seconds.")
        return (process.ExitCode, stdout.ToArray(), stderr)
    }

    private func RecordArtifact(path string) -> output.WriteLine(
        "SHA256 " + path + ": " + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))
    )

    shared {
        private func RuntimeReferences(runtime string? = nil)[]string {
            let directory = runtime ?? Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            return ReferenceResolver
                .HostTrustedPlatformAssemblyPaths()
                .Where((path string) -> Path.GetDirectoryName(path) == directory)
                .OrderBy((path string) -> path, StringComparer.Ordinal)
                .ToArray()
        }

        private const ClosedContract string = `#nullable enable
namespace ClosedControl {
    public class Base<T> {
        public virtual int Tag() => 3;
        public static int Read(Base<T> value) => value.Tag();
    }
    public class Closed : Base<int> {}
    public class Reordered<A,B> : Base<B> {}
    public class Middle : Reordered<string,int> {}
}
`

        private const Contract string = `#nullable disable
namespace UpcastControl {
    public class Base<T> where T : unmanaged {
        public static int Read(Base<T> value) => 1;
    }
#nullable enable
    public class Pair<A, B> {
        public virtual int Tag() => 3;
        public static int Read(Pair<A,B> value) => value.Tag();
        public static bool IsNil(Pair<A,B>? value) => value is null;
    }
    public class Forward<T> : Pair<string, T> { }
}
`
    }
}
