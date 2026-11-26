package GSharp.Compiler.Tests.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Text
import Xunit

class Issue6231ScopedSymbolsTests {
    @Fact
    func Driver_AllExplicitConstructorsInactive_StillResolvesImportedOptionalBaseConstructor() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`namespace OptionalBase6231 {
    public class Parent {
        public int Value { get; }
        public Parent(int value = 7) { Value = value; }
    }
}`, "OptionalBase6231")
        let frozen = File.ReadAllBytes(library)
        let program = fixture.Compile(`import System
import OptionalBase6231
class Derived : Parent { @If(false) init() { Missing() } }
Console.Write(Derived().Value)`, "OptionalBaseConsumer6231", true, "/r:" + library)
        IlVerifier.Verify(program, []string{library})
        Assert.Equal(Encoding.UTF8.GetBytes("7"), fixture.RunBytes(program))
        Assert.Equal(frozen, File.ReadAllBytes(library))
    }

    @Fact
    func Driver_InactiveRequiredBodies_PreserveActiveConditionsAndHeaders() {
        AssertOutput(`import System
var conditions = 0
func Next() bool { conditions++ return false }
func Gate() object { Console.Write("L") return Object() }
if true @If(false) { Missing() }
if false {} else @If(false) { Missing() }
for Next() @If(false) { Missing() }
for var i = 0; i < 2; i++ @If(false) { Missing() }
for item in []int32{1, 2} @If(false) { Missing() }
lock Gate() @If(false) { Missing() }
Console.Write(conditions)`, "L1")
    }

    @Fact
    func Driver_IntrinsicLedStatements_EvaluateArgumentsAtBothEntryPoints() {
        AssertOutput(`import System
@file:DefineSymbol("A")
func Next() bool { Console.Write("x") return true }
func Local() { @defined("A").Equals(Next()) }
@defined("A")
@defined("A").Equals(Next())
Local()`, "xx")
    }

    @Fact
    func Driver_AllLocalDeclarationForms_PreserveAnnotationsAndOwnOnlyTheirInitializers() {
        AssertOutput(`import System
data struct Flag { var Value bool }
func Read() {
    @DefineSymbol("A") let (a, b) = (@defined("A"), @defined("A"))
    @DefineSymbol("A") let { Value = c } = Flag{Value: @defined("A")}
    @DefineSymbol("A") let d, let e = @defined("A"), @defined("A")
    @MissingAttribute @If(false) let (missingA, missingB) = Unavailable()
    @If(false) let { Missing = missingC } = Unavailable()
    @If(false) let missingD, let missingE = Unavailable(), Unavailable()
    @If(false) async let missingAsync = Unavailable()
    Console.Write(a)
    Console.Write(b)
    Console.Write(c)
    Console.Write(d)
    Console.Write(e)
    Console.Write(@defined("A"))
}
Read()`, "TrueTrueTrueTrueTrueFalse")
    }

    @Fact
    func Driver_DeclarationAndAccessorEnvironments_CoverOnlyTheirOwnedSyntax() {
        AssertOutput(`import System
@DefineSymbol("TYPE")
class Owner {
    @DefineSymbol("FIELD") var Field bool = @defined("FIELD")
    var Other bool = @defined("FIELD")
    @DefineSymbol("CTOR") init() {
        Console.Write(@defined("CTOR"))
        Console.Write(@defined("FIELD"))
    }
    @DefineSymbol("PROPERTY") prop Value bool {
        @UndefineSymbol("PROPERTY") get { return @defined("PROPERTY") }
    }
    @DefineSymbol("METHOD") func Read() bool {
        return @defined("METHOD") && @defined("TYPE") && !@defined("CTOR")
    }
}
let owner = Owner()
Console.Write(owner.Field)
Console.Write(owner.Other)
Console.Write(owner.Value)
Console.Write(owner.Read())`, "TrueFalseTrueFalseFalseTrue")
    }

    @Fact
    func Driver_DefinedAttributeArgument_EmitsBooleanConstant() {
        AssertOutput(`import System
import System.ComponentModel
@DefineSymbol("A")
@DefaultValue(@defined("A"))
class Marked {}
Console.Write(typeof(Marked).GetCustomAttributesData()[0].ConstructorArguments[0].Value)`, "True")
    }

    @Fact
    func Driver_InactiveTopLevelReturnAndAwait_DoNotChangeEntryPointShape() {
        AssertOutput(`import System
if true {
    @If(false) {
        let missing = await Unavailable()
        return 17
    }
}
Console.Write("x")
return`, "x")
    }

    @Fact
    func Driver_LocalFunctionsAndInitializers_KeepOnlyTheirOwnEnvironment() {
        AssertOutput(`import System
func Read() {
    @DefineSymbol("A") let first = @defined("A")
    let second = @defined("A")
    @DefineSymbolAttribute("A") let Local = func() bool { return @defined("A") }
    @If(false) let MissingLocal = func() Missing { return Missing() }
    @If(true) let Selected = func() int32 { return 3 }
    Console.Write(first)
    Console.Write(second)
    Console.Write(Local())
    Console.Write(Selected())
    Console.Write(@defined("A"))
}
Read()`, "TrueFalseTrue3False")
    }

    @Fact
    func Driver_ScopedCalls_PreserveArgumentsAndMutableStructStorage() {
        AssertOutput(`import System
import System.Diagnostics
var arguments = 0
func Next() int32 {
    arguments++
    return 2
}
struct Counter {
    var Value int32
    @Conditional("A")
    func Add(value int32) { Value += value }
}
var counter = default(Counter)
counter.Add(Next())
@DefineSymbol("A") { counter.Add(Next()) }
counter.Add(Next())
Console.Write(arguments)
Console.Write(counter.Value)`, "12")
    }

    @Fact
    func Driver_ImportedScopedCalls_ElideReceiverAndArgumentsWithoutChangingMetadata() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`using System.Diagnostics;
namespace ScopedImport6231 {
    public static class State {
        public static int Arguments, Receivers, Calls;
        public static int Next() { Arguments++; return 2; }
        public static Counter Receiver() { Receivers++; return default; }
    }
    public struct Counter {
        public int Value;
        [Conditional("A"), Conditional("B")]
        public void Keep(int value) { Value += value; State.Calls++; }
    }
}`, "ScopedImport6231")
        let frozen = File.ReadAllBytes(library)
        let program = fixture.Compile(`import System
import ScopedImport6231
var counter = default(Counter)
counter.Keep(State.Next())
State.Receiver().Keep(State.Next())
@DefineSymbol("A") {
    counter.Keep(State.Next())
    State.Receiver().Keep(State.Next())
    @UndefineSymbol("A") {
        counter.Keep(State.Next())
        State.Receiver().Keep(State.Next())
    }
}
Console.Write(State.Arguments)
Console.Write(State.Receivers)
Console.Write(State.Calls)
Console.Write(counter.Value)`, "ScopedImportConsumer6231", true, "/r:" + library)
        IlVerifier.Verify(program, []string{library})
        Assert.Equal(Encoding.UTF8.GetBytes("2122"), fixture.RunBytes(program))
        Assert.Equal(frozen, File.ReadAllBytes(library))
    }

    @Fact
    func Driver_FileAndPartialScopes_DoNotLeak_AndInactiveFileImportsAreIgnored() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let other = Path.Combine(fixture.Directory, "other.gs")
        let hidden = Path.Combine(fixture.Directory, "hidden.gs")
        File.WriteAllText(other, `import System
@file:UndefineSymbol("A")
partial class Box {
    func Second() bool -> @defined("A")
}
@If(@defined("A")) func Forbidden() Missing -> Missing()`)
        File.WriteAllText(hidden, `import Never.Exists
@file:If(false)
@Missing
func Hidden() Missing -> Missing()`)
        let program = fixture.Compile(`import System
@file:DefineSymbol("A")
partial class Box {
    func First() bool -> @defined("A")
}
Console.Write(Box().First())
Console.Write(Box().Second())`, "ScopedFiles6231", true, other, hidden)
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes("TrueFalse"), fixture.RunBytes(program))
    }

    @Fact
    func Driver_InactiveWritesAndLabels_DoNotDiscardLoopOrClosureFacts() {
        AssertOutput(`import System
func Read(s string?) int32 {
    if s == nil { return 0 }
    @If(false) let capture = func() { s = nil }
    var once = true
    while once {
        @If(false) {
            s = nil
            Hidden: goto Hidden
        }
        Console.Write(s.Length)
        once = false
    }
    return s.Length
}
Console.Write(Read("xy"))`, "22")
    }

    @Fact
    func Driver_NearestScopesAndLexicalLambda_DoNotLeak() {
        AssertOutput(`import System
import System.Diagnostics
@file:DefineSymbol("A")
@Conditional("A")
@Conditional("B")
func Log(value string) { Console.Write(value) }
@UndefineSymbol("A")
func Quiet() {
    Log("bad")
    @DefineSymbol("B") {
        let run = () -> Log("L")
        run()
    }
    Log("bad")
}
Quiet()
Log("A")
@UndefineSymbol("A") { Log("bad") }
Log("Z")`, "LAZ")
    }

    @Fact
    func Driver_DefinedIsConstantAndDoesNotHideOrdinaryFunction() {
        AssertOutput(`import System
@file:DefineSymbol("A", "class")
func defined(value string) bool { return value == "ordinary" }
class definedAttribute : Attribute { init(value string) {} }
@defined("ordinary") class Marked {}
const present = @defined("A")
const absent = @defined("a")
Console.Write(typeof(Marked).GetCustomAttributesData()[0].ConstructorArguments[0].Value)
Console.Write(present)
Console.Write(absent)
Console.Write(defined("ordinary"))
Console.Write(@defined("class"))
@UndefineSymbol("A") { Console.Write(@defined("A")) }
Console.Write(@defined("A"))
Console.Write(if @defined("A") { 1 } else { 2 })`, "ordinaryTrueFalseTrueTrueFalseTrue1")
    }

    @Fact
    func Driver_InactiveAlternativesAndMembers_AreNotBoundOrEmitted() {
        AssertOutput(`import System
@If(false)
@MissingAttribute
func Value() MissingType { return Missing() }
@If(true)
func Value() int32 { return 7 }
class Box {
    @If(false)
    var Bad MissingType = Missing()
    @If(false)
    func Read() MissingType { return Missing() }
    @If(true)
    func Read() int32 { return Value() }
}
Console.Write(Box().Read())`, "7")
    }

    @Fact
    func Driver_InclusionUsesStrictAncestors_AndActiveEnumOrder() {
        AssertOutput(`import System
@DefineSymbol("SELF")
@If(@defined("SELF"))
func Value() MissingType { return Missing() }
@If(!@defined("SELF"))
func Value() int32 { return 9 }
@DefineSymbol("INNER")
class Box {
    @If(@defined("INNER"))
    func Read() bool { return @defined("INNER") }
}
enum Choice {
    First,
    @If(false) Removed,
    Last
}
Console.Write(Value())
Console.Write(Box().Read())
Console.Write(int32(Choice.Last))`, "9True1")
    }

    @Fact
    func Driver_InactiveLocalsAndYield_DoNotAffectFlowOrIteratorClassification() {
        AssertOutput(`import System
func Read() int32 {
    @If(false) let missing = Unavailable()
    @If(false) { yield Unavailable() }
    @If(true) let result = 5
    return result
}
Console.Write(Read())`, "5")
    }

    @Fact
    func SameTree_DifferentCompilationBases_AreIndependent() {
        let tree = SyntaxTree.Parse(SourceText.From(`@If(@defined("A"))
func Selected() int32 { return 1 }
@If(!@defined("A"))
func Selected() int32 { return 2 }
`))
        for enabled in[]bool{false, true, false} {
            let compilation = Compilation(tree){
                IsLibrary = true,
                PreprocessorSymbols = if enabled {
                    ImmutableHashSet.Create("A")
                } else {
                    ImmutableHashSet[string].Empty
                }
            }
            Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
            let declarations = tree.Root.Members.OfType[FunctionDeclarationSyntax]().ToArray()
            Assert.Equal(enabled, compilation.IsActive(declarations[0]))
            Assert.Equal(!enabled, compilation.IsActive(declarations[1]))
            let model = compilation.GetSemanticModel(tree)
            Assert.NotNull(
                model.GetDeclaredSymbol(
                    declarations[
                        if enabled {
                            0
                        } else {
                            1
                        }
                    ]
                )
            )
            Assert.Null(
                model.GetDeclaredSymbol(
                    declarations[
                        if enabled {
                            1
                        } else {
                            0
                        }
                    ]
                )
            )
        }
    }

    @Theory
    @InlineData(`func Run() { if @defined("ABSENT") { Missing() } }`)
    @InlineData(`func Run() int32 { return if @defined("ABSENT") { Missing() } else { 1 } }`)
    func OrdinaryFalseIf_StillChecksBothArms(source string) {
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        let diagnostics = compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.NotEmpty(diagnostics)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Id == "GS0130" && d.Location.Span.Start == source.IndexOf(
                "Missing",
                StringComparison.Ordinal
            )
        )
    }

    private func AssertOutput(source string, expected string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let program = fixture.Compile(source, "ScopedSymbols6231", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes(expected), fixture.RunBytes(program))
    }
}
