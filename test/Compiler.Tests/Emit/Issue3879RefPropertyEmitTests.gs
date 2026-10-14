// <copyright file="Issue3879RefPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #3879 (ADR-0060 amendment): G# gains a by-ref return on `prop` —
/// `prop P ref int32 { get { return ref slot } }`, its arrow sugar
/// `prop P ref int32 -> slot`, and the indexer form
/// `prop this[i int32] ref int32 -> …`. Before this, ADR-0060 gave the
/// by-ref return to `func` only, so cs2gs had nowhere to translate a C#
/// `ref` property into and gapped loudly at the declaration (#3839 / #3878).
///
/// The load-bearing assertion here is BEHAVIOURAL, not a printed shape and not
/// metadata alone: a copy-returning property has the same source spelling at the
/// call site and the same observable behaviour on a read, so only a WRITE through
/// the returned reference discriminates the two. G#'s own ref-alias binder does
/// not accept a call result as an lvalue (the documented #1900 limit), so the
/// alias is not expressible in G# — the proof is a C# driver compiled against the
/// gsc-emitted assembly, taking `ref int slot = ref holder.Property`,
/// writing through it, and reading the storage back through a separate accessor.
/// A copy-returning member reads the old value. This is the same shape PR #3878
/// used to prove the `func` half of #3839.
open class Issue3879RefPropertyEmitTests {
    /// Metadata direction. Both the PropertyDef signature AND the `get_X`
    /// MethodDef signature must encode `T&`: Roslyn only binds
    /// `ref int x = ref obj.P` when the two agree, so encoding one and not
    /// the other yields a property that reflects as by-ref but that no C#
    /// consumer can actually alias.
    @Fact
    func RefPropertyAndIndexer_EmitByRefPropertyAndAccessorSignatures() {
        let library = CompileLibrary(HolderSource, "RefPropertyAndIndexer_EmitByRefPropertyAndAccessorSignatures")
        let loadContext = AssemblyLoadContext(
            "RefPropertyAndIndexer_EmitByRefPropertyAndAccessorSignatures",
            isCollectible: true
        )
        try {
            let holder = LoadHolder(loadContext, library)
            for name in[]string{"Property", "Arrow", "Item"} {
                let property = holder.GetProperty(name) ??
                    throw InvalidOperationException("'$name' is missing from the emitted type.")
                Assert.True(
                    property.PropertyType.IsByRef,
                    "the PropertyDef signature of '$name' must be T&, not T; it was ${property.PropertyType}"
                )
                Assert.True(
                    property.GetMethod!!.ReturnType.IsByRef,
                    "the get_$name MethodDef must return T&; it returned ${property.GetMethod!!.ReturnType}"
                )
                Assert.Equal(typeof(int32).MakeByRefType(), property.GetMethod!!.ReturnType)
                Assert.Null(property.SetMethod)
            }
            // Anti-vacuity: the ordinary property and the ordinary method on the
            // same type keep their by-value signatures.
            Assert.False(
                holder.GetProperty("Plain")!!.PropertyType.IsByRef,
                "a property declared without `ref` must stay by value"
            )
            Assert.False(holder.GetProperty("Plain")!!.GetMethod!!.ReturnType.IsByRef, "get_Plain must stay by value")
            Assert.False(
                holder.GetMethod("Read")!!.ReturnType.IsByRef,
                "a method declared without `ref` must stay by value"
            )
        } finally {
            loadContext.Unload()
        }
    }

    /// The executing proof, and the only assertion in this file that a
    /// copy-returning member cannot also satisfy. A C# driver aliases each of
    /// the three ref members, writes through the alias, and the writes are read
    /// back through `Read` — a by-value accessor over the same array. A
    /// property that returned a copy would leave 40/41/42 in place.
    @Fact
    func RefPropertyAndIndexer_ReturnAliasesThatWriteThrough() {
        let library = CompileLibrary(HolderSource, "RefPropertyAndIndexer_ReturnAliasesThatWriteThrough")
        let loadContext = AssemblyLoadContext(
            "RefPropertyAndIndexer_ReturnAliasesThatWriteThrough",
            isCollectible: true
        )
        try {
            LoadHolder(loadContext, library)
            const DriverSource = `namespace Repro
{
    public static class Driver
    {
        public static int[] Run()
        {
            var holder = new Holder();

            ref int fromProperty = ref holder.Property;
            fromProperty = 99;

            ref int fromArrow = ref holder.Arrow;
            fromArrow = 88;

            ref int fromIndexer = ref holder[2];
            fromIndexer = 77;

            return new[] { holder.Read(0), holder.Read(1), holder.Read(2) };
        }
    }
}`
            let driverPath = CompileCSharpDriver(
                DriverSource,
                library,
                "RefPropertyAndIndexer_ReturnAliasesThatWriteThrough"
            )
            let driver = loadContext.LoadFromAssemblyPath(driverPath)
            let result = driver.GetType("Repro.Driver")!!.GetMethod("Run")!!.Invoke(nil, nil)!!
            Assert.Equal([]int32{99, 88, 77}, Assert.IsType[[]int32](result))
        } finally {
            loadContext.Unload()
        }
    }

