// <copyright file="Adr0186ObliviousScopeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0186 step 5 — §9: declaring obliviousness in G# source, through the
/// compilation switch (<c>--nullability=oblivious</c>) and the
/// <c>@Oblivious</c> / <c>@NullabilityEnabled</c> annotations.
/// <para>
/// Every assertion reads a bound <em>type</em>, because that is what §9
/// changes: an unadorned reference position inside an oblivious scope is
/// <c>T!</c> (<see cref="PlatformTypeSymbol"/>), <c>T?</c> is still
/// <c>T?</c>, and a value type or open type parameter has no oblivious
/// reading at all. Open question 12 is why the body positions are here too:
/// cs2gs writes explicitly-typed locals, <c>for</c> variables, <c>out</c>
/// declarations and lambda signatures, and a scope rule that stopped at
/// declaration signatures would leave every one of them non-null.
/// </para>
/// </summary>
public class Adr0186ObliviousScopeTests
{
    private const string Prelude = """
        package Probe
        import System
        import System.Collections.Generic

        """;

    // ---------------------------------------------------------------
    // Declaration positions: the six ADR-0047 positions §9 names.
    // ---------------------------------------------------------------

    /// <summary>
    /// <c>@Oblivious</c> on a <b>type</b> reaches every signature position of
    /// every member: field, property, event, method parameter and return.
    /// </summary>
    [Fact]
    public void Oblivious_On_A_Type_Reaches_Every_Member_Signature()
    {
        var holder = BindStruct(
            """
            @Oblivious
            class Holder {
                var Field string
                prop Prop string { get; set }
                event Changed Action[string]
                func Method(p string) string { return p }
            }
            """,
            "Holder");

        AssertPlatform(TypeSymbol.String, Field(holder, "Field"));
        AssertPlatform(TypeSymbol.String, Property(holder, "Prop"));
        var method = Method(holder, "Method");
        AssertPlatform(TypeSymbol.String, method.Parameters.Single().Type);
        AssertPlatform(TypeSymbol.String, method.Type);

        // The event's own type is the delegate, and its type argument is a
        // position of it.
        var @event = Assert.Single(holder.Events, e => e.Name == "Changed");
        var eventType = Assert.IsType<PlatformTypeSymbol>(@event.Type);
        AssertPlatform(TypeSymbol.String, TypeArgument(eventType.UnderlyingType, 0));
    }

    /// <summary>
    /// Each of the member-level positions takes the annotation on its own,
    /// and it reaches only that member: an unannotated sibling in the same
    /// (enabled) type is unchanged.
    /// </summary>
    [Fact]
    public void Oblivious_On_A_Single_Member_Reaches_Only_That_Member()
    {
        var holder = BindStruct(
            """
            class Holder {
                @Oblivious var ObliviousField string
                var PlainField string = ""
                @Oblivious prop ObliviousProp string { get; set }
                prop PlainProp string { get; set }
                @Oblivious event ObliviousEvent Action[string]
                @Oblivious func ObliviousMethod(p string) string { return p }
                func PlainMethod(p string) string { return p }
                func ParameterOnly(@Oblivious p string, q string) string { return q }
            }
            """,
            "Holder");

        AssertPlatform(TypeSymbol.String, Field(holder, "ObliviousField"));
        Assert.Same(TypeSymbol.String, Field(holder, "PlainField"));
        AssertPlatform(TypeSymbol.String, Property(holder, "ObliviousProp"));
        Assert.Same(TypeSymbol.String, Property(holder, "PlainProp"));
        Assert.IsType<PlatformTypeSymbol>(Assert.Single(holder.Events).Type);

        var oblivious = Method(holder, "ObliviousMethod");
        AssertPlatform(TypeSymbol.String, oblivious.Parameters.Single().Type);
        AssertPlatform(TypeSymbol.String, oblivious.Type);

        var plain = Method(holder, "PlainMethod");
        Assert.Same(TypeSymbol.String, plain.Parameters.Single().Type);
        Assert.Same(TypeSymbol.String, plain.Type);

        var parameterOnly = Method(holder, "ParameterOnly");
        AssertPlatform(TypeSymbol.String, parameterOnly.Parameters[0].Type);
        Assert.Same(TypeSymbol.String, parameterOnly.Parameters[1].Type);
        Assert.Same(TypeSymbol.String, parameterOnly.Type);
    }

