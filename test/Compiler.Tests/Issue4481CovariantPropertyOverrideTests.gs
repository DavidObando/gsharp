// <copyright file="Issue4481CovariantPropertyOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import Xunit

/// Issue #4481: a property override that narrows the base property's type
/// (a C# 9 covariant override, `override PropertySymbol Property { get; }`
/// over `abstract Symbol? Property { get; }`) compiled cleanly but the
/// type failed to load: "Method 'get_Property' ... does not have an
/// implementation".
/// @remarks The binder picked the base property by name and never compared the
/// types, so the override's getter reused the base slot "by name" with a
/// return type the CLR does not treat as the same signature — the base slot
/// was left unimplemented. The migrated `GSharp.Core` hit it on
/// `BoundPropertyAccessExpression.Property` (#4441). The getter now takes
/// a new slot bound to the base getter by a MethodImpl row, with
/// `PreserveBaseOverridesAttribute`, as Roslyn emits it; a type that is
/// not a covariant narrowing is rejected instead of silently accepted.
///
/// Each case compiles, IL-verifies, LOADS and runs, reading the property
/// through the base-typed reference: compiling alone passed before the fix.
/// Every covariant executable case failed with the TypeLoadException before it.
open class Issue4481CovariantPropertyOverrideTests {
    /// Compiles each case, IL-verifies it, runs it, and asserts its output.
    /// @param name The case name.
    /// @param body The G# declarations and top-level statements.
    /// @param expectedLines The expected stdout lines.
    @Theory
    @MemberData("Cases")
    func CovariantPropertyOverride_CompilesVerifiesLoadsAndRuns(name string, body string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4481_").FullName
        try {
            let (exitCode, diagnostics, outPath) = Compile(tempDir, name, body)
            Assert.True(exitCode == 0, (`gsc failed for '` + "$name" + `':
` + "$diagnostics"))
            IlVerifier.Verify(outPath)
            let (exit, output) = RunDotnet(outPath)
            Assert.True(
                exit == 0,
                (`'` + "$name" + `' must load and run (a TypeLoadException is #4481). Exit ` + "$exit" + `:
` + "$output")
            )
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal(expectedLines, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// A type change that is not a covariant narrowing — a value type, an
    /// unrelated type, or a narrowed property that also has a setter — has no
    /// CLR override form, and used to be accepted silently.
    /// @param name The case name.
    /// @param baseType The base property's type.
    /// @param overrideDeclaration The override declaration.
    @Theory
    @InlineData("unrelated-value-type", "int32", "override prop Property string -> \"s\"")
    @InlineData("widening", "PSym", "override prop Property Sym -> Sym(\"s\")")
    @InlineData("narrowing-with-setter", "Sym", "override prop Property PSym { get; set; }")
    func NonCovariantPropertyTypeChange_IsRejected(name string, baseType string, overrideDeclaration string) {
        let body = (`open class Node {
    open prop Property ` + "$baseType" + ` { get; set; }
}

class Access : Node {
    ` + "$overrideDeclaration" + `
}`)
        let tempDir = Directory.CreateTempSubdirectory("gs_4481_").FullName
        try {
            let (exitCode, diagnostics, _) = Compile(tempDir, name, body)
            Assert.True(exitCode != 0, "'$name' must be rejected.")
            Assert.Contains("GS0185", diagnostics, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// A narrowing the CLR covariant-return form cannot express: a by-ref
    /// property (covariant returns are by-value only), or a base with no
    /// getter to bind the override's getter to (the emitter used to throw).
    /// @param name The case name.
    /// @param baseDeclaration The base class member declarations.
    /// @param overrideDeclaration The override class member declarations.
    @Theory
    @InlineData(
        "by-ref-narrowing",
        "var slot Sym = Sym(\"a\")\nopen prop Property ref Sym { get { return ref slot } }",
        "var own PSym = PSym(\"b\")\noverride prop Property ref PSym { get { return ref own } }"
    )
    @InlineData(
        "get-only-narrowing-over-read-write-base",
        "open prop Property Sym { get; set; }",
        "override prop Property PSym -> PSym(\"s\")"
    )
    @InlineData(
        "getter-over-setter-only-base",
        "open prop Property Sym { set { } }",
        "override prop Property PSym -> PSym(\"s\")"
    )
    func NarrowingWithNoCovariantForm_IsRejected(name string, baseDeclaration string, overrideDeclaration string) {
        let body = (`open class Node {
    ` + "$baseDeclaration" + `
}

class Access : Node {
    ` + "$overrideDeclaration" + `
}`)
        let tempDir = Directory.CreateTempSubdirectory("gs_4481_").FullName
        try {
            let (exitCode, diagnostics, _) = Compile(tempDir, name, body)
            Assert.True(exitCode != 0, "'$name' must be rejected.")
            Assert.Contains("GS0185", diagnostics, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The metadata-only (`/refout`) emit writes every accessor through
    /// `MemberDefEmitter`'s fallback path rather than
    /// `FunctionEmitter`, and the two have diverged before (#2870). MSBuild
    /// hands the REFERENCE assembly to downstream compilations, so it must
    /// carry the same covariant shape: `NewSlot`, the MethodImpl row and
    /// `PreserveBaseOverridesAttribute`. A consumer compiled against it
    /// then reads the property through the base at run time.
    @Fact
    func ReferenceAssembly_CarriesTheCovariantShape_AndAConsumerRuns() {
        const library = `package I4481Lib

open class Sym {
    init(name string) {
        Name = name
    }

    prop Name string { get; }
}

class PSym : Sym {
    init(name string) : base(name) {
    }
}

open class Node {
    open prop Property Sym? { get; }
}

class Access : Node {
    init(p PSym) {
        Property = p
    }

    override prop Property PSym { get; }
}`
        const consumer = `package I4481Consumer
import System
import I4481Lib

let n Node = Access(PSym("ref"))
Console.WriteLine(n.Property!!.Name)
let a = Access(PSym("direct"))
Console.WriteLine(a.Property.Name)`
        let tempDir = Directory.CreateTempSubdirectory("gs_4481_ref_").FullName
        try {
            let libSrc = Path.Combine(tempDir, "lib.gs")
            let libDll = Path.Combine(tempDir, "impl", "I4481Lib.dll")
            let libRef = Path.Combine(tempDir, "ref", "I4481Lib.dll")
            Directory.CreateDirectory(
                Path.GetDirectoryName(libDll)!!
            ) // Path.Combine of a directory and a file name has a directory.
            Directory.CreateDirectory(
                Path.GetDirectoryName(libRef)!!
            ) // Path.Combine of a directory and a file name has a directory.
            File.WriteAllText(libSrc, library)
            let (libExit, libDiagnostics) = RunGsc(
                []string{"/out:" + libDll, "/refout:" + libRef, "/target:library", "/targetframework:net10.0", libSrc}
            )
            Assert.True(libExit == 0, "library failed:\n" + libDiagnostics)
            for assembly in[]string{libDll, libRef} {
                let shape = ReadCovariantGetterShape(assembly, "Access", "get_Property")
                Assert.True(
                    (shape.Attributes & MethodAttributes.NewSlot) != 0,
                    "Access::get_Property in $assembly must take a new slot, but is ${shape.Attributes}."
                )
                // Exactly one of each: #4481 and #4508 fixed this independently,
                // and a second emitter of the same rows must not creep back in.
                Assert.Equal(1, shape.MethodImplCount)
                Assert.Equal(1, shape.PreserveBaseOverridesCount)
            }
            let consumerSrc = Path.Combine(tempDir, "consumer.gs")
            let consumerDll = Path.Combine(tempDir, "impl", "consumer.dll")
            File.WriteAllText(consumerSrc, consumer)
            // Compile against the REFERENCE assembly, run beside the implementation.
            let args = List[string]{"/out:" + consumerDll, "/target:exe", "/targetframework:net10.0", "/r:" + libRef}
            args.AddRange(TrustedPlatformAssemblies().Select((reference string) -> ("/reference:" + reference)))
            args.Add(consumerSrc)
            let (consumerExit, consumerDiagnostics) = RunGsc(args.ToArray())
            Assert.True(consumerExit == 0, "consumer failed against the reference assembly:\n" + consumerDiagnostics)
            let (exit, output) = RunDotnet(consumerDll)
            Assert.True(exit == 0, (`consumer must load and run. Exit ` + "$exit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal([]string{"ref", "direct"}, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const Symbols string = `
open class Sym {
    init(name string) {
        Name = name
    }

    prop Name string { get; }
}

class PSym : Sym {
    init(name string) : base(name) {
    }

    prop Tag string -> "p:" + Name
}
`

        /// The executable cases: name, G# source, expected stdout lines.
        /// @returns The cases.
        func Cases() sequence[[]object] {
            // The #4441 shape as written in G#: a get-only auto-property override
            // assigned in the constructor.
            yield[]object{"auto-property", `
open class Node {
    open prop Property Sym? { get; }
}

class Access : Node {
    init(p PSym) {
        Property = p
    }

    override prop Property PSym { get; }
}

let n Node = Access(PSym("x"))
Console.WriteLine(n.Property!!.Name)
let a = Access(PSym("y"))
Console.WriteLine(a.Property.Tag)
`, []string{"x", "p:y"}}
            // The shape cs2gs translates the C# get-only override into: a private
            // backing field and an arrow getter.
            yield[]object{"arrow-getter", `
open class Node {
    open prop Property Sym? { get; }
}

class Access : Node {
    init(p PSym) {
        _property = p
    }

    private var _property PSym
    override prop Property PSym -> _property
}

let n Node = Access(PSym("x"))
Console.WriteLine(n.Property!!.Name)
`, []string{"x"}}
            // A further override of the covariant override reuses ITS slot, and a
            // call through the original base slot still reaches it.
            yield[]object{"chained-override", `
open class Node {
    open prop Property Sym? { get; }
}

open class Access : Node {
    init(p PSym) {
        _property = p
    }

    private var _property PSym
    open override prop Property PSym -> _property
}

class Leaf : Access {
    init(p PSym) : base(p) {
    }

    override prop Property PSym -> PSym("leaf")
}

let n Node = Leaf(PSym("x"))
Console.WriteLine(n.Property!!.Name)
let a Access = Leaf(PSym("y"))
Console.WriteLine(a.Property.Tag)
`, []string{"leaf", "p:leaf"}}
            // The override's type is bound AFTER the overriding class (types are
            // ordered base-first, not by the types their members mention), so its
            // base class is unknown when the override is bound. The migrated
            // GSharp.Core has this order: Binding/ sorts before Symbols/.
            yield[]object{"override-type-declared-later", `
class Access : Node {
    init(p Later) {
        _property = p
    }

    private var _property Later
    override prop Property Later -> _property
}

open class Node {
    open prop Property Sym? { get; }
}

class Later : Sym {
    init(name string) : base(name) {
    }
}

let n Node = Access(Later("x"))
Console.WriteLine(n.Property!!.Name)
`, []string{"x"}}
            // A narrowing to a SOURCE interface: the check must run after interface
            // base clauses and class interface closures are bound, or `IDerived`
            // (and a class implementing `IBase` only through `IDerived`) does not
            // yet convert to `IBase`.
            yield[]object{"interface-and-transitive-narrowing", `
open class Node {
    open prop Property IBase? { get; }
    open prop Other IBase? { get; }
}

class Access : Node {
    init(p Impl) {
        _property = p
        _other = p
    }

    private var _property IDerived
    private var _other Impl
    override prop Property IDerived -> _property
    override prop Other Impl -> _other
}

interface IBase { func Name() string; }
interface IDerived : IBase { }
class Impl : IDerived { func Name() string -> "impl" }

let n Node = Access(Impl())
Console.WriteLine(n.Property!!.Name())
Console.WriteLine(n.Other!!.Name())
`, []string{"impl", "impl"}}
            // Reference nullability is metadata only at every nesting level, so
            // `List[Sym]` over `List[Sym?]` (and the slice / dictionary shapes, which
            // the old top-level-only strip rejected) is the SAME slot type.
            // The setter makes that observable: a type change with a setter has no
            // covariant form, so treating it as one would report GS0185.
            yield[]object{"nested-nullability-same-slot", `
open class Node {
    open prop Items List[Sym?] { get; set; }
    open prop Arr []Sym? { get; set; }
    open prop Map Dictionary[string, Sym?] { get; set; }
}

class Access : Node {
    init(items List[Sym]) {
        Items = items
    }

    override prop Items List[Sym] { get; set; }
    override prop Arr []Sym { get; set; }
    override prop Map Dictionary[string, Sym] { get; set; }
}

let items = List[Sym]()
items.Add(Sym("x"))
let n Node = Access(items)
Console.WriteLine(n.Items[0]!!.Name)
`, []string{"x"}}
            // A constructed generic base: `Node[T].Property` (type `T`) narrowed
            // from `Sym` to `PSym`. Exercises the base-type substitution and the
            // MethodImpl declaration parented at the `Node[Sym]` TypeSpec.
            yield[]object{"constructed-generic-base", `
open class Node[T] {
    open prop Property T { get; }
}

class Access : Node[Sym] {
    init(p PSym) {
        _property = p
    }

    private var _property PSym
    override prop Property PSym -> _property
}

let n Node[Sym] = Access(PSym("x"))
Console.WriteLine(n.Property.Name)
let a = Access(PSym("y"))
Console.WriteLine(a.Property.Tag)
`, []string{"x", "p:y"}}
            // The read resolves the level that DECLARES the bound property, at any
            // depth and whether or not the levels between are generic. A generic
            // leaf over the non-generic covariant override, a generic middle level
            // below it, and a generic level that itself holds the override: each
            // is read through every receiver type in its chain.
            yield[]object{"generic-levels-around-the-override", `
open class Node[T] {
    open prop Property T { get; }
}

open class Access : Node[Sym] {
    init(p PSym) {
        _property = p
    }

    private var _property PSym
    override prop Property PSym -> _property
}

class GenericLeaf[T] : Access {
    init(p PSym) : base(p) {
    }
}

open class Mid[U] : Access {
    init(p PSym) : base(p) {
    }
}

class MidLeaf : Mid[int32] {
    init(p PSym) : base(p) {
    }
}

open class GenericAccess[U] : Node[Sym] {
    init(p PSym) {
        _property = p
    }

    private var _property PSym
    override prop Property PSym -> _property
}

class GenericAccessLeaf : GenericAccess[int32] {
    init(p PSym) : base(p) {
    }
}

let leaf = GenericLeaf[int32](PSym("a"))
Console.WriteLine(leaf.Property.Tag)
let leafAsAccess Access = leaf
Console.WriteLine(leafAsAccess.Property.Tag)
let leafAsNode Node[Sym] = leaf
Console.WriteLine(leafAsNode.Property.Name)

let midLeaf = MidLeaf(PSym("b"))
Console.WriteLine(midLeaf.Property.Tag)
let midLeafAsMid Mid[int32] = midLeaf
Console.WriteLine(midLeafAsMid.Property.Tag)
let midLeafAsNode Node[Sym] = midLeaf
Console.WriteLine(midLeafAsNode.Property.Name)

let genericAccessLeaf = GenericAccessLeaf(PSym("c"))
Console.WriteLine(genericAccessLeaf.Property.Tag)
let genericAccess GenericAccess[int32] = genericAccessLeaf
Console.WriteLine(genericAccess.Property.Tag)
let genericAccessAsNode Node[Sym] = genericAccessLeaf
Console.WriteLine(genericAccessAsNode.Property.Name)
`, []string{"p:a", "p:a", "a", "p:b", "p:b", "b", "p:c", "p:c", "c"}}
            // A same-type override (nullability aside) keeps reusing the base slot.
            yield[]object{"same-type-control", `
open class Node {
    open prop Property Sym? { get; }
}

class Access : Node {
    init(p Sym) {
        Property = p
    }

    override prop Property Sym { get; }
}

let n Node = Access(Sym("x"))
Console.WriteLine(n.Property!!.Name)
`, []string{"x"}}
        }

        private func ReadCovariantGetterShape(assemblyPath string, typeName string, methodName string)(
            Attributes MethodAttributes,
            MethodImplCount int32,
            PreserveBaseOverridesCount int32
        ) {
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            for typeHandle in reader.TypeDefinitions {
                let type = reader.GetTypeDefinition(typeHandle)
                if reader.GetString(type.Name) != typeName {
                    continue
                }
                for methodHandle in type.GetMethods() {
                    let method = reader.GetMethodDefinition(methodHandle)
                    if reader.GetString(method.Name) != methodName {
                        continue
                    }
                    let methodImplCount = type
                        .GetMethodImplementations()
                        .Select(reader.GetMethodImplementation)
                        .Count((impl MethodImplementation) -> impl.MethodBody == EntityHandle(methodHandle))
                    let preserveCount = method
                        .GetCustomAttributes()
                        .Select(reader.GetCustomAttribute)
                        .Count(
                        (attribute CustomAttribute) -> AttributeTypeName(
                            reader,
                            attribute
                        ) == "PreserveBaseOverridesAttribute"
                    )
                    return (method.Attributes, methodImplCount, preserveCount)
                }
            }
            throw InvalidOperationException("'$typeName::$methodName' not found in '$assemblyPath'.")
        }

        private func AttributeTypeName(reader MetadataReader, attribute CustomAttribute) string {
            if attribute.Constructor.Kind != HandleKind.MemberReference {
                return string.Empty
            }
            let parent = reader.GetMemberReference(MemberReferenceHandle(attribute.Constructor)).Parent
            return if parent.Kind == HandleKind.TypeReference {
                reader.GetString(reader.GetTypeReference(TypeReferenceHandle(parent)).Name)
            } else {
                string.Empty
            }
        }

        private func RunGsc(args[]string)(ExitCode int32, Diagnostics string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                return (Program.Main(args), compileOut.ToString() + "\n" + compileErr.ToString())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
        }

        private func Compile(tempDir string, name string, body string)(
            ExitCode int32,
            Diagnostics string,
            OutPath string
        ) {
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, `package P
import System
import System.Collections.Generic
` + Symbols + body)
            let outPath = Path.Combine(tempDir, name + ".dll")
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exitCode int32
            try {
                exitCode = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (exitCode, compileOut.ToString() + "\n" + compileErr.ToString(), outPath)
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
