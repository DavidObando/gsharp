// <copyright file="Adr0186ObliviousScopeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import System.Text

/// ADR-0186 step 5 — §9: declaring obliviousness in G# source, through the
/// compilation switch (`--nullability=oblivious`) and the
/// `@Oblivious` / `@NullabilityEnabled` annotations.
///
/// Every assertion reads a bound <em>type</em>, because that is what §9
/// changes: an unadorned reference position inside an oblivious scope is
/// `T!` ((cref:PlatformTypeSymbol)), `T?` is still
/// `T?`, and a value type or open type parameter has no oblivious
/// reading at all. Open question 12 is why the body positions are here too:
/// cs2gs writes explicitly-typed locals, `for` variables, `out`
/// declarations and lambda signatures, and a scope rule that stopped at
/// declaration signatures would leave every one of them non-null.
open class Adr0186ObliviousScopeTests {
    // ---------------------------------------------------------------
    // Declaration positions: the six ADR-0047 positions §9 names.
    // ---------------------------------------------------------------
    /// `@Oblivious` on a <b>type</b> reaches every signature position of
    /// every member: field, property, event, method parameter and return.
    @Fact
    func Oblivious_On_A_Type_Reaches_Every_Member_Signature() {
        let holder = BindStruct(`@Oblivious
class Holder {
    var Field string
    prop Prop string { get; set }
    event Changed Action[string]
    func Method(p string) string { return p }
}`, "Holder")
        AssertPlatform(TypeSymbol.String, Field(holder, "Field"))
        AssertPlatform(TypeSymbol.String, Property(holder, "Prop"))
        let method = Method(holder, "Method")
        AssertPlatform(TypeSymbol.String, method.Parameters.Single().Type)
        AssertPlatform(TypeSymbol.String, method.Type)
        // The event's own type is the delegate, and it is the slot's top
        // level. Its type argument is nested, so it stays as written
        // (owner decision 2026-09-25, amending open question 12).
        let event = Assert.Single(holder.Events, (e EventSymbol) -> e.Name == "Changed")
        let eventType = Assert.IsType[PlatformTypeSymbol](event.Type)
        Assert.Same(TypeSymbol.String, TypeArgument(eventType.UnderlyingType, 0))
    }

    /// Each of the member-level positions takes the annotation on its own,
    /// and it reaches only that member: an unannotated sibling in the same
    /// (enabled) type is unchanged.
    @Fact
    func Oblivious_On_A_Single_Member_Reaches_Only_That_Member() {
        let holder = BindStruct(`class Holder {
    @Oblivious var ObliviousField string
    var PlainField string = ""
    @Oblivious prop ObliviousProp string { get; set }
    prop PlainProp string { get; set }
    @Oblivious event ObliviousEvent Action[string]
    @Oblivious func ObliviousMethod(p string) string { return p }
    func PlainMethod(p string) string { return p }
    func ParameterOnly(@Oblivious p string, q string) string { return q }
}`, "Holder")
        AssertPlatform(TypeSymbol.String, Field(holder, "ObliviousField"))
        Assert.Same(TypeSymbol.String, Field(holder, "PlainField"))
        AssertPlatform(TypeSymbol.String, Property(holder, "ObliviousProp"))
        Assert.Same(TypeSymbol.String, Property(holder, "PlainProp"))
        Assert.IsType[PlatformTypeSymbol](Assert.Single(holder.Events).Type)
        let oblivious = Method(holder, "ObliviousMethod")
        AssertPlatform(TypeSymbol.String, oblivious.Parameters.Single().Type)
        AssertPlatform(TypeSymbol.String, oblivious.Type)
        let plain = Method(holder, "PlainMethod")
        Assert.Same(TypeSymbol.String, plain.Parameters.Single().Type)
        Assert.Same(TypeSymbol.String, plain.Type)
        let parameterOnly = Method(holder, "ParameterOnly")
        AssertPlatform(TypeSymbol.String, parameterOnly.Parameters[0].Type)
        Assert.Same(TypeSymbol.String, parameterOnly.Parameters[1].Type)
        Assert.Same(TypeSymbol.String, parameterOnly.Type)
    }

