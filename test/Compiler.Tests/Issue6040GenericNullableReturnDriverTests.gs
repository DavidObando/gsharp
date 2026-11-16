package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Compiler.Tests.LanguageConformance
import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

class Issue6040GenericNullableReturnDriverTests {
    @Fact
    func UnconstrainedNullableReturn_PreservesValueArgumentRepresentation() {
        Check(`import System
func Missing[T]() T? -> default(T)
Console.WriteLine(Missing[int32]().ToString())
`, "0${Environment.NewLine}")
    }

    @Fact
    func ForwardedNullableReturns_PreserveReferenceAndNullableArguments() {
        Check(`import System
func Id[U](value U) U -> value
func Missing[T]() T? {
    let value T? = default(T)
    return Id(value)
}
func Relay[T]() T? -> Missing[T]()
Console.Write(Relay[string]() == nil)
Console.Write(":")
Console.Write(Relay[int32]().ToString())
Console.Write(":")
Console.Write(Relay[int32?]() == nil)
Console.Write(":")
Console.Write(Relay[string?]() == nil)
`, "True:0:True:True")
    }

    @Fact
    func NullableParameters_PreserveNullFlowSingleEvaluationAndConstraints() {
        Check(`import System
func Echo[T](value T?) T? -> value
func Value[T struct](value T) T? -> value
func Empty[T struct]() T? -> nil
func Raw[T]() T? -> default(T)
func Keep[T](value T) T? -> value
func Lift[T struct]() T? -> Raw[T]()
func Reference[T class]() T? -> Echo[T](nil)
struct Point {
    var X int32
}
func Next() int32 {
    Console.Write("N")
    return 37
}
Console.Write(Keep(Next()))
Console.Write(":")
Console.Write(Echo[int32](37))
Console.Write(":")
Console.Write(Echo("text"))
Console.Write(":")
Console.Write(Echo[string](nil) == nil)
Console.Write(":")
Console.Write(Echo[int32?](nil) == nil)
Console.Write(":")
Console.Write(Echo[int32](nil) == nil)
Console.Write(":")
var missing int32? = nil
Console.Write(Echo(missing) == nil)
Console.Write(":")
Console.Write(Value[int32](0) == nil)
Console.Write(":")
Console.Write(Empty[int32]() == nil)
Console.Write(":")
Console.Write(Lift[int32]() == nil)
Console.Write(":")
Console.Write(Reference[string]() == nil)
Console.Write(":")
Console.Write(Echo[int32?](7))
Console.Write(":")
let point = Keep(Point{X: 19})
var copy = point!!
copy.X = 23
Console.Write(point!!.X)
Console.Write(":")
Console.Write(copy.X)
`, "N37:37:text:True:True:True:True:False:True:False:True:7:19:23")
    }

    @Fact
    func GenericMemberAndCapturedLocalCalls_UseTheSameReturnRepresentation() {
        Check(`import System
interface IFactory {
    func Missing[T]() T?;
}
class Factory : IFactory {
    func Missing[T]() T? -> default(T)
}
class Holder[T] {
    shared {
        func Missing[U]() U? -> default(U)
    }
}
open class Base {
    func Missing[T]() T? -> default(T)
}
class Derived : Base {
    func Read() int32? -> base.Missing[int32]()
}
func Constrained[T IFactory](factory T) int32? -> factory.Missing[int32]()
func Captured(seed string) int32? {
    let Missing[T] = func () T? {
        Console.Write(seed)
        return default(T)
    }
    return Missing[int32]()
}
let factory = Factory()
Console.Write(factory.Missing[int32]())
Console.Write(":")
let contract IFactory = factory
Console.Write(contract.Missing[int32]())
Console.Write(":")
Console.Write(Constrained(factory))
Console.Write(":")
Console.Write(Holder[string].Missing[int32]())
Console.Write(":")
Console.Write(Derived().Read())
Console.Write(":")
Console.Write(Captured("C"))
`, "0:0:0:0:0:C0")
    }

    shared {
        private func Check(source string, expected string) {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let input = Path.Combine(fixture.Directory, "Witness.gs")
            let image = Path.Combine(fixture.Directory, "Witness.dll")
            File.WriteAllText(input, source)
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            for argument in[]string{
                typeof(Program).Assembly.Location,
                "/target:exe",
                "/targetframework:net10.0",
                "--nullability=platform-types",
                "/out:" + image,
                input
            } {
                start.ArgumentList.Add(argument)
            }
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start gsc.")
            let output = process.StandardOutput.ReadToEndAsync()
            let error = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("Generic nullable-return driver timed out.")
            }
            let diagnostics = output.GetAwaiter().GetResult() + error.GetAwaiter().GetResult()
            Assert.True(process.ExitCode == 0, diagnostics)
            Assert.DoesNotContain("warning ", diagnostics, StringComparison.Ordinal)
            IlVerifier.Verify(image)
            Assert.Equal(Encoding.UTF8.GetBytes(expected), fixture.RunBytes(image))
        }
    }
}