    /// <summary>
    /// Only <em>unadorned reference</em> positions change. <c>T?</c> keeps
    /// the nullability it states, a value type has no oblivious reading
    /// (ADR-0186 §2: there is no <c>int32!</c>), and an open type parameter
    /// keeps §2's exclusion — its nullability arrives with its type argument.
    /// Nested positions of a written type are positions too.
    /// </summary>
    [Fact]
    public void Only_Unadorned_Reference_Positions_Become_Platform_Including_Nested_Ones()
    {
        var holder = BindStruct(
            """
            @Oblivious
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
            }
            """,
            "Holder");

        Assert.IsType<NullableTypeSymbol>(Field(holder, "Stated"));
        Assert.Same(TypeSymbol.Int32, Field(holder, "Number"));
        Assert.IsNotType<PlatformTypeSymbol>(Field(holder, "MaybeNumber"));
        Assert.IsType<TypeParameterSymbol>(Field(holder, "Open"));

        var names = Assert.IsType<PlatformTypeSymbol>(Field(holder, "Names"));
        AssertPlatform(TypeSymbol.String, TypeArgument(names.UnderlyingType, 0));

        var maybeNames = Assert.IsType<PlatformTypeSymbol>(Field(holder, "MaybeNames"));
        Assert.IsType<NullableTypeSymbol>(TypeArgument(maybeNames.UnderlyingType, 0));

        var slice = Assert.IsType<SliceTypeSymbol>(Assert.IsType<PlatformTypeSymbol>(Field(holder, "Slice")).UnderlyingType);
        AssertPlatform(TypeSymbol.String, slice.ElementType);

        var elementNullable = Assert.IsType<SliceTypeSymbol>(Assert.IsType<PlatformTypeSymbol>(Field(holder, "ElementNullable")).UnderlyingType);
        Assert.IsType<NullableTypeSymbol>(elementNullable.ElementType);

        var lookup = Assert.IsType<MapTypeSymbol>(Assert.IsType<PlatformTypeSymbol>(Field(holder, "Lookup")).UnderlyingType);
        AssertPlatform(TypeSymbol.String, lookup.KeyType);
        var lookupValue = Assert.IsType<PlatformTypeSymbol>(lookup.ValueType);
        AssertPlatform(TypeSymbol.String, TypeArgument(lookupValue.UnderlyingType, 0));

        var callback = Assert.IsType<FunctionTypeSymbol>(Assert.IsType<PlatformTypeSymbol>(Field(holder, "Callback")).UnderlyingType);
        AssertPlatform(TypeSymbol.String, callback.ParameterTypes.Single());
        AssertPlatform(TypeSymbol.String, callback.ReturnType);
    }

    // ---------------------------------------------------------------
    // Body positions — ADR-0186 open question 12.
    // ---------------------------------------------------------------

    /// <summary>
    /// Open question 12: an oblivious scope reaches every type-writing
    /// position inside it, not only declaration signatures — explicitly-typed
    /// <c>var</c> / <c>let</c> locals, <c>for</c>-range variables, inline
    /// <c>out</c> declarations, and lambda parameters and returns.
    /// </summary>
    [Fact]
    public void An_Oblivious_Function_Reaches_Every_Type_Written_In_Its_Body()
    {
        var locals = BindLocals(
            """
            class Holder {
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
            }
            """);

        AssertPlatform(TypeSymbol.String, locals["mutable"]);
        AssertPlatform(TypeSymbol.String, locals["readOnly"]);
        AssertPlatform(TypeSymbol.String, locals["item"]);

        // An inline `out` declaration is not a local declaration node of its
        // own, so it is observed through a copy — whose inferred type is the
        // declared one.
        AssertPlatform(TypeSymbol.String, locals["outCopy"]);

        var arrow = Assert.IsType<FunctionTypeSymbol>(locals["arrow"]);
        AssertPlatform(TypeSymbol.String, arrow.ParameterTypes.Single());
        AssertPlatform(TypeSymbol.String, arrow.ReturnType);

        var literal = Assert.IsType<FunctionTypeSymbol>(locals["literal"]);
        AssertPlatform(TypeSymbol.String, literal.ParameterTypes.Single());
        AssertPlatform(TypeSymbol.String, literal.ReturnType);

        // A construction target is not a slot — the new list is non-null —
        // but its type argument is a position, so it is `List[string!]`: the
        // same type an oblivious `List[string]` declaration names. ADR-0186
        // §3 rule 3 gives `C[T]` and `C[T!]` no conversion, so anything else
        // would make `var xs List[string] = List[string]{}` an error.
        var construction = locals["construction"];
        Assert.IsNotType<PlatformTypeSymbol>(construction);
        AssertPlatform(TypeSymbol.String, TypeArgument(construction, 0));
    }