    /// Only <em>unadorned reference</em> positions change. `T?` keeps
    /// the nullability it states, a value type has no oblivious reading
    /// (ADR-0186 §2: there is no `int32!`), and an open type parameter
    /// keeps §2's exclusion — its nullability arrives with its type argument.
    /// Only the top level of the slot's type changes: nested positions (type
    /// arguments, elements, map keys and values, function-type parameters and
    /// returns) stay exactly as written. This is the owner's 2026-09-25
    /// amendment to open question 12. Step 5 had wrapped nested positions too,
    /// which made every container handed to or from an enabled declaration
    /// an error under §3 rule 3.
    @Fact
    func Only_The_Top_Level_Of_An_Unadorned_Reference_Position_Becomes_Platform() {
        let holder = BindStruct(`@Oblivious
class Holder[T] {
    var Stated string?
    var Number int32
    var MaybeNumber int32?
    var Open T
    var Names List[string]
    var MaybeNames List[string?]
    var Slice []string
    var ElementNullable []string?
    var Lookup map[string]List[string]
    var Callback (string) -> string
}`, "Holder")
        Assert.IsType[NullableTypeSymbol](Field(holder, "Stated"))
        Assert.Same(TypeSymbol.Int32, Field(holder, "Number"))
        Assert.IsNotType[PlatformTypeSymbol](Field(holder, "MaybeNumber"))
        Assert.IsType[TypeParameterSymbol](Field(holder, "Open"))
        let names = Assert.IsType[PlatformTypeSymbol](Field(holder, "Names"))
        Assert.Same(TypeSymbol.String, TypeArgument(names.UnderlyingType, 0))
        let maybeNames = Assert.IsType[PlatformTypeSymbol](Field(holder, "MaybeNames"))
        Assert.IsType[NullableTypeSymbol](TypeArgument(maybeNames.UnderlyingType, 0))
        let slice = Assert.IsType[SliceTypeSymbol](
            Assert.IsType[PlatformTypeSymbol](Field(holder, "Slice")).UnderlyingType
        )
        Assert.Same(TypeSymbol.String, slice.ElementType)
        let elementNullable = Assert.IsType[SliceTypeSymbol](
            Assert.IsType[PlatformTypeSymbol](Field(holder, "ElementNullable")).UnderlyingType
        )
        Assert.IsType[NullableTypeSymbol](elementNullable.ElementType)
        let lookup = Assert.IsType[MapTypeSymbol](
            Assert.IsType[PlatformTypeSymbol](Field(holder, "Lookup")).UnderlyingType
        )
        Assert.Same(TypeSymbol.String, lookup.KeyType)
        Assert.IsNotType[PlatformTypeSymbol](lookup.ValueType)
        Assert.Same(TypeSymbol.String, TypeArgument(lookup.ValueType, 0))
        let callback = Assert.IsType[FunctionTypeSymbol](
            Assert.IsType[PlatformTypeSymbol](Field(holder, "Callback")).UnderlyingType
        )
        Assert.Same(TypeSymbol.String, callback.ParameterTypes.Single())
        Assert.Same(TypeSymbol.String, callback.ReturnType)
    }

    // ---------------------------------------------------------------
    // Body positions — ADR-0186 open question 12.
    // ---------------------------------------------------------------
    /// Open question 12: an oblivious scope reaches every type-writing
    /// position inside it, not only declaration signatures — explicitly-typed
    /// `var` / `let` locals, `for`-range variables, inline
    /// `out` declarations, and lambda parameters and returns.
    @Fact
    func An_Oblivious_Function_Reaches_Every_Type_Written_In_Its_Body() {
        let locals = BindLocals(`class Holder {
    @Oblivious
    func Body(xs List[string]) {
        var mutable string = nil
        let readOnly string = mutable
        for item string in xs {
            mutable = item
        }
        let lookup = Dictionary[string, string]{}
        let found = lookup.TryGetValue("k", out var value string)
        let outCopy = value
        let arrow = (a string) -> a
        let literal = func(a string) string { return a }
        let construction = List[string]{}
    }
}`)
        AssertPlatform(TypeSymbol.String, locals["mutable"])
        AssertPlatform(TypeSymbol.String, locals["readOnly"])
        AssertPlatform(TypeSymbol.String, locals["item"])
        // An inline `out` declaration is not a local declaration node of its
        // own, so it is observed through a copy — whose inferred type is the
        // declared one.
        AssertPlatform(TypeSymbol.String, locals["outCopy"])
        let arrow = Assert.IsType[FunctionTypeSymbol](locals["arrow"])
        AssertPlatform(TypeSymbol.String, arrow.ParameterTypes.Single())
        AssertPlatform(TypeSymbol.String, arrow.ReturnType)
        let literal = Assert.IsType[FunctionTypeSymbol](locals["literal"])
        AssertPlatform(TypeSymbol.String, literal.ParameterTypes.Single())
        AssertPlatform(TypeSymbol.String, literal.ReturnType)
        // A construction target is not a slot, so the new list is non-null,
        // and its type argument is nested, so it stays as written:
        // `List[string]`, the same element an oblivious `List[string]`
        // declaration (`List[string]!`) has.
        let construction = locals["construction"]
        Assert.IsNotType[PlatformTypeSymbol](construction)
        Assert.Same(TypeSymbol.String, TypeArgument(construction, 0))
    }

    /// The oblivious-scope rule an oblivious body depends on end to end:
    /// `nil` can be stored in, passed to and returned from every
    /// position the scope reaches (ADR-0186 §3's `nil → T!` row, which
    /// nothing could reach from source before step 5), and an oblivious
    /// `List[string]` declaration accepts an oblivious
    /// `List[string]{}`.
    @Fact
    func Nil_Flows_Into_Every_Position_An_Oblivious_Scope_Reaches() {
        let output = Run(`@Oblivious
class Holder {
    var Name string
    prop Title string { get; set }
    func Echo(value string) string { return value }
    func Body() string {
        var local string = nil
        // A nil element needs a nilable element type: nested
        // positions stay as written in an oblivious scope.
        var xs List[string?] = List[string?]{}
        xs.Add(nil)
        for item string in xs {
            local = item
        }
        let lambda = func(a string) string { return a }
        this.Name = nil
        this.Title = nil
        return lambda(this.Echo(local))
    }
}

let h = Holder{}
Console.WriteLine(h.Body() == nil)
Console.WriteLine(h.Echo(nil) == nil)`)
        Assert.Equal(`True
True
`, output.Replace("\r\n", "\n"))
    }