    /// The G# side of the same members. G# cannot express the alias (#1900), so
    /// every G# use of a ref-returning member is a value read — which means the
    /// emitted call site has to load THROUGH the returned managed pointer.
    /// Without that load the program is either unverifiable
    /// (`InvalidProgramException`) or prints the raw address as an
    /// `int32`. Read together with the metadata test above (which pins the
    /// getters as genuinely by-ref), printing the stored values proves the
    /// dereference happened rather than the `ref` having been dropped.
    @Fact
    func RefPropertyAndIndexer_ReadFromGSharp_LoadThroughThePointer() {
        const Source = `package Repro
import System

class Holder {
    var values []int32 = []int32{40, 41, 42}

    prop Property ref int32 { get { return ref values[0] } }

    prop Arrow ref int32 -> values[1]

    prop this[index int32] ref int32 -> values[index]
}

var h = Holder{}
Console.WriteLine(h.Property)
Console.WriteLine(h.Arrow)
Console.WriteLine(h[2])`
        let output = CompileAndRun(Source, "RefPropertyAndIndexer_ReadFromGSharp_LoadThroughThePointer")
        Assert.Equal(
            []string{"40", "41", "42"},
            output.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select((line string) -> line.Trim()).ToArray()
        )
    }

    /// GS0578: an auto-property has no storage of its own to name — its getter
    /// copies out of a compiler-synthesized backing field. #3878's GS0219 sweep
    /// showed that backing-field path is exactly where by-ref hazards
    /// concentrate, so the by-ref return is restricted to computed getters.
    @Fact
    func RefAutoProperty_ReportsGS0578() {
        AssertRejected("package P\nclass Holder { prop Slot ref int32 }", "GS0578", "RefAutoProperty_ReportsGS0578")
    }

    /// GS0578 again: a bodiless `{ get }` is an abstract slot or a
    /// read-only auto-property. Either way nothing in the declaration says what
    /// is aliased.
    @Fact
    func BodilessRefProperty_ReportsGS0578() {
        AssertRejected(
            "package P\nopen class Holder { open prop Slot ref int32 { get } }",
            "GS0578",
            "BodilessRefProperty_ReportsGS0578"
        )
    }

    /// GS0578 in an interface. An interface member is a slot, not storage, and
    /// G# has no ref-kind matching for property slots (GS0255 covers methods
    /// only) — so a copy-returning implementation of a `ref` requirement
    /// would go unchecked. Rejected rather than silently accepted.
    @Fact
    func RefPropertyInInterface_ReportsGS0578() {
        AssertRejected(
            "package P\ninterface IHolder { prop Slot ref int32 { get } }",
            "GS0578",
            "RefPropertyInInterface_ReportsGS0578"
        )
    }

    /// GS0579: the returned reference IS the write path, so a setter would be a
    /// second, contradictory one. C# spells the same rule CS8147.
    @Fact
    func RefPropertyWithSetter_ReportsGS0579() {
        AssertRejected(`package P
class Holder {
    var slot int32 = 0
    prop Value ref int32 {
        get { return ref slot }
        set(v) { slot = v }
    }
}`, "GS0579", "RefPropertyWithSetter_ReportsGS0579")
    }

    /// The accessor body is bound with the getter as its enclosing function, so
    /// the existing #490 return-shape rules apply inside it unchanged: a plain
    /// `return` in a ref-returning getter is GS0252, exactly as it is in a
    /// ref-returning `func`. Without this the by-ref-ness would live only
    /// in the signature and the body would silently copy.
    @Fact
    func PlainReturnInRefPropertyGetter_ReportsGS0252() {
        AssertRejected(`package P
class Holder {
    var slot int32 = 0
    prop Value ref int32 { get { return slot } }
}`, "GS0252", "PlainReturnInRefPropertyGetter_ReportsGS0252")
    }

    /// A property literally NAMED `ref` must still parse as an ordinary
    /// property: the modifier is consumed only when a type clause can start at
    /// the next token, and the name is consumed before that test runs.
    @Fact
    func PropertyNamedRef_IsStillAnOrdinaryProperty() {
        let library = CompileLibrary(`package Repro
public class Holder {
    private var x int32 = 1
    public prop ref int32 -> x
}`, "PropertyNamedRef_IsStillAnOrdinaryProperty")
        let loadContext = AssemblyLoadContext("PropertyNamedRef_IsStillAnOrdinaryProperty", isCollectible: true)
        try {
            let holder = LoadHolder(loadContext, library)
            let property = holder.GetProperty("ref") ??
                throw InvalidOperationException("the property named 'ref' is missing from the emitted type.")
            Assert.False(property.PropertyType.IsByRef, "a property NAMED `ref` must not become ref-returning")
        } finally {
            loadContext.Unload()
        }
    }

