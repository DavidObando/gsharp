package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Compiler.Tests.LanguageConformance
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue6040GenericNullableReturnDriverTests {
    @Theory
    @InlineData("func F[T](value T[?]) {}")
    @InlineData("func F[T]() { let value T[?] = default(T) }")
    @InlineData("func F[T]() { let value = default(T[?]) }")
    @InlineData("func F[T](value T) { let copy = T[?](value) }")
    @InlineData("func F[T](value []T[?]) {}")
    @InlineData("import System.Collections.Generic\nfunc F[T](value List[T[?]]) {}")
    @InlineData("func F[T](value (int32, T[?])) {}")
    @InlineData("func F[T](value () -> T[?]) {}")
    @InlineData("func F[T](value (T)[?]) {}")
    @InlineData("delegate Read[T]() T[?];")
    @InlineData("interface Contract[T] { func Read() T[?]; }")
    @InlineData("class Box[T] { var Item T[?] }")
    @InlineData("import System\nfunc F[T IComparable[T[?]]]() {}")
    @InlineData("func F[T notnull]() T[?] -> default(T)")
    @InlineData("import System\nfunc F[T IComparable[T]]() T[?] -> default(T)")
    @InlineData("func F[T object]() T[?] -> default(T)")
    @InlineData("func F[B class, T B]() T[?] -> default(T)")
    @InlineData("func F[B class?, T B]() T[?] -> default(T)")
    @InlineData("func F[A B[?], B]() {}")
    func UnknownKinds_AreRejectedInSourcePositions(marked string) {
        let start = marked.IndexOf("[?]", StringComparison.Ordinal)
        Assert.True(start >= 0)
        let line = marked.Substring(0, start).Count((c char) -> c == '\n') + 1
        let column = start - marked.LastIndexOf('\n', start)
        CheckRejected(
            marked.Replace("[?]", "?") + "\nfunc Main() {}",
            []string{"GS0641@${line},${column},${line},${column + 1}"}
        )
    }

    @Fact
    func KnownKinds_PreserveAbsenceDefaultValuesAndBareNullableArguments() {
        Check(`import System
func Id[T](value T) T -> value
func Value[T struct]() T? -> default(T)
func Nil[T struct]() T? -> nil
func DefaultNil[T struct]() T? -> default(T?)
func Forward[T struct]() T? -> Id(Value[T]())
func Reference[T class?]() T? -> default(T)
open class Base {}
class Derived : Base {}
func Bounded[T Base]() T? -> nil
func Dependent[B Base?, T B]() T? -> nil
func Self[T IEquatable[T?] class?]() T? -> nil
func Later[U IEquatable[T?], T class?]() T? -> nil
func Future[A B?, B class?]() {}
func NativeValue[T unmanaged]() T? -> default(T)
class Deferred[T Animal] : Holder[sequence[T?]] {}
open class Holder[T] {}
open class Animal {}
Console.Write(Value[int32]().ToString())
Console.Write(":" + (Nil[int32]() == nil).ToString())
Console.Write(":" + (DefaultNil[int32]() == nil).ToString())
Console.Write(":" + Forward[int32]().ToString())
Console.Write(":" + (Reference[string]() == nil).ToString())
Console.Write(":" + (Reference[string?]() == nil).ToString())
Console.Write(":" + (Bounded[Derived]() == nil).ToString())
Console.Write(":" + (Dependent[Base?, Derived?]() == nil).ToString())
Console.Write(":" + NativeValue[int32]().ToString())
let nothing int32? = nil
Console.Write(":" + (Id(nothing) == nil).ToString())
Console.Write(":" + Id[int32?](0).ToString())
Console.Write(":" + (Id[string?](nil) == nil).ToString())
`, "0:True:True:0:True:True:True:True:0:True:0:True")
    }

    @Theory
    @InlineData("import System\nfunc F[T](read Func[T]?) { let value = read[[?]]() }")
    @InlineData("func F[T](read (() -> T)?) { let value = read[[?]]() }")
    @InlineData("import System\nfunc F[T](read Func[Func[T]]?) { let value = read?()[[(]]) }")
    @InlineData("class Box[T] { var Value T }\nfunc F[T](box Box[T]?) { let value = box[[?.]]Value }")
    @InlineData("class Box[T] { func Read() T -> default(T) }\nfunc F[T](box Box[T]?) { let value = box[[?.]]Read() }")
    @InlineData("func F[T](values ([]T)?) { let value = values[[?[]]0] }")
    @InlineData("func F[T](choose bool, value T) { let result = choose [[?]] value : nil }")
    @InlineData("func F[A class, B A](choose bool, value B) { let result = choose [[?]] value : nil }")
    @InlineData("func F[T](choose bool, value T) { let result = choose [[?]] (value, 1) : (nil, 2) }")
    @InlineData("func F[T](choose bool, value T) { let result = [[if]] choose { value } else { nil } }")
    @InlineData("func F[T](choose bool, value T) { let result = [[switch]] choose { case true: value\ndefault: nil } }")
    @InlineData("func F[T](input string?, value T) { let result = [[if]] let text = input { value } else { nil } }")
    @InlineData("func F[T](choose bool, value T) { let read = () [[->]] { if choose { return value }\nreturn nil } }")
    func SourceOperators_RequireTheSameKnownKind(marked string) {
        let start = marked.IndexOf("[[", StringComparison.Ordinal)
        let end = marked.IndexOf("]]", start, StringComparison.Ordinal)
        Assert.True(start >= 0 && end > start)
        let width = end - start - 2
        let line = marked.Substring(0, start).Count((c char) -> c == '\n') + 1
        let column = start - marked.LastIndexOf('\n', start)
        CheckRejected(
            marked.Remove(end, 2).Remove(start, 2) + "\nfunc Main() {}",
            []string{"GS0641@${line},${column},${line},${column + width}"}
        )
    }

    @Fact
    func KnownKindOperators_PreserveAbsencePresentZeroAndSingleEvaluation() {
        Check(`import System
func Value[T struct](read Func[T]?) {
    let value = read?()
    Console.Write((value == nil).ToString())
}
func Reference[T class?](read Func[T]?) {
    let value = read?()
    Console.Write((value == nil).ToString())
}
func ChainedValue[T struct](read Func[Func[T]]?) {
    let value = read?()()
    Console.Write((value == nil).ToString())
}
func ChainedReference[T class?](read Func[Func[T]]?) {
    let value = read?()()
    Console.Write((value == nil).ToString())
}
open class Animal {}
class Dog : Animal {}
func Dependent[A Animal, B A](choose bool, value B) {
    let result = choose ? value : nil
    Console.Write((result == nil).ToString())
}
Value[int32](nil)
Console.Write(":")
var calls = 0
let Read = func() int32 {
    calls += 1
    return 0
}
Value[int32](Read)
Console.Write(":" + calls.ToString() + ":")
Reference[string](nil)
Console.Write(":")
Reference[string](() -> "")
Console.Write(":")
Reference[string?](() -> nil)
Console.Write(":")
Dependent[Animal, Dog](false, Dog())
Console.Write(":")
Dependent[Animal, Dog](true, Dog())
Console.Write(":")
ChainedValue[int32](nil)
Console.Write(":")
ChainedValue[int32](() -> Func[int32](() -> 0))
Console.Write(":")
ChainedReference[string](nil)
`, "True:False:1:True:False:True:True:False:True:False:True")
    }

    @Fact
    func OriginalUnconstrainedDelegateAccess_IsRejectedAtTheOperator() {
        CheckRejected(`import System
func Missing[T](read Func[T]?) {
    let value = read?()
    Console.WriteLine(value == nil)
}
Missing[int32](nil)
`, []string{"GS0641@3,21,3,22"})
    }

    @Fact
    func OriginalDependentClassFlag_DoesNotProveAReferenceRepresentation() {
        CheckRejected(`import System
func Probe[A class, B A](choose bool, value B) {
    let result = choose ? value : nil
    Console.Write((result == nil).ToString())
}
Probe[object, int32](false, 0)
Console.Write(":")
Probe[object, int32](true, 0)
`, []string{"GS0641@3,25,3,26"})
    }

    @Fact
    func ConstrainedFields_PreservePresenceAliasingEvaluationAndValueCopies() {
        Check(`import System
class ValueBox[T struct] { var Item T? }
class ReferenceBox[T class?] { var Item T? }
struct Counter {
    var Value int32
    init(value int32) { Value = value }
    func Increment() { Value++ }
}
func Clear[T struct](ref value T?) { value = nil }
func Fill[T struct](out value T?, replacement T) { value = replacement }
func Main() {
    let box = ValueBox[int32]()
    Console.Write((box.Item == nil).ToString())
    box.Item = default(int32)
    Console.Write(":" + box.Item.ToString())
    var ref alias = box.Item
    Clear(ref alias)
    Console.Write(":" + (box.Item == nil).ToString())
    let ref readonly observed = box.Item
    Fill(out box.Item, 7)
    Console.Write(":" + observed.ToString())
    let boxes = []ValueBox[int32]{box}
    var calls = 0
    let NextIndex = func() int32 {
        calls += 1
        return 0
    }
    Clear(ref boxes[NextIndex()].Item)
    Console.Write(":" + (observed == nil).ToString() + ":" + calls.ToString())
    let reference = ReferenceBox[string?]()
    Console.Write(":" + (reference.Item == nil).ToString())
    var ref textAlias = reference.Item
    textAlias = "text"
    Console.Write(":" + reference.Item)
    let counters = ValueBox[Counter]()
    counters.Item = Counter(11)
    var copy = counters.Item!!
    copy.Increment()
    Console.Write(":" + counters.Item!!.Value.ToString() + ":" + copy.Value.ToString())
}
`, "True:0:True:7:True:1:True:text:11:12")
    }

    @Fact
    func UnconstrainedNullableReturn_IsRejectedAtTheSourceAnnotation() {
        CheckRejected(`import System
func Missing[T]() T? -> default(T)
Console.WriteLine(Missing[int32]().ToString())
`, []string{"GS0641@2,20,2,21"})
    }

    @Fact
    func OriginalForwardedNullableReturns_RequireKnownKinds() {
        CheckRejected(`import System
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
`, []string{"GS0641@3,20,3,21", "GS0641@4,16,4,17", "GS0641@7,18,7,19"})
    }

    @Fact
    func OriginalNullableParameters_RequireKnownKinds() {
        CheckRejected(`import System
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
`, []string{"GS0641@2,21,2,22", "GS0641@2,25,2,26", "GS0641@5,16,5,17", "GS0641@6,24,6,25"})
    }

    @Fact
    func OriginalGenericMembersAndCapturedLocals_RequireKnownKinds() {
        CheckRejected(`import System
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
`, []string{"GS0641@3,24,3,25", "GS0641@6,24,6,25", "GS0641@10,28,10,29", "GS0641@14,24,14,25", "GS0641@21,31,21,32"})
    }

    @Fact
    func OriginalConstructedOwnerReturns_RequireKnownKinds() {
        CheckRejected(`import System
interface IOwner[T] {
    func Missing[U]() T?;
}
open class Owner[T] : IOwner[T] {
    func Missing[U]() T? -> default(T)
    func Plain() T? -> default(T)
    func Keep[U](value T) T? -> value
    shared {
        func SharedMissing[U]() T? -> default(T)
        func SharedPlain() T? -> default(T)
    }
}
class Child : Owner[int32] {
    func Read() int32? -> base.Missing[string]()
}
class ValueOwner[T struct] {
    func Missing[U]() T? -> nil
}
func Constrained[T IOwner[int32]](owner T) int32? -> owner.Missing[string]()
let owner = Owner[int32]()
Console.Write(owner.Missing[string]())
Console.Write(":")
Console.Write(owner.Plain())
Console.Write(":")
Console.Write(owner.Keep[string](19))
Console.Write(":")
Console.Write(Owner[int32].SharedMissing[string]())
Console.Write(":")
Console.Write(Owner[int32].SharedPlain())
Console.Write(":")
let contract IOwner[int32] = owner
Console.Write(contract.Missing[string]())
Console.Write(":")
Console.Write(Constrained(owner))
Console.Write(":")
Console.Write(Child().Read())
Console.Write(":")
Console.Write(Owner[string]().Missing[int32]() == nil)
Console.Write(":")
Console.Write(Owner[int32?]().Missing[string]() == nil)
Console.Write(":")
Console.Write(ValueOwner[int32]().Missing[string]() == nil)
`, []string{
                "GS0641@3,24,3,25",
                "GS0641@6,24,6,25",
                "GS0641@7,19,7,20",
                "GS0641@8,28,8,29",
                "GS0641@10,34,10,35",
                "GS0641@11,29,11,30"
            })
    }

    shared {
        internal func CheckRejectedAnnotations(
            source string,
            parameters[]string,
            count int32,
            otherErrors([]string)? = nil,
            isLibrary bool = false,
            references([]string)? = nil,
            occurrences([]int32)? = nil
        ) {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let (exitCode, diagnostics, image) = Compile(fixture, source, isLibrary, references)
            Assert.True(exitCode != 0, diagnostics)
            Assert.False(File.Exists(image), diagnostics)
            var annotations = Regex
                .Matches(source, `\b(?:` + string.Join("|", parameters.Select((p string) -> Regex.Escape(p))) + `)\?`)
                .Cast[Match]()
                .ToArray()
            if occurrences != nil {
                let allAnnotations = annotations
                annotations = occurrences.Select((index int32) -> allAnnotations[index]).ToArray()
            }
            Assert.Equal(count, annotations.Length)
            Assert.NotEmpty(annotations)
            let matches = Regex.Matches(diagnostics, `\((\d+,\d+,\d+,\d+)\): error (GS\d+):`)
            let errors = matches.Where((m Match) -> m.Groups[2].Value == "GS0641").ToArray()
            Assert.Equal(count, errors.Length)
            Assert.Equal(
                (otherErrors ?? []string{}).Order().ToArray(),
                matches
                    .Where((m Match) -> m.Groups[2].Value != "GS0641")
                    .Select((m Match) -> m.Groups[2].Value)
                    .Order()
                    .ToArray()
            )
            for var i = 0; i < count; i++ {
                let offset = annotations[i].Index + annotations[i].Length - 1
                let line = source.Substring(0, offset).Count((c char) -> c == '\n') + 1
                let column = offset - source.LastIndexOf('\n', offset)
                Assert.Equal("${line},${column},${line},${column + 1}", errors[i].Groups[1].Value)
            }
        }

        private func Check(source string, expected string) {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let (exitCode, diagnostics, image) = Compile(fixture, source)
            Assert.True(exitCode == 0, diagnostics)
            Assert.DoesNotContain("warning ", diagnostics, StringComparison.Ordinal)
            IlVerifier.Verify(image)
            Assert.Equal(Encoding.UTF8.GetBytes(expected), fixture.RunBytes(image))
        }

        internal func CheckRejected(source string, expected[]string) {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let (exitCode, diagnostics, image) = Compile(fixture, source)
            Assert.True(exitCode != 0, diagnostics)
            Assert.False(File.Exists(image), diagnostics)
            let matches = Regex.Matches(diagnostics, `\((\d+,\d+,\d+,\d+)\): error (GS\d+):`)
            Assert.NotEmpty(matches)
            Assert.Equal(expected, matches.Select((m Match) -> m.Groups[2].Value + "@" + m.Groups[1].Value).ToArray())
        }

        private func Compile(
            fixture NativeSliceLanguageTests.Fixture,
            source string,
            isLibrary bool = false,
            references([]string)? = nil
        )(int32, string, string) {
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
                if isLibrary {
                    "/target:library"
                } else {
                    "/target:exe"
                },
                "/targetframework:net10.0",
                "--nullability=platform-types",
                "/out:" + image,
                input
            } {
                start.ArgumentList.Add(argument)
            }
            if references != nil {
                for reference in references {
                    start.ArgumentList.Add("/reference:" + reference)
                }
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
            return (process.ExitCode, diagnostics, image)
        }
    }
}