    /// A test-introduced binding is non-null because the test succeeded, not
    /// because anything was checked (ADR-0186 §4), so its top level stays
    /// `T` even in an oblivious scope. Pinned here for a `catch`
    /// variable; type patterns and `if let` bindings follow the same
    /// classification in `ObliviousScope.IsValuePosition`.
    @Fact
    func Test_Introduced_Bindings_Stay_NonNull_In_An_Oblivious_Scope() {
        let locals = BindLocals(`class Holder {
    @Oblivious
    func Body(o object) {
        try {
            Console.WriteLine(o)
        } catch (e Exception) {
            Console.WriteLine(e.Message)
        }
    }
}`)
        Assert.IsNotType[PlatformTypeSymbol](locals["e"])
        Assert.IsNotType[NullableTypeSymbol](locals["e"])
    }

    /// The top level of a type written for a reason other than declaring a
    /// slot is not a position: a base class, an implemented interface. Were
    /// it wrapped, an oblivious class could not name its own base.
    @Fact
    func A_Base_Type_List_Is_Not_A_Position() {
        let derived = BindStruct(`open class Base {
    open func Name() string { return "base" }
}

@Oblivious
class Derived : Base, IComparable[string] {
    override func Name() string { return "derived" }
    func CompareTo(other string) int32 { return 0 }
}`, "Derived")
        Assert.Equal("Base", derived.BaseType?.Name)
    }

    /// `@Oblivious { … }` on a block — the analogue of a C#
    /// `#nullable disable` region inside a method body — scopes exactly
    /// the types written between its braces.
    @Fact
    func Oblivious_On_A_Block_Scopes_Exactly_That_Block() {
        let locals = BindLocals(`class Holder {
    func Body() {
        var before string = ""
        @Oblivious {
            var inside string = nil
            Console.WriteLine(inside)
        }
        var after string = ""
        Console.WriteLine(before + after)
    }
}`)
        Assert.Same(TypeSymbol.String, locals["before"])
        AssertPlatform(TypeSymbol.String, locals["inside"])
        Assert.Same(TypeSymbol.String, locals["after"])
    }

    // ---------------------------------------------------------------
    // The compilation level, and precedence.
    // ---------------------------------------------------------------
    /// `--nullability=oblivious` makes every unadorned reference position
    /// in the compilation oblivious, with no annotation anywhere; the default
    /// mode leaves the same source untouched.
    @Fact
    func The_Compilation_Switch_Makes_Every_Declaration_Oblivious() {
        const source = `class Holder {
    var Field string
    func Method(p string) string { return p }
}`
        let oblivious = BindStruct(source, "Holder", NullabilityMode.Oblivious)
        AssertPlatform(TypeSymbol.String, Field(oblivious, "Field"))
        AssertPlatform(TypeSymbol.String, Method(oblivious, "Method").Parameters.Single().Type)
        let enabled = BindStruct(
            source.Replace("var Field string", "var Field string = \"\"", StringComparison.Ordinal),
            "Holder",
            NullabilityMode.PlatformTypes
        )
        Assert.Same(TypeSymbol.String, Field(enabled, "Field"))
        Assert.Same(TypeSymbol.String, Method(enabled, "Method").Parameters.Single().Type)
    }

    /// "Declaration-level always wins", and the nearest declaration wins over
    /// an outer one: `@NullabilityEnabled` on a type overrides an
    /// oblivious compilation; `@Oblivious` on a method re-enters
    /// obliviousness inside that type; `@NullabilityEnabled` on one
    /// parameter leaves that one parameter enabled inside the oblivious method.
    @Fact
    func The_Nearest_Annotation_Wins_Over_Outer_Ones_And_The_Compilation_Default() {
        let types = BindStructs(`class Default {
    var Field string
}

@NullabilityEnabled
class Enabled {
    var Field string = ""
    func Plain(p string) string { return p }
    @Oblivious
    func Oblivious(p string, @NullabilityEnabled q string) string { return p }
}`, NullabilityMode.Oblivious)
        AssertPlatform(TypeSymbol.String, Field(types["Default"], "Field"))
        let enabled = types["Enabled"]
        Assert.Same(TypeSymbol.String, Field(enabled, "Field"))
        let plain = Method(enabled, "Plain")
        Assert.Same(TypeSymbol.String, plain.Parameters.Single().Type)
        Assert.Same(TypeSymbol.String, plain.Type)
        let oblivious = Method(enabled, "Oblivious")
        AssertPlatform(TypeSymbol.String, oblivious.Parameters[0].Type)
        Assert.Same(TypeSymbol.String, oblivious.Parameters[1].Type)
        AssertPlatform(TypeSymbol.String, oblivious.Type)
    }

    /// Under ADR-0136's reading (`--nullability=enabled`) nothing
    /// constructs a (cref:PlatformTypeSymbol). An `@Oblivious`
    /// declaration then reads as that mode reads every oblivious position —
    /// `T?` — so it agrees with how its own emitted metadata re-imports
    /// under the same mode.
    @Fact
    func Under_The_Legacy_Reading_Oblivious_Means_What_That_Reading_Says() {
        let holder = BindStruct(`@Oblivious
class Holder {
    var Field string
}`, "Holder", NullabilityMode.Enabled)
        let field = Assert.IsType[NullableTypeSymbol](Field(holder, "Field"))
        Assert.Same(TypeSymbol.String, field.UnderlyingType)
    }