    /// The read-site dereference is owed by EVERY source-member call branch, not
    /// only by the property access the rest of this file exercises. A plain
    /// `func … ref T` binds to `BoundCallExpression`, a distinct emit
    /// branch — and one that was left unguarded when this file was first
    /// written: reverting its dereference passed all nine original tests. The
    /// symptom is not a crash but a printed RAW ADDRESS, so the assertion has to
    /// be on the value.
    @Fact
    func RefReturningFunc_ReadFromGSharp_LoadsThroughThePointer() {
        const Source = `package Repro
import System

var storage []int32 = []int32{40, 41, 42}

func pickRef(index int32) ref int32 {
    return ref storage[index]
}

Console.WriteLine(pickRef(0))
Console.WriteLine(pickRef(2))`
        let output = CompileAndRun(Source, "RefReturningFunc_ReadFromGSharp_LoadsThroughThePointer")
        Assert.Equal(
            []string{"40", "42"},
            output.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select((line string) -> line.Trim()).ToArray()
        )
    }

    /// `base.RefMethod()` and `base.RefProperty` bind to
    /// `BoundBaseClassCallExpression` — a third emit branch, carrying
    /// EITHER a method or a property accessor. Both arms owe the dereference and
    /// neither had it, so a valid base call preserved the raw-address read this
    /// issue exists to remove.
    @Fact
    func BaseClassRefMembers_ReadFromGSharp_LoadThroughThePointer() {
        const Source = `package Repro
import System

open class Base {
    var values []int32 = []int32{10, 11}

    open prop First ref int32 { get { return ref values[0] } }

    open func At(index int32) ref int32 { return ref values[index] }
}

class Derived : Base {
    func ReadBaseProperty() int32 { return base.First }

    func ReadBaseMethod() int32 { return base.At(1) }
}

var d = Derived{}
Console.WriteLine(d.ReadBaseProperty())
Console.WriteLine(d.ReadBaseMethod())`
        let output = CompileAndRun(Source, "BaseClassRefMembers_ReadFromGSharp_LoadThroughThePointer")
        Assert.Equal(
            []string{"10", "11"},
            output.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select((line string) -> line.Trim()).ToArray()
        )
    }

    /// GS0579, not GS0578. A setter-only `ref` property breaks both rules at
    /// once — it has a write accessor AND no computed getter — and the write
    /// accessor is the more specific answer, because it names the accessor the
    /// author actually wrote instead of sending them after a getter shape.
    @Fact
    func SetterOnlyRefProperty_ReportsGS0579() {
        AssertRejected(`package Repro
public class Holder {
    private var x int32 = 1
    public prop P ref int32 { set(v) { x = v } }
}`, "GS0579", "SetterOnlyRefProperty_ReportsGS0579")
    }

    /// The by-ref return is part of a property's signature, so it has to
    /// participate in override matching. A source base property is found by NAME
    /// alone, so without the ref-kind comparison a `ref` override bound
    /// happily to a by-value base slot — and then returned a managed pointer
    /// through a slot every caller reads by value.
    @Fact
    func RefOverrideOfByValueBaseProperty_ReportsGS0185() {
        AssertRejected(`package Repro
open class Base {
    var slot int32 = 1
    public open prop P int32 -> slot
}

class Derived : Base {
    var own int32 = 2
    public override prop P ref int32 { get { return ref own } }
}`, "GS0185", "RefOverrideOfByValueBaseProperty_ReportsGS0185")
    }

    /// The opposite direction of (cref:RefOverrideOfByValueBaseProperty_ReportsGS0185):
    /// a by-value override must not silently take over a `ref` base slot
    /// either, or callers holding the base contract lose the alias.
    @Fact
    func ByValueOverrideOfRefBaseProperty_ReportsGS0185() {
        AssertRejected(`package Repro
open class Base {
    var slot int32 = 1
    public open prop P ref int32 { get { return ref slot } }
}

class Derived : Base {
    var own int32 = 2
    public override prop P int32 -> own
}`, "GS0185", "ByValueOverrideOfRefBaseProperty_ReportsGS0185")
    }

