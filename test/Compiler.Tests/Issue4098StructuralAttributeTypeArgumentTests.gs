// <copyright file="Issue4098StructuralAttributeTypeArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Text.RegularExpressions
import Xunit

/// Issue #4098: a G# STRUCTURAL type (`map`, tuple, `func`,
/// `chan`, `sequence`) over a same-compilation component serialised
/// its G# SPELLING into a custom-attribute blob.
/// @remarks <b>Root cause.</b> Each structural symbol computes its `ClrType`
/// by closing an open BCL definition over its components. A same-compilation
/// component has no `ClrType` while binding, so the structural symbol's own
/// `ClrType` comes out null and
/// `CustomAttributeEncoder.GetSerializedTypeParts` fell through to
/// `GetMetadataTypeName`'s `default:` arm — bare `type.Name`,
/// which for these kinds is the G# display spelling
/// (`map[string,Status]`, `(Status) -> bool`, `chan[Status]`),
/// qualified to the compilation's own assembly. Nothing can decode that.
///
/// <b>Only reachable nested.</b> At top level `typeof(map[…])` is
/// rejected by GS0202, which gates on the operand's `ClrType`. An imported
/// generic closed over the erased surrogate HAS one, so `Box[map[…]]`
/// passes the gate and the component reaches emit unchecked.
///
/// <b>The erasure surrogate is a second, quieter shape of the same
/// defect.</b> `map[string, List[Status]]` has a component
/// (`List[Status]`) whose `ClrType` is NON-null — it is
/// `List<object>`, closed over the erasure surrogate — so
/// `MapTypeSymbol.MakeClrType` succeeds and the old
/// `type.ClrType is { } clrType` fallback wrote a name that RESOLVES,
/// to the wrong type. A `{ ClrType: null }` guard on the structural arms
/// would leave that row broken, so the arms recurse symbolically and
/// unconditionally — exactly as the sibling `Slice`, `Array`,
/// `Rectangular` and `Nullable` arms already do.
///
/// <b>Controls.</b> The same kinds over components that DO have a CLR
/// type (`map[string, int32]`, `(int32, string)`,
/// `func(int32) bool`) serialise correctly today and must keep doing so;
/// they are what identifies the trigger as a same-compilation component and
/// they prove the ungated recursion did not regress the working path.
///
/// <b>Reified, not printed.</b> Every row is read back through a
/// (cref:MetadataLoadContext) and described by walking the generic
/// definition and arguments, naming each part's declaring ASSEMBLY. A row whose
/// serialised name does not resolve reads as `!` plus the failure.
///
/// <b>The broken rows failed in TWO ways, and the difference is the whole
/// argument for the ungated arms.</b> Nine of the ten threw — an undecodable G#
/// spelling (`map`, `chan`, `sequence`, `(Status) -> bool`)
/// or an invalid assembly name. The tenth,
/// `MapOverImportedGenericOfSourceEnum`, did NOT throw: it resolved
/// perfectly well, to `Dictionary<string, List<int>>` — the
/// wrong type, read back without complaint. That row is the one a
/// `{ ClrType: null }` guard would have left broken, because its
/// `ClrType` is non-null; and it is the more dangerous of the two failures,
/// because nothing downstream can detect it. Saying "every broken row failed to
/// resolve" would erase exactly the distinction this fix turns on.
///
/// <b>No new diagnostic.</b> These programs are legal and were accepted
/// before; only their metadata was wrong — the same as #4073.
open class Issue4098StructuralAttributeTypeArgumentTests {
    @Theory
    @MemberData("Rows")
    func AStructuralAttributeTypeArgument_ReifiesToItsBclProjection(name string, operand string, expected string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4098_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "P.dll")
            let source = Preamble + "@Marker(" + operand + ")\nclass " + name + ` {
}

Console.WriteLine("ok")
`
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.Empty(ErrorIds(appLog))
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
            // Joined rather than compared as a collection: xUnit elides a long
            // element, and the whole point of a row is the FULL serialised
            // shape — an argument that reifies to a plausible-looking wrong
            // type differs from the expectation only deep inside the string.
            let actual = string.Join(" | ", ReifiedAttributeArguments(appPath, libPath, name))
            Assert.True(expected == actual, (`'` + "$name" + `' reified wrongly.
expected: ` + "$expected" + `
actual:   ` + "$actual"))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const LibrarySource string = `using System;

namespace HelperLib4098;

[AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
public class MarkerAttribute : Attribute
{
    public MarkerAttribute(Type value)
    {
        Value = value;
    }

    public Type Value { get; }
}

public class Box<T>
{
}`