    // ---------------------------------------------------------------
    // The check at the boundary into enabled code.
    // ---------------------------------------------------------------
    /// A value from an oblivious G# declaration crossing into an enabled
    /// non-null parameter gets ADR-0186 §4's check, exactly as an oblivious
    /// imported value does — §9 makes G#-declared members platform-typed, and
    /// they follow the same rule.
    @Fact
    func An_Oblivious_Member_Flowing_Into_Enabled_Code_Is_Checked() {
        let failure = Assert.Throws[NullReferenceException](
            func () object? {
                return Run(`@Oblivious
class Source {
    var Name string
}

func Consume(value string) int32 { return value.Length }

let s = Source{}
Console.WriteLine(Consume(s.Name))`)
            }
        )
        Assert.Contains("nullability-oblivious", failure.Message, StringComparison.Ordinal)
    }

    // ---------------------------------------------------------------
    // Platform-wrapped G# types: the shapes step 5 made reachable.
    // ---------------------------------------------------------------
    /// Before step 5 a platform wrapper only ever covered an imported type,
    /// which carries a `ClrType`. An oblivious scope wraps G#-declared
    /// classes, interfaces, function types, delegates and channels too, and
    /// each of these shapes failed to compile or emit until the check it hit
    /// learned to read through the wrapper: an upcast between two G#
    /// classes (`Derived! → Base!`, previously an emitter crash),
    /// invoking a function-typed and a named-delegate-typed slot
    /// (`'f' is not a function`), sending on and receiving from a
    /// channel, a platform type argument against a class-base constraint,
    /// an iterator and an async function with oblivious signatures, and a
    /// structural projection into an oblivious slot.
    @Fact
    func Platform_Wrapped_Source_Types_Bind_Emit_And_Run() {
        let output = Run(`open class Animal {
    open func Name() string { return "animal" }
}

class Dog : Animal {
    override func Name() string { return "dog" }
}

delegate Shout(s string) string;

data class Person(Name string, Age int64) {}

func Describe[T Animal](a T) string { return a.Name() }

@Oblivious
class Zoo {
    func Upcast() string {
        var dog Dog = Dog{}
        var animal Animal = dog
        return animal.Name()
    }

    func Invoke() string {
        var f (string) -> string = (s string) -> s + "!"
        var loud Shout = (s string) -> s + "?"
        return f("fn") + loud("delegate")
    }

    func Channels() int32 {
        var ch chan[int32] = chan[int32](1)
        ch <- 7
        return <-ch
    }

    func Constrained() string {
        var dog Dog = Dog{}
        return Describe(dog) + Describe[Dog](dog)
    }

    func Iterate(xs List[string]) IEnumerable[string] {
        for x string in xs {
            yield x
        }
    }

    async func Later(s string) Task[string] {
        await Task.Yield()
        return s
    }

    func Project() string {
        var person Person = data object { let Name = "Ada"; let Age = 36 }
        return person.Name
    }
}

let zoo = Zoo{}
Console.WriteLine(zoo.Upcast())
Console.WriteLine(zoo.Invoke())
Console.WriteLine(zoo.Channels())
Console.WriteLine(zoo.Constrained())
Console.WriteLine(zoo.Iterate(nil) == nil)
Console.WriteLine(zoo.Later("later").Result)
Console.WriteLine(zoo.Project())`, `import System.Linq
import System.Threading.Tasks
`)
        Assert.Equal(`dog
fn!delegate?
7
dogdog
False
later
Ada
`, output.Replace("\r\n", "\n"))
    }

    /// An oblivious iterator and async function whose signatures are
    /// platform-wrapped at the top level (`IEnumerable[string?]!`,
    /// `Task[string?]!`) still read the element and awaited type
    /// through the wrapper. Before the structural helpers did that, they
    /// answered the erased type, and a nil element threw. The element type
    /// is nested, so it is what the source writes: `string?` here
    /// carries a nil. A `string` element would be non-null, as
    /// (cref:A_Nested_Position_In_An_Oblivious_Scope_Is_Not_Platform)
    /// pins.
    @Fact
    func Oblivious_Iterators_And_Async_Functions_Carry_Nil_Elements() {
        let output = Run(`@Oblivious
class Source {
    func Items() IEnumerable[string?] {
        let xs List[string?] = List[string?]{"a", nil}
        for x string? in xs {
            yield x
        }
    }

    async func Later() Task[string?] {
        await Task.Yield()
        return nil
    }
}

let s = Source{}
Console.WriteLine(s.Items().Count())
Console.WriteLine(s.Later().Result == nil)`, `import System.Linq
import System.Threading.Tasks
`)
        Assert.Equal(`2
True
`, output.Replace("\r\n", "\n"))
    }