    shared {
        /// The three ref-returning member forms plus two anti-vacuity neighbours: a
        /// plain (by-value) property and a plain method on the same type, so a
        /// blanket "make every property by-ref" cannot satisfy the assertions.
        private const HolderSource string = (`package Repro

public class Holder {
    private var values []int32 = []int32{40, 41, 42}

    // Block-bodied computed getter: the canonical form.
    public prop Property ref int32 {
        get { return ref values[0] }
    }

    // ADR-0131 arrow sugar. The ` + "`" + `ref` + "`" + ` on the declaration makes the
    // synthesized return a ` + "`" + `return ref` + "`" + `, so the arrow aliases too.
    public prop Arrow ref int32 -> values[1]

    // ADR-0118 indexer, arrow form.
    public prop this[index int32] ref int32 -> values[index]

    // Anti-vacuity: an ordinary property on the same type.
    public prop Plain int32 -> values[0]

    // A separate, by-value read path, so a write through a returned
    // reference is observed through storage rather than through the
    // same member.
    public func Read(index int32) int32 -> values[index]
}`)

        private func LoadHolder(loadContext AssemblyLoadContext, libraryPath string) Type {
            let library = loadContext.LoadFromAssemblyPath(libraryPath)
            return library.GetType("Repro.Holder") ??
                throw InvalidOperationException(
                "Repro.Holder is missing from the emitted assembly: " + string.Join(
                    ", ",
                    library.GetTypes().Select((t Type) -> t.FullName)
                )
            )
        }

        private func AssertRejected(source string, expectedDiagnostic string, testName string) {
            let (exitCode, diagnostics) = CompileTo(
                source,
                Path.Combine(CreateArtifactDirectory(testName), "test.dll"),
                "/target:library"
            )
            Assert.True(exitCode != 0, ("$testName" + `: the source must be rejected. Output:
` + "$diagnostics"))
            // Match "error GS0578", never the bare id. gsc echoes the SOURCE PATH in
            // every diagnostic, and the artifact directory is named after the test —
            // whose own name contains the id. A bare-id assertion is satisfied by the
            // path alone: measured, it passed on a tree with the whole feature
            // reverted. This is the one line standing between this file and vacuity.
            Assert.Contains("error $expectedDiagnostic", diagnostics, StringComparison.Ordinal)
            Assert.DoesNotContain("error GS9998", diagnostics, StringComparison.Ordinal)
        }

        private func CompileLibrary(source string, testName string) string {
            let outputPath = Path.Combine(CreateArtifactDirectory(testName), "Repro.dll")
            let (exitCode, diagnostics) = CompileTo(source, outputPath, "/target:library")
            Assert.True(exitCode == 0, ("$testName" + `: gsc failed:
` + "$diagnostics"))
            return outputPath
        }

        private func CompileAndRun(source string, testName string) string {
            let outputPath = Path.Combine(CreateArtifactDirectory(testName), "Repro.dll")
            let (exitCode, diagnostics) = CompileTo(source, outputPath, "/target:exe")
            Assert.True(exitCode == 0, ("$testName" + `: gsc failed:
` + "$diagnostics"))
            let loadContext = AssemblyLoadContext(testName, isCollectible: true)
            try {
                let assembly = loadContext.LoadFromAssemblyPath(outputPath)
                let program = assembly.GetTypes().First((t Type) -> t.Name == "<Program>")
                let entry = program.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )!!
                let previous = Console.Out
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
                } finally {
                    Console.SetOut(previous)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }

        private func CompileCSharpDriver(driverSource string, libraryPath string, testName string) string {
            let references = List[MetadataReference](
                TrustedPlatformAssemblies().Select(
                    (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
                )
            ){MetadataReference.CreateFromFile(libraryPath)}
            let compilation = CSharpCompilation.Create(
                "Repro.Driver",
                []SyntaxTree{CSharpSyntaxTree.ParseText(driverSource, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let driverPath = Path.Combine(Path.GetDirectoryName(libraryPath)!!, "Repro.Driver.dll")
            let emitted = compilation.Emit(driverPath)
            Assert.True(
                emitted.Success,
                "$testName: the C# driver must compile against the gsc-emitted assembly — if " +
                    "`ref int slot = ref holder.Property` does not compile, the emitted member is not by-ref. " +
                    "Diagnostics:\n" +
                    string.Join(Environment.NewLine, emitted.Diagnostics)
            )
            return driverPath
        }

        private func CompileTo(source string, outputPath string, target string)(ExitCode int32, Diagnostics string) {
            let sourcePath = Path.Combine(Path.GetDirectoryName(outputPath)!!, "test.gs")
            File.WriteAllText(sourcePath, source)
            let args[]string = []string{"/out:" + outputPath, target, "/targetframework:net10.0", sourcePath}
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exitCode int32
            try {
                exitCode = Program.Main(args)
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            return (exitCode, compileOut.ToString() + compileErr.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrEmpty(tpa) {
                Enumerable.Empty[string]()
            } else {
                tpa!!.Split(Path.PathSeparator).Where(File.Exists)
            }
        }

        private func CreateArtifactDirectory(testName string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "issue3879-artifacts",
                testName,
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            return directory
        }
    }
}
