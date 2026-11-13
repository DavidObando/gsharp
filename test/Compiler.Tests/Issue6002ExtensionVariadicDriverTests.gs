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

class Issue6002ExtensionVariadicDriverTests {
    @Theory
    @InlineData("List[string]", "List[string]", "List[string]", "string")
    @InlineData("List[string?]", "List[string?]", "List[string?]", "string?")
    @InlineData("IEnumerable[string]", "IEnumerable[string]", "[]string", "string")
    @InlineData("string", "[]string", "[]string", "string")
    func ReducedReceiver_PacksElementsAndPreservesNormalCarrier(
        declaration string,
        carrier string,
        construction string,
        element string
    ) {
        using let driver = Driver()
        driver.Check(`import System
import System.Collections.Generic
import System.Linq
func (receiver int32) Measure(items ...DECLARATION) int32 -> items.Count()
func (receiver int32) Identity(items ...DECLARATION) CARRIER -> items
func Item() ELEMENT -> "x"
func Receiver() int32 {
    Console.Write("R")
    return 0
}
func Next(value string) string {
    Console.Write(value)
    return value
}
let items CARRIER = CONSTRUCTION{"x"}
Console.Write((0).Measure())
Console.Write((0).Measure(Item()))
Console.Write((0).Measure("x", "y", "z"))
Console.Write((0).Measure(items))
Console.Write(object.ReferenceEquals(items, (0).Identity(items)))
Console.Write(object.ReferenceEquals(items, (0).Identity(items: items)))
let callback (CARRIER) -> int32 = (0).Measure
Console.Write(callback(items))
Console.Write("|")
Console.Write(Receiver().Measure(Next("A"), Next("B")))
`.Replace(
                "DECLARATION",
                declaration
            ).Replace(
                "CARRIER",
                carrier
            ).Replace("CONSTRUCTION", construction).Replace("ELEMENT", element), "0131TrueTrue1|RAB2")
    }

    @Fact
    func GenericAndOverloadedExtensions_InferExpandedElements() {
        using let driver = Driver()
        driver.Check(`import System
import System.Collections.Generic
func (receiver int32) Measure[T](items ...List[T]) int32 -> items.Count
func (receiver int32) Identity[T](items ...List[T]) List[T] -> items
func (receiver int32) Pick[T](items ...List[T]) int32 -> items.Count + 10
func (receiver int32) Pick(items ...int32) int32 -> items.Length + 20
Console.Write((0).Measure("x", "y"))
Console.Write("|")
Console.Write((0).Measure[string]())
Console.Write("|")
Console.Write((0).Measure[string]("x"))
Console.Write("|")
Console.Write((0).Pick("x", "y"))
Console.Write("|")
Console.Write((0).Pick(1, 2, 3))
Console.Write("|")
let items = List[string]{"x"}
Console.Write(object.ReferenceEquals(items, (0).Identity(items)))
Console.Write("|")
Console.Write((0).Pick(items))
`, "2|0|1|12|23|True|11")
        driver.Reject(`import System.Collections.Generic
func (receiver int32) Measure(items ...List[string]) int32 -> items.Count
let callback (List[string]) -> int32 = (0).Measure
let item = "x"
callback(@item)
`, "GS0155")
    }

    @Fact
    func FixedOptionalNamedAndByRefArguments_StayOutsideThePack() {
        using let driver = Driver()
        driver.Check(`import System
import System.Collections.Generic
func (receiver int32) Measure(prefix int32 = 7, items ...List[string]) int32 ->
    receiver + prefix + items.Count
func (receiver int32) Bump(ref count int32, items ...List[string]) int32 {
    count += items.Count
    return receiver + count
}
func Receiver() int32 {
    Console.Write("R")
    return 1
}
func Prefix() int32 {
    Console.Write("P")
    return 2
}
func Items() List[string] {
    Console.Write("I")
    return List[string]{"a", "b"}
}
var count = 10
Console.Write((1).Measure())
Console.Write("|")
Console.Write((1).Measure(prefix: 2, items: List[string]{"a", "b"}))
Console.Write("|")
Console.Write((1).Measure(2, "a", "b"))
Console.Write("|")
Console.Write((1).Bump(ref count, "a", "b"))
Console.Write("|")
Console.Write(count)
Console.Write("|")
Console.Write(Receiver().Measure(items: Items(), prefix: Prefix()))
Console.Write("|")
Console.Write((1).Measure(items: List[string]{"a"}))
`, "8|5|5|13|12|RIP5|9")
    }

    @Fact
    func WrongExpandedElement_ReportsItsOwnSourceLocation() {
        using let driver = Driver()
        driver.Reject(`import System.Collections.Generic
func (receiver int32) Measure(items ...List[string]) int32 -> items.Count
(0).Measure("x", @42)
`, "GS0154")
    }

    @Fact
    func ReadonlyReceiverAndFixedArgument_KeepTheirValuesWhilePacking() {
        using let driver = Driver()
        driver.Check(`import System
import System.Collections.Generic
func (in receiver int32) Read(in prefix int32, items ...List[string]) int32 ->
    receiver + prefix + items.Count
var value = 5
Console.Write(value.Read(in value, "a", "b"))
Console.Write("|")
Console.Write(value)
Console.Write("|")
Console.Write((1).Read(in value))
`, "12|5|6")
    }