    /// A nested position in an oblivious scope is exactly what it spells, so
    /// an unadorned element is non-null: storing a nil into an element of an
    /// oblivious `[]string` (now `[]!string`) is GS0155, as it is
    /// outside the scope. This is
    /// the owner's 2026-09-25 amendment to open question 12.
    @Fact
    func A_Nested_Position_In_An_Oblivious_Scope_Is_Not_Platform() {
        let compilation = Compile(`@Oblivious
class Source {
    func Items() []string {
        var xs []string = []string{"a"}
        xs[0] = nil
        return xs
    }
}`, NullabilityMode.PlatformTypes)
        // A binding diagnostic, so the bound program is enough; no emit. The
        // nil store is the only error, so nothing else can make this pass.
        let error = Assert.Single(compilation.BoundProgram.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0155", error.Id)
    }

    /// A conformance clause is exempt from the scope rule, nested positions
    /// included. An oblivious `class Bag : IEnumerable[Item]` used to
    /// declare `IEnumerable[Item!]`, which no member matched, so the
    /// generic `GetEnumerator` slot was left without an implementation:
    /// no diagnostic, and a `TypeLoadException` at run time. The
    /// implementing members are still oblivious (`IEnumerator[Item!]!`)
    /// and still match the slot, and a pattern `for … in` over the type
    /// still sees `Item`'s members through the platform enumerator.
    @Fact
    func An_Oblivious_Type_Implements_Its_Interfaces() {
        let output = Run(`class Item {
    var Value int32
}

@Oblivious
class Bag : IEnumerable[Item] {
    func GetEnumerator() IEnumerator[Item] {
        var items = List[Item]()
        items.Add(Item{Value: 6})
        return items.GetEnumerator()
    }

    private func (IEnumerable) GetEnumerator() IEnumerator { return GetEnumerator() }
}

var total = 0
for item in Bag{} {
    total = total + item.Value
}

Console.WriteLine(total)`, "import System.Collections\n")
        Assert.Equal("6\n", output.Replace("\r\n", "\n"))
    }

    /// Three shapes found in review (PR #4357): a user pattern enumerator
    /// returned from an oblivious `GetEnumerator` (the binder read its
    /// shape through the wrapper but lowering did not), an identifier-form
    /// array literal assigned to an oblivious `[]string` (now
    /// `[]!string`: the element is nested and stays as written, so the
    /// literal's `[]string` converts at the top level), and the
    /// two-value receive `let (v, ok) = <-ch` on an oblivious
    /// channel whose element is written `string?`.
    @Fact
    func Pattern_Enumerators_Array_Literals_And_Two_Value_Receives() {
        let output = Run(`class Counter {
    var Current int32
    func MoveNext() bool {
        this.Current = this.Current + 1
        return this.Current <= 3
    }
}

@Oblivious
class Numbers {
    func GetEnumerator() Counter { return Counter{} }

    func Literal() int32 {
        var xs []string = []string{"a", "b"}
        return xs.Length
    }

    func Receive() string {
        var ch chan[string?] = chan[string?](1)
        ch <- nil
        let (value, ok) = <-ch
        return if ok && value == nil { "nil received" } else { "?" }
    }
}

var sum = 0
for n in Numbers{} {
    sum = sum + n
}

let numbers = Numbers{}
Console.WriteLine(sum)
Console.WriteLine(numbers.Literal())
Console.WriteLine(numbers.Receive())`)
        Assert.Equal(`6
2
nil received
`, output.Replace("\r\n", "\n"))
    }

    /// The two-value receive checks a nil platform channel like the
    /// single-value receive does (ADR-0186 §4), rather than handing it to the
    /// channel runtime.
    @Fact
    func A_Two_Value_Receive_From_A_Nil_Oblivious_Channel_Is_Checked() {
        let failure = Assert.Throws[NullReferenceException](
            func () object? {
                return Run(`@Oblivious
class Source {
    var Channel chan[int32]

    func Drain() bool {
        let (value, ok) = <-this.Channel
        return ok
    }
}

Console.WriteLine(Source{}.Drain())`)
            }
        )
        Assert.Contains("nullability-oblivious", failure.Message, StringComparison.Ordinal)
    }

    /// Found in review (PR #4357): source signature matching had no platform
    /// arm, so an oblivious class could neither implement an enabled G#
    /// interface method nor override an enabled base method written over a
    /// G# class (`Item! -> Item!` against `Item -> Item`): GS0187
    /// and GS0185. `T!` has `T`'s signature; and since oblivious
    /// states nothing, an oblivious member also matches a slot written
    /// `Item?`.
    @Fact
    func An_Oblivious_Type_Implements_And_Overrides_Enabled_Source_Signatures() {
        let output = Run(`class Item {
    var Value int32
}

interface IMaker {
    func Make(x Item) Item;
    func Maybe(x Item?) Item?;
}

open class Base {
    open func Twice(x Item) Item { return x }
}

@Oblivious
class Maker : Base, IMaker {
    func Make(x Item) Item { return x }
    func Maybe(x Item) Item { return x }
    override func Twice(x Item) Item { return x }
}

let m IMaker = Maker{}
let b Base = Maker{}
Console.WriteLine(m.Make(Item{Value: 3}).Value)
Console.WriteLine(m.Maybe(nil) == nil)
Console.WriteLine(b.Twice(Item{Value: 4}).Value)`)
        Assert.Equal(`3
True
4
`, output.Replace("\r\n", "\n"))
    }

    /// Found in review (PR #4357): two more coercions to non-null that must
    /// carry ADR-0186 §4's attributable check — a nil enumerator from an
    /// oblivious `GetEnumerator`, and awaiting a nil oblivious task.
    /// @param body The top-level statement that trips the check.
    /// @param boundary The boundary the message must name.
    @Theory
    @InlineData("for n in Numbers{} { Console.WriteLine(n) }", "a pattern enumerator returned by GetEnumerator")
    @InlineData("Console.WriteLine(Numbers{}.Awaits().Result)", "an awaited operand")
    func Nil_Enumerators_And_Nil_Awaited_Tasks_Are_Checked(body string, boundary string) {
        let failure = Assert.ThrowsAny[Exception](
            func () object? {
                return Run((`class Counter {
    var Current int32
    func MoveNext() bool { return false }
}

@Oblivious
class Numbers {
    func GetEnumerator() Counter { return nil }
    func Pending() Task[int32] { return nil }
    async func Awaits() Task[int32] { return await this.Pending() }
}

` + "$body"), "import System.Threading.Tasks\n")
            }
        )
        let nre = failure as NullReferenceException ?? Assert.IsType[NullReferenceException](failure.InnerException)
        Assert.Contains(boundary, nre.Message, StringComparison.Ordinal)
    }

    /// The native-interop exemption reaches a qualified
    /// `@System.Runtime.InteropServices.DllImport` too (found in review,
    /// PR #4357): the P/Invoke binder recognises it by CLR identity, and
    /// without the exemption its `string` parameter became
    /// `string!`, against which `@MarshalAs(UnmanagedType.LPWStr)`
    /// is rejected (GS0358).
    @Fact
    func A_Qualified_DllImport_Signature_Is_Exempt() {
        let compilation = Compile(
            "@System.Runtime.InteropServices.DllImport(\"libc\")\nfunc wcslen(@MarshalAs(UnmanagedType.LPWStr) s string) nint;",
            NullabilityMode.Oblivious,
            "import System.Runtime.InteropServices\n"
        )
        compilation.AssemblyName = "Adr0186NativeExemption"
        // The marshalling classifier reports at emit, so emit.
        using let pe = MemoryStream()
        let emit = compilation.Emit(pe, pdbStream: nil, refStream: nil, assemblyName: compilation.AssemblyName)
        AssertNoErrors(emit.Diagnostics)
    }

    /// Three more conformance shapes found in review (PR #4357): an explicit
    /// implementation of a generic source interface (its qualifier names the
    /// exempt base-list entry, so it is a conformance clause too), a static
    /// (`shared`) interface member, and a settable interface property
    /// written `Item?` — each implemented from an oblivious type.
    @Fact
    func An_Oblivious_Type_Implements_Explicit_Static_And_Settable_Slots() {
        let output = Run(`class Item {
    var Value int32
}

interface IBox[T] {
    func Get() T;
}

interface IFactory {
    shared {
        func Make(x Item) Item;
    }
}

interface IHolder {
    prop Current Item? { get; set }
}

@Oblivious
class Impl : IBox[Item], IFactory, IHolder {
    private func (IBox[Item]) Get() Item { return Item{Value: 5} }

    shared {
        func Make(x Item) Item { return x }
    }

    prop Current Item { get; set }
}

let box IBox[Item] = Impl{}
let holder IHolder = Impl{}
holder.Current = nil
Console.WriteLine(box.Get().Value)
Console.WriteLine(Impl.Make(Item{Value: 6}).Value)
Console.WriteLine(holder.Current == nil)`)
        Assert.Equal(`5
6
True
`, output.Replace("\r\n", "\n"))
    }

    /// Oblivious members conforming to enabled slots through nested
    /// positions (found in review, PR #4357): a function-typed parameter
    /// `(Item) -> Item` and a tuple return written over a G# class,
    /// and a static member typed `List[Item]?`. Since the owner's
    /// 2026-09-25 amendment to open question 12 the nested positions stay as
    /// written, so these match their slots position for position; the test
    /// pins that they still conform.
    @Fact
    func Nested_Positions_Conform_As_Written() {
        let output = Run(`class Item {
    var Value int32
}

interface IApply {
    func Apply(f (Item) -> Item, x Item) Item;
    func Pair(x Item) (Item, int32);
}

interface IAll {
    shared {
        func All() List[Item]?;
    }
}

@Oblivious
class Impl : IApply, IAll {
    func Apply(f (Item) -> Item, x Item) Item { return f(x) }
    func Pair(x Item) (Item, int32) { return (x, x.Value) }

    shared {
        func All() List[Item]? { return nil }
    }
}

let apply IApply = Impl{}
Console.WriteLine(apply.Apply((i Item) -> i, Item{Value: 7}).Value)
Console.WriteLine(apply.Pair(Item{Value: 8}).Item2)
Console.WriteLine(Impl.All() == nil)`)
        Assert.Equal(`7
8
True
`, output.Replace("\r\n", "\n"))
    }

    /// An explicit `await` on a call to a suspending function (ADR-0174
    /// D4: already awaited implicitly) whose logical result is oblivious
    /// (found in review, PR #4357). The §4 check on an awaited operand must
    /// not run first: it would hide the completed call from the redundant-
    /// await test and assert a legitimate nil result.
    @Fact
    func Awaiting_A_Suspending_Call_With_An_Oblivious_Result_Is_Not_Checked() {
        let output = Run(`@Oblivious
suspend func read(ch in chan[string?]) string {
    return <-ch
}

@Oblivious
suspend func run() bool {
    let ch = chan[string?](1)
    ch <- nil
    let value = await read(ch)
    return value == nil
}

Console.WriteLine(run())`)
        Assert.Equal("True\n", output.Replace("\r\n", "\n"))
    }

    /// Scope lookup across many disjoint annotated declarations, with nested
    /// ones and unannotated ones between them: every member reads the scope
    /// that actually encloses it (the lookup climbs the enclosing chain, not
    /// the earlier siblings).
    @Fact
    func Scope_Lookup_Finds_The_Enclosing_Scope_Among_Many_Siblings() {
        let source = StringBuilder()
        for var i = 0; i < 40; i++ {
            source.AppendLine((`@Oblivious class O` + "$i" + ` { var F string
 @NullabilityEnabled func M(p string) string { return p } }`))
            source.AppendLine("class E$i { var F string = \"\" }")
        }
        let types = BindStructs(source.ToString(), NullabilityMode.PlatformTypes)
        for var i = 0; i < 40; i++ {
            AssertPlatform(TypeSymbol.String, Field(types["O$i"], "F"))
            Assert.Same(TypeSymbol.String, Method(types["O$i"], "M").Parameters.Single().Type)
            Assert.Same(TypeSymbol.String, Field(types["E$i"], "F"))
        }
    }

    /// A `cast[T]` target is not a slot (found in review, PR #4357):
    /// in an oblivious scope `cast[string](o)` still produces a non-null
    /// `string`, not `string!`.
    @Fact
    func A_Cast_Target_Is_Not_A_Position() {
        let locals = BindLocals(`class Holder {
    @Oblivious
    func Body(o object) {
        let casted = cast[string](o)
        Console.WriteLine(casted)
    }
}`)
        Assert.Same(TypeSymbol.String, locals["casted"])
    }

    /// A select arm awaiting a task checks a nil oblivious task like a plain
    /// `await` does (found in review, PR #4357).
    @Fact
    func A_Select_Await_Of_A_Nil_Oblivious_Task_Is_Checked() {
        let failure = Assert.ThrowsAny[Exception](
            func () object? {
                return Run(`@Oblivious
class Source {
    func Pending() Task[int32] { return nil }

    async func Pick() Task[string] {
        let never = chan[int32]()
        let t = this.Pending()
        select {
        case let v = await t {
            return "task=" + v.ToString()
        }
        case <-never {
            return "never"
        }
        }
    }
}

Console.WriteLine(Source{}.Pick().Result)`, "import System.Threading.Tasks\n")
            }
        )
        let nre = failure as NullReferenceException ?? Assert.IsType[NullReferenceException](failure.InnerException)
        Assert.Contains("an awaited select case task", nre.Message, StringComparison.Ordinal)
    }

    /// The native-interop exemption is for the BCL attributes only. A user
    /// attribute that merely shares the simple name, spelled with its own
    /// qualifier, is not native interop, so its function's signature is
    /// oblivious like any other (found in review, PR #4357).
    @Fact
    func A_Differently_Qualified_DllImport_Is_Not_Exempt() {
        // The qualified user attribute does not resolve (GS0198) — which is
        // beside the point: the scope rule decides by spelling, before any
        // attribute binds, and only the parameter's type is asserted.
        let scope_ = Compile(`class Holder {
    @MyInterop.DllImport
    func Send(s string) string { return s }
}`, NullabilityMode.Oblivious).GlobalScope
        let holder = Assert.Single(scope_.Structs, (s StructSymbol) -> s.Name == "Holder")
        AssertPlatform(TypeSymbol.String, Method(holder, "Send").Parameters.Single().Type)
    }

    // ---------------------------------------------------------------
    // GS9307.
    // ---------------------------------------------------------------
    /// Neither annotation takes arguments or a target specifier, and the two
    /// cannot be combined — each is GS9307, never a silent pick.
    /// @param declaration The malformed declaration.
    /// @param expected A fragment of the expected message.
    @Theory
    @InlineData("@Oblivious(true) class Holder { }", "'@Oblivious' takes no arguments")
    @InlineData("@NullabilityEnabled(1) class Holder { }", "'@NullabilityEnabled' takes no arguments")
    @InlineData("@Oblivious @NullabilityEnabled class Holder { }", "cannot be combined with @Oblivious")
    @InlineData("class Holder { @field:Oblivious var F string }", "'@Oblivious' takes no target specifier")
    @InlineData("@Oblivious() class Holder { }", "'@Oblivious' takes no arguments")
    @InlineData("@NullabilityEnabled() class Holder { }", "'@NullabilityEnabled' takes no arguments")
    func Malformed_Scope_Annotations_Report_GS9307(declaration string, expected string) {
        let diagnostics = Compile(declaration, NullabilityMode.PlatformTypes).GlobalScope.Diagnostics
        let diagnostic = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS9307")
        Assert.Contains(expected, diagnostic.Message, StringComparison.Ordinal)
    }

    /// Both annotations are compiler-intrinsic: they resolve no attribute
    /// type, so a well-formed one reports nothing at all.
    @Fact
    func Well_Formed_Scope_Annotations_Report_Nothing() {
        let diagnostics = Compile(`@Oblivious class A { var F string }
@NullabilityEnabled class B { var F string = "" }
class C {
    func M(@Oblivious p string, @NullabilityEnabled q string) {
        @Oblivious {
            var s string = nil
            Console.WriteLine(s)
        }
    }
}`, NullabilityMode.PlatformTypes).BoundProgram.Diagnostics
        AssertNoErrors(diagnostics)
    }

    /// Records the declared type of every local a bound body introduces.
    private class LocalTypeCollector : BoundTreeWalker {
        init() {
            Types = Dictionary[string, TypeSymbol](StringComparer.Ordinal)
        }

        internal prop Types Dictionary[string, TypeSymbol] {
            get;
        }

        protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
            this.Types[node.Variable.Name] = node.Variable.Type
            base.VisitVariableDeclaration(node)
        }

        protected override func VisitForRangeStatement(node BoundForRangeStatement) {
            this.Types[node.ValueVariable.Name] = node.ValueVariable.Type
            base.VisitForRangeStatement(node)
        }

        protected override func VisitTryStatement(node BoundTryStatement) {
            for clause in node.CatchClauses {
                if clause.Variable is {} variable {
                    this.Types[variable.Name] = variable.Type
                }
            }
            base.VisitTryStatement(node)
        }
    }