    /// <summary>
    /// The oblivious-scope rule an oblivious body depends on end to end:
    /// <c>nil</c> can be stored in, passed to and returned from every
    /// position the scope reaches (ADR-0186 §3's <c>nil → T!</c> row, which
    /// nothing could reach from source before step 5), and an oblivious
    /// <c>List[string]</c> declaration accepts an oblivious
    /// <c>List[string]{}</c>.
    /// </summary>
    [Fact]
    public void Nil_Flows_Into_Every_Position_An_Oblivious_Scope_Reaches()
    {
        var output = Run(
            """
            @Oblivious
            class Holder {
                var Name string
                prop Title string { get; set }
                func Echo(value string) string { return value }
                func Body() string {
                    var local string = nil
                    var xs List[string] = List[string]{}
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
            Console.WriteLine(h.Echo(nil) == nil)
            """);

        Assert.Equal("True\nTrue\n", output.Replace("\r\n", "\n"));
    }

    /// <summary>
    /// A test-introduced binding is non-null because the test succeeded, not
    /// because anything was checked (ADR-0186 §4), so its top level stays
    /// <c>T</c> even in an oblivious scope. Pinned here for a <c>catch</c>
    /// variable; type patterns and <c>if let</c> bindings follow the same
    /// classification in <c>ObliviousScope.IsValuePosition</c>.
    /// </summary>
    [Fact]
    public void Test_Introduced_Bindings_Stay_NonNull_In_An_Oblivious_Scope()
    {
        var locals = BindLocals(
            """
            class Holder {
                @Oblivious
                func Body(o object) {
                    try {
                        Console.WriteLine(o)
                    } catch (e Exception) {
                        Console.WriteLine(e.Message)
                    }
                }
            }
            """);

        Assert.IsNotType<PlatformTypeSymbol>(locals["e"]);
        Assert.IsNotType<NullableTypeSymbol>(locals["e"]);
    }

    /// <summary>
    /// The top level of a type written for a reason other than declaring a
    /// slot is not a position: a base class, an implemented interface. Were
    /// it wrapped, an oblivious class could not name its own base.
    /// </summary>
    [Fact]
    public void A_Base_Type_List_Is_Not_A_Position()
    {
        var derived = BindStruct(
            """
            open class Base {
                open func Name() string { return "base" }
            }

            @Oblivious
            class Derived : Base, IComparable[string] {
                override func Name() string { return "derived" }
                func CompareTo(other string) int32 { return 0 }
            }
            """,
            "Derived");

        Assert.Equal("Base", derived.BaseType?.Name);
    }

    /// <summary>
    /// <c>@Oblivious { … }</c> on a block — the analogue of a C#
    /// <c>#nullable disable</c> region inside a method body — scopes exactly
    /// the types written between its braces.
    /// </summary>
    [Fact]
    public void Oblivious_On_A_Block_Scopes_Exactly_That_Block()
    {
        var locals = BindLocals(
            """
            class Holder {
                func Body() {
                    var before string = ""
                    @Oblivious {
                        var inside string = nil
                        Console.WriteLine(inside)
                    }
                    var after string = ""
                    Console.WriteLine(before + after)
                }
            }
            """);

        Assert.Same(TypeSymbol.String, locals["before"]);
        AssertPlatform(TypeSymbol.String, locals["inside"]);
        Assert.Same(TypeSymbol.String, locals["after"]);
    }

    // ---------------------------------------------------------------
    // The compilation level, and precedence.
    // ---------------------------------------------------------------

