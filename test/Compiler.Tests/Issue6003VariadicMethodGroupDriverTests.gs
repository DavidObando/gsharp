package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue6003VariadicMethodGroupDriverTests {
    @Theory
    @InlineData("string", "[]string", "[]string")
    @InlineData("List[string]", "List[string]", "List[string]")
    @InlineData("IEnumerable[string]", "IEnumerable[string]", "[]string")
    func PhysicalCarrierGroups_PreserveIdentityAndDirectCallForms(
        declaration string,
        carrier string,
        construction string
    ) {
        using let driver = Driver()
        driver.Check(`import System
import System.Collections.Generic
import System.Linq
func Count(items ...DECLARATION) int32 -> items.Count()
func Identity(items ...DECLARATION) CARRIER -> items
delegate Named(items CARRIER) int32;
let callback (CARRIER) -> int32 = Count
let identity (CARRIER) -> CARRIER = Identity
let named Named = Count
let imported Func[CARRIER, int32] = Count
let inferred = Count
let items CARRIER = CONSTRUCTION{"x"}
Console.Write(callback(items))
Console.Write("|")
Console.Write(Count(items))
Console.Write("|")
Console.Write(Count("x", "y"))
Console.Write("|")
Console.Write(Count())
Console.Write("|")
Console.Write(object.ReferenceEquals(items, identity(items)))
Console.Write("|")
Console.Write(callback.Method.Name)
Console.Write("|")
Console.Write(callback.Target == nil)
Console.Write("|")
Console.Write(named(items))
Console.Write(imported(items))
Console.Write(inferred(items))
`.Replace(
                "DECLARATION",
                declaration
            ).Replace("CARRIER", carrier).Replace("CONSTRUCTION", construction), "1|1|2|0|True|Count|True|111")
    }

    @Fact
    func TranslatedSharedClassField_UsesTheDeclaredVariadicMethod() {
        using let driver = Driver()
        driver.Check(`import System
import System.Collections.Generic

shared class P {
    private func Count(items ...List[string]) int32 -> items.Count
    private let callback(List[string]) -> int32 = Count

    func Main() -> Console.Write(callback(List[string]{"x"}))
}
`, "1")
    }

    @Fact
    func MemberGroups_KeepReceiversConstructedGenericsAndOverloadIdentity() {
        using let driver = Driver()
        driver.Check(`import System
import System.Collections.Generic
class Counter[T] {
    var offset int32
    func Count(items ...List[T]) int32 -> offset + items.Count
    func Count(items ...T) int32 -> 99
    func Bare() (List[T]) -> int32 -> Count
    shared {
        func Static(items ...List[T]) int32 -> items.Count + 10
        func BareStatic() (List[T]) -> int32 -> Static
    }
}
var reads = 0
let owner = Counter[string]{offset: 20}
func Next() Counter[string] {
    reads++
    return owner
}
func Generic[T](items ...List[T]) int32 -> items.Count + 30
func Pick(items ...List[string]) int32 -> items.Count + 40
func Pick(items ...string) int32 -> 99
func Use(f (List[string]) -> int32) int32 -> f(List[string]{"x"})
let instance (List[string]) -> int32 = Next().Count
let staticGroup (List[string]) -> int32 = Counter[string].Static
let generic (List[string]) -> int32 = Generic
let pick (List[string]) -> int32 = Pick
Console.Write(reads)
Console.Write("|")
Console.Write(Use(instance))
Console.Write("|")
Console.Write(Use(owner.Bare()))
Console.Write("|")
Console.Write(Use(staticGroup))
Console.Write("|")
Console.Write(Use(Counter[string].BareStatic()))
Console.Write("|")
Console.Write(Use(generic))
Console.Write("|")
Console.Write(Use(pick))
Console.Write("|")
Console.Write(object.ReferenceEquals(instance.Target, owner))
Console.Write("|")
Console.Write(instance.Method.Name)
Console.Write("|")
Console.Write(staticGroup.Target == nil)
Console.Write("|")
Console.Write(Use(Next().Count))
Console.Write("|")
Console.Write(reads)
`, "1|21|21|11|11|31|41|True|Count|True|21|2")
    }

    @Theory
    @InlineData(false, false, false)
    @InlineData(false, false, true)
    @InlineData(false, true, false)
    @InlineData(false, true, true)
    @InlineData(true, false, false)
    @InlineData(true, false, true)
    @InlineData(true, true, false)
    @InlineData(true, true, true)
    func InferredStaticGroups_KeepNaturalTypesAndClosedOwners(generic bool, variadic bool, qualified bool) {
        using let driver = Driver()
        let self = if generic {
            "Counter[T]"
        } else {
            "Counter"
        }
        driver.Check(`import System
import System.Collections.Generic
class SELF {
    shared {
        func Count(items VARIADICList[ELEMENT]) int32 -> items.Count
        func Run(items List[ELEMENT]) {
            let callback = GROUP
            Console.Write(callback(items))
            Console.Write("|")
            Console.Write(callback.Method.Name)
            Console.Write("|")
            Console.Write(callback.Target == nil)
            Console.Write("|")
            Console.Write(callback.Method.DeclaringType == typeof(SELF))
        }
    }
}
CLOSED.Run(List[string]{"x"})
`.Replace(
                "SELF",
                self
            ).Replace(
                "VARIADIC",
                if variadic {
                    "..."
                } else {
                    ""
                }
            ).Replace(
                "ELEMENT",
                if generic {
                    "T"
                } else {
                    "string"
                }
            ).Replace(
                "GROUP",
                if qualified {
                    self + ".Count"
                } else {
                    "Count"
                }
            ).Replace(
                "CLOSED",
                if generic {
                    "Counter[string]"
                } else {
                    "Counter"
                }
            ), "1|Count|True|True")
    }

    @Fact
    func RefAndOptionalParameters_KeepTheirPhysicalDelegateContracts() {
        using let driver = Driver()
        driver.Check(`import System
import System.Collections.Generic
delegate Accumulator(ref value int32, items List[string]) int32;
func Accumulate(ref value int32, items ...List[string]) int32 {
    value += items.Count
    return value
}
func Optional(prefix int32 = 8, items ...List[string]) int32 -> prefix + items.Count
let accumulate Accumulator = Accumulate
let optional (int32, List[string]) -> int32 = Optional
var value = 10
let items = List[string]{"x"}
Console.Write(accumulate(ref value, items))
Console.Write("|")
Console.Write(value)
Console.Write("|")
Console.Write(optional(20, items))
Console.Write("|")
Console.Write(Optional())
`, "11|11|21|8")
    }

    @Theory
    @InlineData("let bad (string) -> int32 = @Count", "GS0155")
    @InlineData("let bad (string, string) -> int32 = @Count", "GS0155")
    @InlineData("let bad () -> int32 = @Count", "GS0155")
    @InlineData("let bad (IEnumerable[string]) -> int32 = @Count", "GS0155")
    @InlineData("let bad (List[string]) -> int64 = @Count", "GS0155")
    @InlineData("callback(@\"x\")", "GS0155")
    @InlineData("@callback(\"x\", \"y\")", "GS0144")
    @InlineData("@callback()", "GS0144")
    @InlineData("let inferred = Count\n@inferred(\"x\", \"y\")", "GS0144")
    func FunctionValues_DoNotExpandOrChangeThePhysicalContract(statement string, diagnostic string) {
        using let driver = Driver()
        driver.Check(ListPreamble + "Console.Write(callback(List[string]{\"x\"}))", "1")
        driver.Reject(ListPreamble + statement, diagnostic)
    }

    @Theory
    @InlineData("func Count(items ...List[int32?]) int32 -> 1\nlet bad (List[int32]) -> int32 = @Count", "GS0155")
    @InlineData(
        "func Count(ref n int32, items ...List[string]) int32 -> n\nlet bad (int32, List[string]) -> int32 = @Count",
        "GS0155"
    )
    @InlineData(
        "func Count(n int32 = 1, items ...List[string]) int32 -> n\nlet bad (List[string]) -> int32 = @Count",
        "GS0155"
    )
    @InlineData(
        "func Count(items ...IEnumerable[string]) int32 -> 1\nfunc Count(items ...ICollection[string]) int32 -> 2\nlet bad (List[string]) -> int32 = @Count",
        "GS0218"
    )
    func UnsupportedContracts_RemainLocatedErrors(declarations string, diagnostic string) {
        using let driver = Driver()
        driver.Check(ListPreamble + "Console.Write(callback(List[string]{\"x\"}))", "1")
        driver.Reject("import System\nimport System.Collections.Generic\n" + declarations, diagnostic)
    }

    shared {
        private const ListPreamble string = `import System
import System.Collections.Generic
func Count(items ...List[string]) int32 -> items.Count
let callback (List[string]) -> int32 = Count
`
    }

    private class Driver : IDisposable {
        private let directory string

        init() {
            directory = Path.Combine(AppContext.BaseDirectory, "issue6003-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
        }

        public func Dispose() -> Directory.Delete(directory, recursive: true)

        func Check(source string, expected string) {
            let result = Compile(source)
            Assert.True(result.Code == 0, Encoding.UTF8.GetString(result.Bytes) + result.Error)
            Assert.Empty(result.Error)
            let image = Path.Combine(directory, "Consumer.dll")
            Assert.True(File.Exists(image))
            let verify = List[string]{"tool", "run", "ilverify", "--", image, "-s", "System.Private.CoreLib"}
            let references = Directory.GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            Assert.NotEmpty(references)
            for reference in references {
                verify.Add("-r")
                verify.Add(reference)
            }
            let verified = Run(verify)
            Assert.True(verified.Code == 0, Encoding.UTF8.GetString(verified.Bytes) + verified.Error)
            Assert.Empty(verified.Error)
            let executed = Run([]string{image})
            Assert.Equal(0, executed.Code)
            Assert.Empty(executed.Error)
            Assert.Equal(Encoding.UTF8.GetBytes(expected), executed.Bytes)
        }

        func Reject(markedSource string, diagnostic string) {
            let marker = markedSource.IndexOf('@')
            Assert.True(marker >= 0)
            let source = markedSource.Remove(marker, 1)
            let prefix = source.Substring(0, marker)
            let line = prefix.Count((c char) -> c == '\n') + 1
            let column = marker - prefix.LastIndexOf('\n')
            let result = Compile(source)
            Assert.Equal(1, result.Code)
            Assert.False(File.Exists(Path.Combine(directory, "Consumer.dll")))
            let log = Encoding.UTF8.GetString(result.Bytes) + result.Error
            let errors = Regex.Matches(log, `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`)
            let error = Assert.Single(errors.Cast[Match]())
            Assert.Equal(line.ToString(), error.Groups[1].Value)
            Assert.Equal(column.ToString(), error.Groups[2].Value)
            let token = Regex.Match(source.Substring(marker), `^(?:"[^"]*"|\w+)`).Value
            Assert.NotEmpty(token)
            Assert.Equal(line.ToString(), error.Groups[3].Value)
            Assert.Equal((column + token.Length).ToString(), error.Groups[4].Value)
            Assert.Equal(diagnostic, error.Groups[5].Value)
            Assert.DoesNotContain("GS9998", log)
        }

        private func Compile(source string)(Code int32, Bytes[]uint8, Error string) {
            let input = Path.Combine(directory, "Consumer.gs")
            let image = Path.Combine(directory, "Consumer.dll")
            File.Delete(image)
            File.WriteAllText(input, source)
            return Run(
                []string{
                    typeof(Program).Assembly.Location,
                    input,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/deterministic+",
                    "/out:" + image
                }
            )
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
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
            using let bytes = MemoryStream()
            let read = process.StandardOutput.BaseStream.CopyToAsync(bytes)
            let error = process.StandardError.ReadToEndAsync()
            let exited = process.WaitForExit(30_000)
            if !exited {
                process.Kill(entireProcessTree: true)
            }
            process.WaitForExit()
            read.GetAwaiter().GetResult()
            Assert.True(exited, "Variadic method-group driver exceeded 30 seconds.")
            return (process.ExitCode, bytes.ToArray(), error.GetAwaiter().GetResult())
        }
    }
}