        private const Preamble string = `package P
import System
import System.Collections.Generic
import HelperLib4098

enum Status {
    Active,
    Retired
}

`

        /// One row per structural kind over a same-compilation component, plus the
        /// controls over an all-CLR component.
        /// @returns Row name, G# declaration, expected reified description.
        func Rows() sequence[[]object] {
            // --- The four kinds named in the issue, over a source enum. ---
            yield[]object{
                "MapOverSourceEnum",
                "typeof(Box[map[string, Status]])",
                "HelperLib4098.Box`1@HelperLib4098[System.Collections.Generic.Dictionary`2@System.Private.CoreLib[System.String@System.Private.CoreLib,P.Status@P]]"
            }
            yield[]object{
                "TupleOverSourceEnum",
                "typeof(Box[(int32, Status)])",
                "HelperLib4098.Box`1@HelperLib4098[System.ValueTuple`2@System.Private.CoreLib[System.Int32@System.Private.CoreLib,P.Status@P]]"
            }
            yield[]object{
                "FuncOverSourceEnum",
                "typeof(Box[func(Status) bool])",
                "HelperLib4098.Box`1@HelperLib4098[System.Func`2@System.Private.CoreLib[P.Status@P,System.Boolean@System.Private.CoreLib]]"
            }
            yield[]object{
                "ChanOverSourceEnum",
                "typeof(Box[chan[Status]])",
                "HelperLib4098.Box`1@HelperLib4098[System.Threading.Channels.Channel`1@System.Threading.Channels[P.Status@P]]"
            }
            // --- The fifth kind, named in Issue4073's remarks but not in #4098. ---
            yield[]object{
                "SequenceOverSourceEnum",
                "typeof(Box[sequence[Status]])",
                "HelperLib4098.Box`1@HelperLib4098[System.Collections.Generic.IEnumerable`1@System.Private.CoreLib[P.Status@P]]"
            }
            // --- The erasure-surrogate shape: the component has a NON-null
            // ClrType, closed over the `object` surrogate, so the structural
            // symbol's own ClrType is non-null and resolves to the WRONG type.
            yield[]object{
                "MapOverImportedGenericOfSourceEnum",
                "typeof(Box[map[string, List[Status]]])",
                "HelperLib4098.Box`1@HelperLib4098[System.Collections.Generic.Dictionary`2@System.Private.CoreLib[System.String@System.Private.CoreLib,System.Collections.Generic.List`1@System.Private.CoreLib[P.Status@P]]]"
            }
            // --- Projection decisions that only bite at specific shapes. ---
            yield[]object{
                "VoidFuncOverSourceEnum",
                "typeof(Box[func(Status)])",
                "HelperLib4098.Box`1@HelperLib4098[System.Action`1@System.Private.CoreLib[P.Status@P]]"
            }
            yield[]object{
                "ReceiveOnlyChanOverSourceEnum",
                "typeof(Box[in chan[Status]])",
                "HelperLib4098.Box`1@HelperLib4098[System.Threading.Channels.ChannelReader`1@System.Threading.Channels[P.Status@P]]"
            }
            yield[]object{
                "SendOnlyChanOverSourceEnum",
                "typeof(Box[out chan[Status]])",
                "HelperLib4098.Box`1@HelperLib4098[System.Threading.Channels.ChannelWriter`1@System.Threading.Channels[P.Status@P]]"
            }
            yield[]object{
                "NestedStructuralOverSourceEnum",
                "typeof(Box[map[string, (int32, Status)]])",
                "HelperLib4098.Box`1@HelperLib4098[System.Collections.Generic.Dictionary`2@System.Private.CoreLib[System.String@System.Private.CoreLib,System.ValueTuple`2@System.Private.CoreLib[System.Int32@System.Private.CoreLib,P.Status@P]]]"
            }
            // --- Review feedback on PR #4140: two arms of the helper that no row
            // reached. Both SELECT something — an open definition, and a nesting
            // shape — so an untested arm is where a wrong projection hides.
            // The async-sequence arm picks a DIFFERENT open definition from the
            // sync one (`IAsyncEnumerable` rather than `IEnumerable`), and the two
            // share a symbol name, so nothing but the reified type tells them apart.
            yield[]object{
                "AsyncSequenceOverSourceEnum",
                "typeof(Box[async sequence[Status]])",
                "HelperLib4098.Box`1@HelperLib4098[System.Collections.Generic.IAsyncEnumerable`1@System.Private.CoreLib[P.Status@P]]"
            }
            // Above arity 7 a tuple nests its tail into `TRest`. A FLAT encoding
            // would read back plausibly at a glance, so the nesting is asserted
            // structurally: `ValueTuple`8` whose eighth argument is itself a
            // `ValueTuple`1` over the source enum.
            yield[]object{
                "LargeTupleOverSourceEnum",
                "typeof(Box[(int32, int32, int32, int32, int32, int32, int32, Status)])",
                "HelperLib4098.Box`1@HelperLib4098[System.ValueTuple`8@System.Private.CoreLib[" +
                    "System.Int32@System.Private.CoreLib,System.Int32@System.Private.CoreLib," +
                    "System.Int32@System.Private.CoreLib,System.Int32@System.Private.CoreLib," +
                    "System.Int32@System.Private.CoreLib,System.Int32@System.Private.CoreLib," +
                    "System.Int32@System.Private.CoreLib," +
                    "System.ValueTuple`1@System.Private.CoreLib[P.Status@P]]]"
            }
            // --- Controls: the same kinds over components that HAVE a CLR type.
            // These serialise correctly today and must keep doing so.
            yield[]object{
                "ControlMapOverImported",
                "typeof(Box[map[string, int32]])",
                "HelperLib4098.Box`1@HelperLib4098[System.Collections.Generic.Dictionary`2@System.Private.CoreLib[System.String@System.Private.CoreLib,System.Int32@System.Private.CoreLib]]"
            }
            yield[]object{
                "ControlTupleOverImported",
                "typeof(Box[(int32, string)])",
                "HelperLib4098.Box`1@HelperLib4098[System.ValueTuple`2@System.Private.CoreLib[System.Int32@System.Private.CoreLib,System.String@System.Private.CoreLib]]"
            }
            yield[]object{
                "ControlFuncOverImported",
                "typeof(Box[func(int32) bool])",
                "HelperLib4098.Box`1@HelperLib4098[System.Func`2@System.Private.CoreLib[System.Int32@System.Private.CoreLib,System.Boolean@System.Private.CoreLib]]"
            }
            yield[]object{
                "ControlChanOverImported",
                "typeof(Box[chan[int32]])",
                "HelperLib4098.Box`1@HelperLib4098[System.Threading.Channels.Channel`1@System.Threading.Channels[System.Int32@System.Private.CoreLib]]"
            }
        }