    /// <summary>
    /// <c>--nullability=oblivious</c> makes every unadorned reference position
    /// in the compilation oblivious, with no annotation anywhere; the default
    /// mode leaves the same source untouched.
    /// </summary>
    [Fact]
    public void The_Compilation_Switch_Makes_Every_Declaration_Oblivious()
    {
        const string source = """
            class Holder {
                var Field string
                func Method(p string) string { return p }
            }
            """;

        var oblivious = BindStruct(source, "Holder", NullabilityMode.Oblivious);
        AssertPlatform(TypeSymbol.String, Field(oblivious, "Field"));
        AssertPlatform(TypeSymbol.String, Method(oblivious, "Method").Parameters.Single().Type);

        var enabled = BindStruct(source.Replace("var Field string", "var Field string = \"\"", StringComparison.Ordinal), "Holder", NullabilityMode.PlatformTypes);
        Assert.Same(TypeSymbol.String, Field(enabled, "Field"));
        Assert.Same(TypeSymbol.String, Method(enabled, "Method").Parameters.Single().Type);
    }

    /// <summary>
    /// "Declaration-level always wins", and the nearest declaration wins over
    /// an outer one: <c>@NullabilityEnabled</c> on a type overrides an
    /// oblivious compilation; <c>@Oblivious</c> on a method re-enters
    /// obliviousness inside that type; <c>@NullabilityEnabled</c> on one
    /// parameter leaves that one parameter enabled inside the oblivious method.
    /// </summary>
    [Fact]
    public void The_Nearest_Annotation_Wins_Over_Outer_Ones_And_The_Compilation_Default()
    {
        var types = BindStructs(
            """
            class Default {
                var Field string
            }

            @NullabilityEnabled
            class Enabled {
                var Field string = ""
                func Plain(p string) string { return p }
                @Oblivious
                func Oblivious(p string, @NullabilityEnabled q string) string { return p }
            }
            """,
            NullabilityMode.Oblivious);

        AssertPlatform(TypeSymbol.String, Field(types["Default"], "Field"));

        var enabled = types["Enabled"];
        Assert.Same(TypeSymbol.String, Field(enabled, "Field"));

        var plain = Method(enabled, "Plain");
        Assert.Same(TypeSymbol.String, plain.Parameters.Single().Type);
        Assert.Same(TypeSymbol.String, plain.Type);

        var oblivious = Method(enabled, "Oblivious");
        AssertPlatform(TypeSymbol.String, oblivious.Parameters[0].Type);
        Assert.Same(TypeSymbol.String, oblivious.Parameters[1].Type);
        AssertPlatform(TypeSymbol.String, oblivious.Type);
    }

    /// <summary>
    /// Under ADR-0136's reading (<c>--nullability=enabled</c>) nothing
    /// constructs a <see cref="PlatformTypeSymbol"/>. An <c>@Oblivious</c>
    /// declaration then reads as that mode reads every oblivious position —
    /// <c>T?</c> — so it agrees with how its own emitted metadata re-imports
    /// under the same mode.
    /// </summary>
    [Fact]
    public void Under_The_Legacy_Reading_Oblivious_Means_What_That_Reading_Says()
    {
        var holder = BindStruct(
            """
            @Oblivious
            class Holder {
                var Field string
            }
            """,
            "Holder",
            NullabilityMode.Enabled);

        var field = Assert.IsType<NullableTypeSymbol>(Field(holder, "Field"));
        Assert.Same(TypeSymbol.String, field.UnderlyingType);
    }

    // ---------------------------------------------------------------
    // The check at the boundary into enabled code.
    // ---------------------------------------------------------------

    /// <summary>
    /// A value from an oblivious G# declaration crossing into an enabled
    /// non-null parameter gets ADR-0186 §4's check, exactly as an oblivious
    /// imported value does — §9 makes G#-declared members platform-typed, and
    /// they follow the same rule.
    /// </summary>
    [Fact]
    public void An_Oblivious_Member_Flowing_Into_Enabled_Code_Is_Checked()
    {
        var failure = Assert.Throws<NullReferenceException>(() => Run(
            """
            @Oblivious
            class Source {
                var Name string
            }

            func Consume(value string) int32 { return value.Length }

            let s = Source{}
            Console.WriteLine(Consume(s.Name))
            """));

        Assert.Contains("nullability-oblivious", failure.Message, StringComparison.Ordinal);
    }

