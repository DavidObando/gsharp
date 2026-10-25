// <copyright file="Issue4056ConstructedGenericCompoundAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Text
import System.Text.RegularExpressions
import SystemObject = System.Object
import Xunit

/// Issue #4056: a static COMPOUND assignment through a constructed generic
/// receiver whose type argument is a same-compilation type emitted a member
/// reference parented at the type-ERASED `Handler<object>` TypeSpec.
/// The program compiled with no diagnostic, ILVerify rejected the assembly with
/// `UnsatisfiedFieldParentInst`, and the CLR threw
/// `TypeLoadException: GenericArguments[0], 'System.Object', … violates the
/// constraint of type parameter 'TOptions'` — even though `MyOptions`
/// satisfies that constraint.
/// @remarks <b>Root cause.</b> A same-compilation class has no `ClrType`
/// while binding (its TypeDef is only produced at emit), so
/// `TryCloseImportedGenericTypeReceiver` closes the imported generic over
/// the `System.Object` surrogate and records the real construction beside
/// it on `ImportedClassSymbol.SymbolicReceiver` (#1330/#2670). The READ
/// path (`ExpressionBinder.Access.MemberLookup.cs`) and the simple-WRITE
/// path (`BindMemberFieldAssignmentExpression`, which passes
/// `staticContainerType: constructedImported.SymbolicReceiver`) both carry
/// that symbol onto the bound node, so the emitter parents the member reference
/// at the real construction. The compound-assignment path
/// (`BindEventSubscriptionExpression` →
/// `TryBindStaticClrCompoundAssignment`) narrowed the receiver to
/// `ctorImported.ClassType` — the erased close — and passed
/// `staticContainerType: null`, so the surrogate reached emit.
///
/// <b>Why the read and simple-write rows are here.</b> The issue reports
/// them as already correct; they are the control that the repair changed nothing
/// on the paths that were fine, and they are what proves the compound rows are
/// the only ones that ever named `object`.
///
/// <b>Both halves of the compound needed the fix.</b> A compound
/// assignment is a read (`ldsfld` / `call get_X`) followed by a write
/// (`stsfld` / `call set_X`), and the binder builds two bound nodes.
/// Threading the symbolic container onto the assignment alone still left the
/// read half naming `Handler<object>`, so ILVerify stayed red; both
/// `leftRead` and the `BoundClrPropertyAssignmentExpression` carry
/// it.
///
/// <b>No new diagnostic.</b> This is wrong EMISSION of a construction the
/// language already accepts, not a missing rule — the constraint is satisfied
/// and #4032's check (which reads the symbol's base chain, not the surrogate) is
/// right to pass it. Nothing here reports, and nothing here suppresses.
///
/// <b>Not #4051.</b> That issue is a diagnostic CASCADE on a receiver whose
/// constraint is genuinely violated; every row here satisfies its constraint and
/// must run.
open class Issue4056ConstructedGenericCompoundAssignmentTests {
    /// Every spelling compiles clean, IL-VERIFIES, runs to completion, and
    /// prints what the source says. ILVerify is the acceptance test here, not
    /// the printed output: the defect emitted a program that ran (until it
    /// touched the type) and printed nothing wrong on the paths that did work,
    /// so a test that only asserted stdout would have passed while the assembly
    /// stayed invalid.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("CompoundShapes")
    func AConstructedGenericStaticCompoundAssignment_CompilesVerifiesAndRuns(
        name string,
        source string,
        expectedLines[]string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4056_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "App.dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.Empty(ErrorIds(appLog))
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
            let (exit, output) = RunDotnet(appPath, libPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
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

    /// The exact surrogate the issue names never appears in the emitted
    /// metadata. Asserted on the raw assembly bytes rather than on behaviour so
    /// the row fails even in a hypothetical runtime that tolerated the bad
    /// instantiation: the string `Handler`1<object>` reaches metadata
    /// as a TypeSpec over `System.Object`, and the fixed emitter writes the
    /// TypeDef of `MyOptions` instead. Counted, not merely absent —
    /// `MyOptions` must be the argument of the ONE constructed
    /// `Handler` TypeSpec the program needs.
    @Fact
    func TheEmittedTypeSpecNamesTheSourceTypeArgumentAndNotTheObjectSurrogate() {
        const Source = `package P
import System
import HelperLib4056

class MyOptions : SchemeOptions {
}

Handler[MyOptions].Field += "z"
Console.WriteLine(Handler[MyOptions].Field)`
        let tempDir = Directory.CreateTempSubdirectory("gs_4056_meta_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "App.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.True(File.Exists(appPath), (`the sample must compile. Log:
` + "$appLog"))
            // Three references reach metadata: the compound read (`ldsfld`),
            // the compound write (`stsfld`), and the trailing `Console.WriteLine`
            // read. All three must name the construction the author wrote, and
            // since #5172 equal TypeSpec rows are written once, so the three
            // references share ONE row. A reference left on `Handler<object>`
            // would add a second, different row, so the exact list still fails
            // on a partial repair (repairing the write alone once left the read
            // half on `Handler<object>` and ILVerify stayed red).
            let specs = DescribeConstructedGenerics(appPath, "Handler")
            Assert.Equal([]string{"HelperLib4056.Handler`1<P.MyOptions>"}, specs)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Decodes a type signature to a namespace-qualified display form, so a
    /// constructed generic reads as `Ns.Def`1<Ns.Arg>` and the
    /// erased shape this issue emitted would read as
    /// `HelperLib4056.Handler`1<Object>`.
    private class QualifiedNameSignatureProvider : ISignatureTypeProvider[string, object] {
        func GetPrimitiveType(typeCode PrimitiveTypeCode) string -> typeCode.ToString()

        func GetGenericTypeParameter(genericContext object, index int32) string -> "!" + index.ToString()

        func GetGenericMethodParameter(genericContext object, index int32) string -> "!!" + index.ToString()

        func GetTypeFromDefinition(reader MetadataReader, handle TypeDefinitionHandle, rawTypeKind uint8) string {
            let definition = reader.GetTypeDefinition(handle)
            return Qualify(reader.GetString(definition.Namespace), reader.GetString(definition.Name))
        }

        func GetTypeFromReference(reader MetadataReader, handle TypeReferenceHandle, rawTypeKind uint8) string {
            let reference = reader.GetTypeReference(handle)
            return Qualify(reader.GetString(reference.Namespace), reader.GetString(reference.Name))
        }

        func GetTypeFromSpecification(
            reader MetadataReader,
            genericContext object,
            handle TypeSpecificationHandle,
            rawTypeKind uint8
        ) string -> reader
            .GetTypeSpecification(handle).DecodeSignature(this, genericContext)

        func GetGenericInstantiation(genericType string, typeArguments ImmutableArray[string]) string -> genericType +
            "<" +
            string.Join(",", typeArguments) + ">"

        func GetArrayType(elementType string, shape ArrayShape) string -> elementType + "[]"

        func GetByReferenceType(elementType string) string -> elementType + "&"

        func GetPointerType(elementType string) string -> elementType + "*"

        func GetSZArrayType(elementType string) string -> elementType + "[]"

        func GetFunctionPointerType(signature MethodSignature[string]) string -> "method*"

        func GetModifiedType(modifier string, unmodifiedType string, isRequired bool) string -> unmodifiedType

        func GetPinnedType(elementType string) string -> elementType

        func GetTypeFromSerializedName(name string) string -> name

        func GetUnderlyingEnumType(type string) PrimitiveTypeCode -> PrimitiveTypeCode.Int32

        func IsSystemType(type string) bool -> false

        shared {
            private func Qualify(ns string, name string) string -> if string.IsNullOrEmpty(ns) {
                name
            } else {
                ns + "." + name
            }
        }
    }

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The C# library every row links against. `Handler<TOptions>`
        /// carries the constraint from the issue; `Registry<T>` is its
        /// UNCONSTRAINED twin, so the type-parameter receiver row can be written
        /// without also exercising constraint checking. Each exposes a static field,
        /// a static integer field (for a non-`+=` operator) and a static
        /// property, so one library serves every member kind the compound-assignment
        /// binder reaches.
        private const LibrarySource string = `namespace HelperLib4056;

public class SchemeOptions
{
    public string? Name { get; set; }
}

public class Handler<TOptions>
    where TOptions : SchemeOptions
{
    public static string Field = "f";

    public static int Count = 1;

    public static string Prop { get; set; } = "p";
}

public class Registry<T>
{
    public static string Tag = "r";

    public static int Hits = 2;

    public static string Note { get; set; } = "n";
}`

        /// Every receiver/member/operator spelling that reaches the constructed
        /// generic static-member paths. The rows whose type argument is a
        /// same-compilation type (or contains one) were the broken ones; the rows
        /// over an IMPORTED argument, and the read/simple-write spellings, are the
        /// controls that were already green and must stay byte-for-byte correct.
        /// @returns Case name, G# source, and the expected stdout lines.
        func CompoundShapes() sequence[[]object] {
            // --- The issue's repro, and its member-kind/operator siblings. ---
            yield[]object{"compound-field-source-argument", `package P
import System
import HelperLib4056

class MyOptions : SchemeOptions {
}

Handler[MyOptions].Field += "z"
Console.WriteLine(Handler[MyOptions].Field)`, []string{"fz"}}
            yield[]object{"compound-property-source-argument", `package P
import System
import HelperLib4056

class MyOptions : SchemeOptions {
}

Handler[MyOptions].Prop += "z"
Console.WriteLine(Handler[MyOptions].Prop)`, []string{"pz"}}
            // Issue #2154: a non-`+=` compound operator never probes for an event,
            // so it enters the constructed-generic branch by a different route.
            yield[]object{"compound-field-multiply-source-argument", `package P
import System
import HelperLib4056

class MyOptions : SchemeOptions {
}

Handler[MyOptions].Count *= 3
Console.WriteLine(Handler[MyOptions].Count)`, []string{"3"}}
            yield[]object{"compound-property-unconstrained-source-argument", `package P
import System
import HelperLib4056

class Item {
}

Registry[Item].Note += "?"
Console.WriteLine(Registry[Item].Note)`, []string{"n?"}}
            // Issue #2670: the same-compilation type nested inside an imported
            // generic argument — `Registry[List[Item]]` — is retained by the same
            // gate and was erased the same way.
            yield[]object{"compound-field-nested-source-argument", `package P
import System
import System.Collections.Generic
import HelperLib4056

class Item {
}

Registry[List[Item]].Hits += 5
Console.WriteLine(Registry[List[Item]].Hits)`, []string{"7"}}
            // Issue #1330: an in-scope type PARAMETER receiver is erased to the same
            // `object` surrogate for the same reason, and reaches the same branch.
            yield[]object{"compound-field-type-parameter-receiver", `package P
import System
import HelperLib4056

func bump[T]() string {
    Registry[T].Tag += "!"
    return Registry[T].Tag
}

class Item {
}

Console.WriteLine(bump[Item]())`, []string{"r!"}}
            // --- Controls. Already green before the fix; must stay green. ---
            yield[]object{"read-source-argument", `package P
import System
import HelperLib4056

class MyOptions : SchemeOptions {
}

Console.WriteLine(Handler[MyOptions].Field)`, []string{"f"}}
            yield[]object{"simple-write-source-argument", `package P
import System
import HelperLib4056

class MyOptions : SchemeOptions {
}

Handler[MyOptions].Field = "z"
Console.WriteLine(Handler[MyOptions].Field)`, []string{"z"}}
            // An IMPORTED type argument has a real CLR type, so no symbolic receiver
            // is ever recorded and this row never took the repaired branch. It is the
            // proof that the fix is scoped to the erased shape.
            yield[]object{"compound-field-imported-argument", `package P
import System
import HelperLib4056

Handler[SchemeOptions].Field += "z"
Console.WriteLine(Handler[SchemeOptions].Field)`, []string{"fz"}}
            yield[]object{"compound-property-imported-argument", `package P
import System
import HelperLib4056

Registry[string].Note += "?"
Console.WriteLine(Registry[string].Note)`, []string{"n?"}}
        }

        private func ErrorIds(log string)[]string -> Regex
            .Matches(log, "error (GS[0-9]{4})")
            .Select((match Match) -> match.Groups[1].Value)
            .ToArray()

        /// Reads every `TypeSpec` row in the emitted assembly and returns the
        /// decoded shapes whose generic definition name contains
        /// [`definitionNameFragment`](paramref), in table order. Reading the
        /// metadata directly (rather than reflecting) is what makes the assertion
        /// about the EMITTED instantiation instead of about a runtime that might
        /// resolve it leniently.
        /// @param assemblyPath The emitted assembly.
        /// @param definitionNameFragment The generic definition name to select on.
        /// @returns The decoded constructed-generic shapes.
        private func DescribeConstructedGenerics(assemblyPath string, definitionNameFragment string)[]string {
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let provider = QualifiedNameSignatureProvider()
            let shapes = List[string]()
            for var row = 1; row <= reader.GetTableRowCount(TableIndex.TypeSpec); row++ {
                let handle = MetadataTokens.TypeSpecificationHandle(row)
                let decoded = reader.GetTypeSpecification(handle).DecodeSignature(
                    provider,
                    genericContext: SystemObject()
                )
                if decoded.Contains(definitionNameFragment, StringComparison.Ordinal) {
                    shapes.Add(decoded)
                }
            }
            return shapes.ToArray()
        }

        private func CompileCSharpLibrary(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "HelperLib4056",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "HelperLib4056.dll")
            let result = compilation.Emit(libPath)
            Assert.True(
                result.Success,
                "the C# library must compile:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            return libPath
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
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
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func RunDotnet(assemblyPath string, libPath string)(Exit int32, Output string) {
            let dir = Path.GetDirectoryName(assemblyPath) ?? "."
            let sideBySide = Path.Combine(dir, Path.GetFileName(libPath))
            if !File.Exists(sideBySide) {
                File.Copy(libPath, sideBySide)
            }
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = dir
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
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
