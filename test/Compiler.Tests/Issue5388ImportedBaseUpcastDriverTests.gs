package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
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
    func SourceClass_DoesNotInheritReferenceChangingProjection(view string, element string) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let declaration = "func View(value Wrap) Channel" + view + "[" + element + "] -> "
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

    private func Check(
        fixture CSharpFixture,
        source string,
        oracle string,
        expected string,
        references IEnumerable[string]? = nil
    ) {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
        output.WriteLine("Contract source:\n" + Contract)
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
            "UpcastContract",
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
        for name in[]string{"PATH", "DOTNET_ROOT", "DOTNET_ROLL_FORWARD", "GSHARP_SKIP_ILVERIFY"} {
            output.WriteLine("env " + name + "=" + Environment.GetEnvironmentVariable(name))
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
        private func RuntimeReferences()[]string {
            let runtime = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            return Directory.GetFiles(runtime, "*.dll").OrderBy((path string) -> path, StringComparer.Ordinal).ToArray()
        }

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