    // ---------------------------------------------------------------
    // Platform-wrapped G# types: the shapes step 5 made reachable.
    // ---------------------------------------------------------------

    /// <summary>
    /// Before step 5 a platform wrapper only ever covered an imported type,
    /// which carries a <c>ClrType</c>. An oblivious scope wraps G#-declared
    /// classes, interfaces, function types, delegates and channels too, and
    /// each of these shapes failed to compile or emit until the check it hit
    /// learned to read through the wrapper: an upcast between two G#
    /// classes (<c>Derived! → Base!</c>, previously an emitter crash),
    /// invoking a function-typed and a named-delegate-typed slot
    /// (<c>'f' is not a function</c>), sending on and receiving from a
    /// channel, a platform type argument against a class-base constraint,
    /// an iterator and an async function with oblivious signatures, and a
    /// structural projection into an oblivious slot.
    /// </summary>
    [Fact]
    public void Platform_Wrapped_Source_Types_Bind_Emit_And_Run()
    {
        var output = Run(
            """
            open class Animal {
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
            Console.WriteLine(zoo.Later(nil).Result == nil)
            Console.WriteLine(zoo.Project())
            """,
            "import System.Linq\nimport System.Threading.Tasks\n");

        Assert.Equal(
            "dog\nfn!delegate?\n7\ndogdog\nFalse\nTrue\nAda\n",
            output.Replace("\r\n", "\n"));
    }

    /// <summary>
    /// A <c>yield</c> of an oblivious value from an oblivious iterator, and a
    /// <c>return</c> of one from an oblivious async function, are not
    /// coercions to non-null: the element / awaited type is <c>string!</c>
    /// (a platform <c>IEnumerable[string!]</c> or <c>Task[string!]</c> has
    /// the underlying type's shape). Before the structural helpers read
    /// through the wrapper they answered the erased <c>string</c>, and a nil
    /// element threw.
    /// </summary>
    [Fact]
    public void Oblivious_Iterators_And_Async_Functions_Carry_Nil_Elements()
    {
        var output = Run(
            """
            @Oblivious
            class Source {
                func Items() IEnumerable[string] {
                    let xs List[string] = List[string]{"a", nil}
                    for x string in xs {
                        yield x
                    }
                }

                async func Later() Task[string] {
                    await Task.Yield()
                    return nil
                }
            }

            let s = Source{}
            Console.WriteLine(s.Items().Count())
            Console.WriteLine(s.Later().Result == nil)
            """,
            "import System.Linq\nimport System.Threading.Tasks\n");

        Assert.Equal("2\nTrue\n", output.Replace("\r\n", "\n"));
    }

    /// <summary>
    /// A conformance clause is exempt from the scope rule, nested positions
    /// included. An oblivious <c>class Bag : IEnumerable[Item]</c> used to
    /// declare <c>IEnumerable[Item!]</c>, which no member matched, so the
    /// generic <c>GetEnumerator</c> slot was left without an implementation:
    /// no diagnostic, and a <c>TypeLoadException</c> at run time. The
    /// implementing members are still oblivious (<c>IEnumerator[Item!]!</c>)
    /// and still match the slot, and a pattern <c>for … in</c> over the type
    /// still sees <c>Item</c>'s members through the platform enumerator.
    /// </summary>
    [Fact]
    public void An_Oblivious_Type_Implements_Its_Interfaces()
    {
        var output = Run(
            """
            class Item {
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

            Console.WriteLine(total)
            """,
            "import System.Collections\n");

        Assert.Equal("6\n", output.Replace("\r\n", "\n"));
    }