    @Fact
    func OverloadedVariadics_AllowOmittedOptionalFixedParameters() {
        using let driver = Driver()
        driver.Check(`import System
import System.Collections.Generic
func (receiver int32) Measure(prefix int32 = 7, items ...List[string]) int32 ->
    receiver + prefix + items.Count
func (receiver int32) Measure(prefix string, items ...List[string]) int32 -> 99
func Ordinary(prefix int32 = 7, items ...List[string]) int32 -> prefix + items.Count
func Ordinary(prefix string, items ...List[string]) int32 -> 99
class Counter {
    func Measure(prefix int32 = 7, items ...List[string]) int32 -> prefix + items.Count
    func Measure(prefix string, items ...List[string]) int32 -> 99
}
Console.Write((1).Measure())
Console.Write("|")
Console.Write((1).Measure(items: List[string]{"x"}))
Console.Write("|")
Console.Write(Ordinary())
Console.Write("|")
Console.Write(Counter().Measure())
Console.Write("|")
Console.Write((1).Measure("prefix", "x"))
`, "8|9|7|7|99")
    }

    @Fact
    func GenericArrayElements_AreNotMistakenForListCarriers() {
        using let driver = Driver()
        driver.Check(`import System
import System.Collections.Generic
import System.Linq
func (receiver int32) Count[T](items ...List[T]) int32 -> items.Count
func (receiver int32) Sequence[T](items ...IEnumerable[T]) int32 -> items.Count()
func (receiver int32) Array[T](items ...T) int32 -> items.Length
func (receiver int32) Pick[T](items ...List[T]) int32 -> items.Count
func (receiver int32) Pick(items ...int32) int32 -> 99
func Ordinary[T](items ...List[T]) int32 -> items.Count
func Ordinary(items ...int32) int32 -> 99
class Counter {
    func Count[T](items ...List[T]) int32 -> items.Count
    func Count(items ...int32) int32 -> 99
}
let values = []string{"x", "y"}
Console.Write((0).Count(values))
Console.Write("|")
Console.Write(Counter().Count(values))
Console.Write("|")
Console.Write((0).Sequence(values))
Console.Write("|")
Console.Write((0).Array(values))
Console.Write("|")
Console.Write((0).Pick(values))
Console.Write("|")
Console.Write(Ordinary(values))
Console.Write("|")
Console.Write(Ordinary("x", "y"))
`, "1|1|2|2|1|1|2")
    }

    @Fact
    func FailedNormalFormInference_DoesNotPolluteElementBounds() {
        using let driver = Driver()
        driver.Check(`import System
import System.Collections.Generic
func (receiver int32) Collect[T](seed T, items ...List[T]) List[T] -> items
func (receiver int32) Elements[T](items ...List[T]) List[T] -> items
func Maybe() List[string]? -> List[string]{"a"}
let seed object = "seed"
let items = List[string]{"x", "y"}
let result = (0).Collect(seed, items)
Console.Write(result.Count)
Console.Write("|")
Console.Write(object.ReferenceEquals(items, result[0]))
let maybe = Maybe()
let nested List[List[string]?] = (0).Elements(maybe)
Console.Write("|")
Console.Write(nested.Count)
Console.Write("|")
Console.Write(object.ReferenceEquals(maybe, nested[0]))
`, "1|True|1|True")
    }

    @Fact
    func NormalCarrierInference_RefinesProvisionalButNotOwnerBounds() {
        using let driver = Driver()
        driver.Check(`import System
import System.Collections.Generic
func (receiver int32) Collect[T](seed T, items ...List[T]) List[T] -> items
func Ordinary[T](seed T, items ...List[T]) List[T] -> items
class Counter {
    func Collect[T](seed T, items ...List[T]) List[T] -> items
}
let items = List[object]{"x", "y"}
let extension = (0).Collect("seed", items)
let instance = Counter().Collect("seed", items)
let ordinary = Ordinary("seed", items)
Console.Write(extension.Count)
Console.Write("|")
Console.Write(object.ReferenceEquals(items, extension))
Console.Write(object.ReferenceEquals(items, instance))
Console.Write(object.ReferenceEquals(items, ordinary))
`, "2|TrueTrueTrue")
        driver.Reject(`import System.Collections.Generic
class Counter[T] {
    func Collect[U](seed U, items ...List[T]) int32 -> items.Count
}
let items = List[object]{"x"}
Counter[string]().Collect(0, @items)
`, "GS0154")
    }

    private class Driver : IDisposable {
        private let directory string

        init() {
            directory = Path.Combine(AppContext.BaseDirectory, "issue6002-" + Guid.NewGuid().ToString("N"))
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
            let token = Regex.Match(source.Substring(marker), `^\w+`).Value
            Assert.NotEmpty(token)
            Assert.Equal(line.ToString(), error.Groups[3].Value)
            Assert.Equal((column + token.Length).ToString(), error.Groups[4].Value)
            Assert.Equal(diagnostic, error.Groups[5].Value)
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
            Assert.True(exited, "Extension variadic driver exceeded 30 seconds.")
            return (process.ExitCode, bytes.ToArray(), error.GetAwaiter().GetResult())
        }
    }
}