    shared {
        private const Prelude string = `package Probe
import System
import System.Collections.Generic
`

        // ---------------------------------------------------------------
        // Helpers.
        // ---------------------------------------------------------------
        private func AssertNoErrors(diagnostics IEnumerable[Diagnostic]) {
            let errors = diagnostics
                .Where((d Diagnostic) -> d.IsError)
                .Select((d Diagnostic) -> "${d.Id}: ${d.Message}")
                .ToArray()
            Assert.True(errors.Length == 0, string.Join(Environment.NewLine, errors))
        }

        private func AssertPlatform(expectedUnderlying TypeSymbol, actual TypeSymbol) {
            let platform = Assert.IsType[PlatformTypeSymbol](actual)
            Assert.Same(expectedUnderlying, platform.UnderlyingType)
        }

        // A constructed CLR type whose arguments carry no symbolic information
        // (every argument is exactly what its CLR type says) is kept erased, with
        // no symbolic argument list; its argument is then read off the CLR type.
        private func TypeArgument(type TypeSymbol, index int32) TypeSymbol -> switch type {
            case ImportedTypeSymbol{
                TypeArguments: {Length: 0},
                ClrType: {IsGenericType: true, IsGenericTypeDefinition: false} clr
            }: TypeSymbol.FromClrType(clr.GetGenericArguments()[index])
            case imported is ImportedTypeSymbol: imported.TypeArguments[index]
            case delegate is DelegateTypeSymbol: delegate.TypeArguments[index]
            case struct_ is StructSymbol: struct_.TypeArguments[index]
            default: throw InvalidOperationException("'$type' (${type.GetType().Name}) carries no type arguments.")
        }

        private func Field(type StructSymbol, name string) TypeSymbol -> Assert.Single(
            type.Fields,
            (f FieldSymbol) -> f.Name == name
        )
            .Type

        private func Property(type StructSymbol, name string) TypeSymbol -> Assert.Single(
            type.Properties,
            (p PropertySymbol) -> p.Name == name
        )
            .Type

        private func Method(type StructSymbol, name string) FunctionSymbol -> Assert.Single(
            type.Methods,
            (m FunctionSymbol) -> m.Name == name
        )

        private func Compile(declarations string, mode NullabilityMode, extraImports string = "") GsCompilation {
            return GsCompilation(SyntaxTree.Parse(SourceText.From(Prelude + extraImports + declarations))){
                Nullability = mode
            }
        }

        private func BindStruct(
            declarations string,
            name string,
            mode NullabilityMode = NullabilityMode.PlatformTypes
        ) StructSymbol -> BindStructs(declarations, mode)[name]

        private func BindStructs(declarations string, mode NullabilityMode) Dictionary[string, StructSymbol] {
            let scope_ = Compile(declarations, mode).GlobalScope
            AssertNoErrors(scope_.Diagnostics)
            return scope_.Structs.ToDictionary(
                func (s StructSymbol) string {
                    return s.Name
                },
                StringComparer.Ordinal
            )
        }

        private func BindLocals(declarations string, mode NullabilityMode = NullabilityMode.PlatformTypes) Dictionary[
            string,
            TypeSymbol
        ] {
            let program = Compile(declarations, mode).BoundProgram
            AssertNoErrors(program.Diagnostics)
            let collector = LocalTypeCollector()
            for function in program.Functions {
                collector.Visit(function.Value)
            }
            return collector.Types
        }

        private func Run(declarations string, extraImports string = "") string {
            let compilation = Compile(declarations, NullabilityMode.PlatformTypes, extraImports)
            compilation.AssemblyName = "Adr0186ObliviousScope"
            using let pe = MemoryStream()
            let emit = compilation.Emit(pe, pdbStream: nil, refStream: nil, assemblyName: compilation.AssemblyName)
            Assert.True(
                emit.Success,
                string.Join(Environment.NewLine, emit.Diagnostics.Select((d Diagnostic) -> "${d.Id}: ${d.Message}"))
            )
            let context = AssemblyLoadContext(
                "Adr0186ObliviousScopeTests" + Guid.NewGuid().ToString("N"),
                isCollectible: true
            )
            try {
                pe.Position = 0
                let assembly = context.LoadFromStream(pe)
                let entry = Assert.IsAssignableFrom[MethodInfo](assembly.EntryPoint)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry.Invoke(
                        nil,
                        if entry.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } catch (invocation TargetInvocationException) when invocation.InnerException != nil {
                    throw invocation.InnerException
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                context.Unload()
            }
        }
    }
}
