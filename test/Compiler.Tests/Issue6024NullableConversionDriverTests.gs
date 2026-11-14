package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Text
import System.Text.RegularExpressions
import Xunit

open class Issue6024NullableConversionDriverTests {
    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func NullableSource_PreservesNullAndArgumentOrder(inBody bool, explicitConversion bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let native = fixture.CompileCSharpExecutable(`#nullable enable
using System;
public class Node {
    public static implicit operator string(Node? value) {
        Console.Write(value is null ? "n" : "v");
        return "ok";
    }
}
public static class Control {
    static Node? Source(Node? value) { Console.Write("s"); return value; }
    static int After() { Console.Write("a"); return 0; }
    static void Take(string value, int unused) { Console.Write(value); }
    public static void Main() {
        Node? none = null;
        Take(Source(none), After());
        Node? some = new Node();
        Take(Source(some), After());
        Console.Write(string.IsNullOrEmpty(Source(none)));
    }
}`, "Native6024")
        let keyword = if explicitConversion {
            "explicit"
        } else {
            "implicit"
        }
        let op = "func operator " + keyword + `(value Node?) string {
    Console.Write(if value == nil { "n" } else { "v" })
    return "ok"
}`
        let declaration = if inBody {
            "open class Node {\n" + op + "\n}"
        } else {
            "open class Node {}\n" + op
        }
        let source = "import System\n" + declaration + `
func Source(value Node?) Node? {
    Console.Write("s")
    return value
}
func After() int32 {
    Console.Write("a")
    return 0
}
func Take(value string, unused int32) { Console.Write(value) }
func Main() {
    let none Node? = nil
    Take(FIRST, After())
    let some Node? = Node{}
    Take(SECOND, After())
    Console.Write(string.IsNullOrEmpty(FIRST))
}`.Replace(
            "FIRST",
            if explicitConversion {
                "string(Source(none))"
            } else {
                "Source(none)"
            }
        )
            .Replace(
            "SECOND",
            if explicitConversion {
                "string(Source(some))"
            } else {
                "Source(some)"
            }
        )
        let (code, log, dll) = Compile(fixture, source, executable: true)
        Assert.True(code == 0, log)
        IlVerifier.Verify(dll)
        IlVerifier.Verify(native)
        File.Copy(Path.ChangeExtension(dll, ".runtimeconfig.json"), Path.ChangeExtension(native, ".runtimeconfig.json"))
        let expected = Encoding.UTF8.GetBytes("snaoksvaoksnFalse")
        Assert.Equal(expected, fixture.RunBytes(native))
        Assert.Equal(expected, fixture.RunBytes(dll))
        let assembly = Assembly.Load(File.ReadAllBytes(dll))
        let method = assembly
            .GetTypes()
            .Single((type Type) -> type.Name == "Node")
            .GetMethod(
            "op_" + if explicitConversion {
                "Explicit"
            } else {
                "Implicit"
            }
        )!!
        Assert.Equal(NullabilityState.Nullable, NullabilityInfoContext().Create(method.GetParameters()[0]).ReadState)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NullableGenericTarget_PreservesOwnerAndReturnContract(inBody bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let op = "func operator implicit(value string) Node[T]? -> nil"
        let declaration = if inBody {
            "open class Node[T] {\n" + op + "\n}"
        } else {
            "open class Node[T] {}\n" + op
        }
        let (code, log, dll) = Compile(fixture, "import System\n" + declaration + `
struct Count {
    func operator implicit(value Count) int32? -> nil
}
func Main() {
    let value Node[string]? = "null"
    Console.Write(value == nil)
    let count int32? = Count{}
    Console.Write(count == nil)
}`, executable: true)
        Assert.True(code == 0, log)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("TrueTrue"), fixture.RunBytes(dll))
        let assembly = Assembly.Load(File.ReadAllBytes(dll))
        let owner = assembly.GetTypes().Single((type Type) -> type.Name == "Node`1")
        let method = owner.GetMethod("op_Implicit")!!
        Assert.Equal(owner, method.DeclaringType)
        Assert.Equal(NullabilityState.Nullable, NullabilityInfoContext().Create(method.ReturnParameter).ReadState)
    }

    @Theory
    @InlineData("func operator implicit(value Node?) Node -> Node{}", "GS0394@2,6,2,17")
    @InlineData("func operator implicit(value Node) Node? -> value", "GS0394@2,6,2,17")
    @InlineData("func operator implicit(value Other?) string -> \"bad\"", "GS0394@2,6,2,17")
    @InlineData("func operator implicit(value string?) string -> \"bad\"", "GS0394@2,6,2,17")
    @InlineData(
        "func operator implicit(value Node) string -> \"first\"\nfunc operator explicit(value Node?) string -> \"second\"",
        "GS0395@3,6,3,17"
    )
    @InlineData(
        "func operator implicit(value string) Node -> Node{}\nfunc operator explicit(value string) Node? -> nil",
        "GS0395@3,6,3,17"
    )
    func InvalidOwnersAndErasedSignatures_KeepExactDiagnostics(operators string, expected string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, log, dll) = Compile(fixture, "open class Node {\n" + operators + "\n}\nclass Other {}")
        Assert.NotEqual(0, code)
        let errors = Regex.Matches(log, `\((\d+,\d+,\d+,\d+)\): error (GS\d+):`)
        let error = Assert.Single(errors)
        Assert.Equal(expected, error.Groups[2].Value + "@" + error.Groups[1].Value)
        Assert.False(File.Exists(dll), log)
    }

    shared {
        private func Compile(fixture NativeSliceLanguageTests.Fixture, source string, executable bool = false)(
            Code int32,
            Log string,
            Dll string
        ) {
            let sourcePath = Path.Combine(fixture.Directory, "Test6024.gs")
            let dll = Path.Combine(fixture.Directory, "Test6024.dll")
            File.WriteAllText(sourcePath, source)
            let compiler = typeof(Program).Assembly.Location
            let start = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            start.ArgumentList.Add("exec")
            start.ArgumentList.Add("--runtimeconfig")
            start.ArgumentList.Add(
                Path.ChangeExtension(
                    typeof(Issue6024NullableConversionDriverTests).Assembly.Location,
                    ".runtimeconfig.json"
                )
            )
            start.ArgumentList.Add(compiler)
            start.ArgumentList.Add("/targetframework:net10.0")
            start.ArgumentList.Add(
                if executable {
                    "/target:exe"
                } else {
                    "/target:library"
                }
            )
            start.ArgumentList.Add("/out:" + dll)
            start.ArgumentList.Add(sourcePath)
            let (code, stdout, stderr) = IlVerifier.RunProcess(start, compiler, 30_000)
            return (code, stdout + stderr, dll)
        }
    }
}