    /// <summary>
    /// Three shapes found in review (PR #4357): a user pattern enumerator
    /// returned from an oblivious <c>GetEnumerator</c> (the binder read its
    /// shape through the wrapper but lowering did not), an identifier-form
    /// array literal (<c>[]string{…}</c> names its element by a bare token, so
    /// the type-clause hook never saw it), and the two-value receive
    /// <c>let (v, ok) = &lt;-ch</c> on an oblivious channel.
    /// </summary>
    [Fact]
    public void Pattern_Enumerators_Array_Literals_And_Two_Value_Receives()
    {
        var output = Run(
            """
            class Counter {
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
                    var xs []string = []string{"a", nil}
                    return xs.Length
                }

                func Receive() string {
                    var ch chan[string] = chan[string](1)
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
            Console.WriteLine(numbers.Receive())
            """);

        Assert.Equal("6\n2\nnil received\n", output.Replace("\r\n", "\n"));
    }

    /// <summary>
    /// The two-value receive checks a nil platform channel like the
    /// single-value receive does (ADR-0186 §4), rather than handing it to the
    /// channel runtime.
    /// </summary>
    [Fact]
    public void A_Two_Value_Receive_From_A_Nil_Oblivious_Channel_Is_Checked()
    {
        var failure = Assert.Throws<NullReferenceException>(() => Run(
            """
            @Oblivious
            class Source {
                var Channel chan[int32]

                func Drain() bool {
                    let (value, ok) = <-this.Channel
                    return ok
                }
            }

            Console.WriteLine(Source{}.Drain())
            """));

        Assert.Contains("nullability-oblivious", failure.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// Found in review (PR #4357): source signature matching had no platform
    /// arm, so an oblivious class could neither implement an enabled G#
    /// interface method nor override an enabled base method written over a
    /// G# class (<c>Item! -&gt; Item!</c> against <c>Item -&gt; Item</c>): GS0187
    /// and GS0185. <c>T!</c> has <c>T</c>'s signature; and since oblivious
    /// states nothing, an oblivious member also matches a slot written
    /// <c>Item?</c>.
    /// </summary>
    [Fact]
    public void An_Oblivious_Type_Implements_And_Overrides_Enabled_Source_Signatures()
    {
        var output = Run(
            """
            class Item {
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
            Console.WriteLine(b.Twice(Item{Value: 4}).Value)
            """);

        Assert.Equal("3\nTrue\n4\n", output.Replace("\r\n", "\n"));
    }

    /// <summary>
    /// Found in review (PR #4357): two more coercions to non-null that must
    /// carry ADR-0186 §4's attributable check — a nil enumerator from an
    /// oblivious <c>GetEnumerator</c>, and awaiting a nil oblivious task.
    /// </summary>
    /// <param name="body">The top-level statement that trips the check.</param>
    /// <param name="boundary">The boundary the message must name.</param>
    [Theory]
    [InlineData("for n in Numbers{} { Console.WriteLine(n) }", "a pattern enumerator returned by GetEnumerator")]
    [InlineData("Console.WriteLine(Numbers{}.Awaits().Result)", "an awaited operand")]
    public void Nil_Enumerators_And_Nil_Awaited_Tasks_Are_Checked(string body, string boundary)
    {
        var failure = Assert.ThrowsAny<Exception>(() => Run(
            $$"""
            class Counter {
                var Current int32
                func MoveNext() bool { return false }
            }

            @Oblivious
            class Numbers {
                func GetEnumerator() Counter { return nil }
                func Pending() Task[int32] { return nil }
                async func Awaits() Task[int32] { return await this.Pending() }
            }

            {{body}}
            """,
            "import System.Threading.Tasks\n"));

        var nre = failure as NullReferenceException ?? Assert.IsType<NullReferenceException>(failure.InnerException);
        Assert.Contains(boundary, nre.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// The native-interop exemption reaches a qualified
    /// <c>@System.Runtime.InteropServices.DllImport</c> too (found in review,
    /// PR #4357): the P/Invoke binder recognises it by CLR identity, and
    /// without the exemption its <c>string</c> parameter became
    /// <c>string!</c>, against which <c>@MarshalAs(UnmanagedType.LPWStr)</c>
    /// is rejected (GS0358).
    /// </summary>
    [Fact]
    public void A_Qualified_DllImport_Signature_Is_Exempt()
    {
        var compilation = Compile(
            """
            @System.Runtime.InteropServices.DllImport("libc")
            func wcslen(@MarshalAs(UnmanagedType.LPWStr) s string) nint;
            """,
            NullabilityMode.Oblivious,
            "import System.Runtime.InteropServices\n");
        compilation.AssemblyName = "Adr0186NativeExemption";

        // The marshalling classifier reports at emit, so emit.
        using var pe = new MemoryStream();
        var emit = compilation.Emit(pe, pdbStream: null, refStream: null, assemblyName: compilation.AssemblyName);
        AssertNoErrors(emit.Diagnostics);
    }

    /// <summary>
    /// A select arm awaiting a task checks a nil oblivious task like a plain
    /// <c>await</c> does (found in review, PR #4357).
    /// </summary>
    [Fact]
    public void A_Select_Await_Of_A_Nil_Oblivious_Task_Is_Checked()
    {
        var failure = Assert.ThrowsAny<Exception>(() => Run(
            """
            @Oblivious
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

            Console.WriteLine(Source{}.Pick().Result)
            """,
            "import System.Threading.Tasks\n"));

        var nre = failure as NullReferenceException ?? Assert.IsType<NullReferenceException>(failure.InnerException);
        Assert.Contains("an awaited select case task", nre.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// The native-interop exemption is for the BCL attributes only. A user
    /// attribute that merely shares the simple name, spelled with its own
    /// qualifier, is not native interop, so its function's signature is
    /// oblivious like any other (found in review, PR #4357).
    /// </summary>
    [Fact]
    public void A_Differently_Qualified_DllImport_Is_Not_Exempt()
    {
        // The qualified user attribute does not resolve (GS0198) — which is
        // beside the point: the scope rule decides by spelling, before any
        // attribute binds, and only the parameter's type is asserted.
        var scope = Compile(
            """
            class Holder {
                @MyInterop.DllImport
                func Send(s string) string { return s }
            }
            """,
            NullabilityMode.Oblivious).GlobalScope;

        var holder = Assert.Single(scope.Structs, s => s.Name == "Holder");
        AssertPlatform(TypeSymbol.String, Method(holder, "Send").Parameters.Single().Type);
    }

    // ---------------------------------------------------------------
    // GS9307.
    // ---------------------------------------------------------------

    /// <summary>
    /// Neither annotation takes arguments or a target specifier, and the two
    /// cannot be combined — each is GS9307, never a silent pick.
    /// </summary>
    /// <param name="declaration">The malformed declaration.</param>
    /// <param name="expected">A fragment of the expected message.</param>
    [Theory]
    [InlineData("@Oblivious(true) class Holder { }", "'@Oblivious' takes no arguments")]
    [InlineData("@NullabilityEnabled(1) class Holder { }", "'@NullabilityEnabled' takes no arguments")]
    [InlineData("@Oblivious @NullabilityEnabled class Holder { }", "cannot be combined with @Oblivious")]
    [InlineData("class Holder { @field:Oblivious var F string }", "'@Oblivious' takes no target specifier")]
    public void Malformed_Scope_Annotations_Report_GS9307(string declaration, string expected)
    {
        var diagnostics = Compile(declaration, NullabilityMode.PlatformTypes).GlobalScope.Diagnostics;

        var diagnostic = Assert.Single(diagnostics, d => d.Id == "GS9307");
        Assert.Contains(expected, diagnostic.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// Both annotations are compiler-intrinsic: they resolve no attribute
    /// type, so a well-formed one reports nothing at all.
    /// </summary>
    [Fact]
    public void Well_Formed_Scope_Annotations_Report_Nothing()
    {
        var diagnostics = Compile(
            """
            @Oblivious class A { var F string }
            @NullabilityEnabled class B { var F string = "" }
            class C {
                func M(@Oblivious p string, @NullabilityEnabled q string) {
                    @Oblivious {
                        var s string = nil
                        Console.WriteLine(s)
                    }
                }
            }
            """,
            NullabilityMode.PlatformTypes).BoundProgram.Diagnostics;

        AssertNoErrors(diagnostics);
    }

    // ---------------------------------------------------------------
    // Helpers.
    // ---------------------------------------------------------------

    private static void AssertNoErrors(IEnumerable<Diagnostic> diagnostics)
    {
        var errors = diagnostics.Where(d => d.IsError).Select(d => $"{d.Id}: {d.Message}").ToArray();
        Assert.True(errors.Length == 0, string.Join(Environment.NewLine, errors));
    }

    private static void AssertPlatform(TypeSymbol expectedUnderlying, TypeSymbol actual)
    {
        var platform = Assert.IsType<PlatformTypeSymbol>(actual);
        Assert.Same(expectedUnderlying, platform.UnderlyingType);
    }

    private static TypeSymbol TypeArgument(TypeSymbol type, int index) => type switch
    {
        ImportedTypeSymbol imported => imported.TypeArguments[index],
        DelegateTypeSymbol @delegate => @delegate.TypeArguments[index],
        StructSymbol @struct => @struct.TypeArguments[index],
        _ => throw new InvalidOperationException($"'{type}' ({type.GetType().Name}) carries no type arguments."),
    };

    private static TypeSymbol Field(StructSymbol type, string name)
        => Assert.Single(type.Fields, f => f.Name == name).Type;

    private static TypeSymbol Property(StructSymbol type, string name)
        => Assert.Single(type.Properties, p => p.Name == name).Type;

    private static FunctionSymbol Method(StructSymbol type, string name)
        => Assert.Single(type.Methods, m => m.Name == name);

    private static GsCompilation Compile(string declarations, NullabilityMode mode, string extraImports = "")
    {
        return new GsCompilation(SyntaxTree.Parse(SourceText.From(Prelude + extraImports + declarations)))
        {
            Nullability = mode,
        };
    }

    private static StructSymbol BindStruct(string declarations, string name, NullabilityMode mode = NullabilityMode.PlatformTypes)
        => BindStructs(declarations, mode)[name];

    private static Dictionary<string, StructSymbol> BindStructs(string declarations, NullabilityMode mode)
    {
        var scope = Compile(declarations, mode).GlobalScope;
        AssertNoErrors(scope.Diagnostics);
        return scope.Structs.ToDictionary(s => s.Name, StringComparer.Ordinal);
    }

    private static Dictionary<string, TypeSymbol> BindLocals(string declarations, NullabilityMode mode = NullabilityMode.PlatformTypes)
    {
        var program = Compile(declarations, mode).BoundProgram;
        AssertNoErrors(program.Diagnostics);

        var collector = new LocalTypeCollector();
        foreach (var function in program.Functions)
        {
            collector.Visit(function.Value);
        }

        return collector.Types;
    }

    private static string Run(string declarations, string extraImports = "")
    {
        var compilation = Compile(declarations, NullabilityMode.PlatformTypes, extraImports);
        compilation.AssemblyName = "Adr0186ObliviousScope";
        using var pe = new MemoryStream();
        var emit = compilation.Emit(pe, pdbStream: null, refStream: null, assemblyName: compilation.AssemblyName);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics.Select(d => $"{d.Id}: {d.Message}")));

        var context = new AssemblyLoadContext(nameof(Adr0186ObliviousScopeTests) + Guid.NewGuid().ToString("N"), isCollectible: true);
        try
        {
            pe.Position = 0;
            var assembly = context.LoadFromStream(pe);
            var entry = Assert.IsAssignableFrom<MethodInfo>(assembly.EntryPoint);
            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            catch (TargetInvocationException invocation) when (invocation.InnerException != null)
            {
                throw invocation.InnerException;
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            context.Unload();
        }
    }

    /// <summary>Records the declared type of every local a bound body introduces.</summary>
    private sealed class LocalTypeCollector : BoundTreeWalker
    {
        internal Dictionary<string, TypeSymbol> Types { get; } = new(StringComparer.Ordinal);

        protected override void VisitVariableDeclaration(BoundVariableDeclaration node)
        {
            this.Types[node.Variable.Name] = node.Variable.Type;
            base.VisitVariableDeclaration(node);
        }

        protected override void VisitForRangeStatement(BoundForRangeStatement node)
        {
            this.Types[node.ValueVariable.Name] = node.ValueVariable.Type;
            base.VisitForRangeStatement(node);
        }

        protected override void VisitTryStatement(BoundTryStatement node)
        {
            foreach (var clause in node.CatchClauses)
            {
                if (clause.Variable is { } variable)
                {
                    this.Types[variable.Name] = variable.Type;
                }
            }

            base.VisitTryStatement(node);
        }
    }
}