        private func ErrorIds(log string)[]string -> Regex
            .Matches(log, "error (GS[0-9]{4})")
            .Select((match Match) -> match.Groups[1].Value)
            .ToArray()

        private func ReifiedAttributeArguments(assemblyPath string, libPath string, typeName string)[]string {
            let paths = List[string](TrustedPlatformAssemblies()){assemblyPath, libPath}
            using let context = MetadataLoadContext(PathAssemblyResolver(paths.Distinct(StringComparer.Ordinal)))
            let assembly = context.LoadFromAssemblyPath(assemblyPath)
            let target = assembly.GetTypes().Single((candidate Type) -> candidate.Name == typeName)
            let described = List[string]()
            for attribute in target.GetCustomAttributesData() {
                if attribute.AttributeType.Namespace?.StartsWith("HelperLib4098", StringComparison.Ordinal) != true {
                    continue
                }
                var arguments IList[CustomAttributeTypedArgument]
                try {
                    arguments = attribute.ConstructorArguments
                } catch (ex Exception) {
                    // A serialised name that does not resolve throws HERE rather
                    // than reading back as something plausible. Record the failure
                    // as the row's description so the red measurement is legible.
                    described.Add("!" + ex.GetType().Name + ": " + ex.Message)
                    continue
                }
                for argument in arguments {
                    described.Add(
                        if argument.Value is Type type {
                            Describe(type)
                        } else {
                            "!not-a-type: " + (argument.Value?.ToString() ?? "nil")
                        }
                    )
                }
            }
            return described.ToArray()
        }

        private func Describe(type Type?) string {
            if type!!.IsArray {
                return Describe(type!!.GetElementType()!!) + "[]"
            }
            if type!!.IsConstructedGenericType {
                let definition = type!!.GetGenericTypeDefinition()
                let arguments = type!!.GetGenericArguments().Select(Describe)
                return Describe(definition) + "[" + string.Join(",", arguments) + "]"
            }
            return (type!!.FullName ?? type!!.Name) + "@" + type!!.Assembly.GetName().Name
        }

        private func CompileCSharpLibrary(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "HelperLib4098",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "HelperLib4098.dll")
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

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
