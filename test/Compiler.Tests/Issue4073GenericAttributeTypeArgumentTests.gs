// <copyright file="Issue4073GenericAttributeTypeArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Issue #4073: the `System.Type` argument of a custom attribute wrote the
/// ERASED closed CLR shape of a constructed generic into the blob, so
/// `@JsonConverter(typeof(JsonStringEnumConverter[ConstructStatus]))`
/// serialised `JsonStringEnumConverter`1[[System.Int32, …]]` and reflection
/// materialisation threw
/// `GenericArguments[0], System.Int32, on JsonStringEnumConverter<TEnum>
/// violates TEnum : struct, Enum`.
/// @remarks <b>Root cause.</b> A same-compilation type has no `ClrType` while
/// binding, so a constructed imported generic over one is closed over a
/// surrogate and the real argument is kept only on the symbolic vector
/// (`ImportedTypeSymbol.TypeArguments`). `TryBindAttributeArgument`'s
/// `typeof` case preferred `operandType.ClrType` whenever it was
/// non-null — and for a constructed generic it always is, because the erased
/// close is a real closed type. So the encoder was handed the surrogate and
/// wrote its assembly-qualified name.
///
/// <b>The enum is not special.</b> The issue names an enum because that is
/// what the self-migration gate hit, and the surrogate for a source enum is
/// `System.Int32` (issue #2391's deliberate ride-through). Measured across
/// the argument kinds, a same-compilation CLASS in the same position wrote
/// `System.Object`, a nested generic wrote the surrogate at depth, a
/// two-parameter generic wrote one of each, a slice argument wrote
/// `System.Int32[]`, and a nilable enum wrote `System.Object`. One
/// defect, five surrogates.
///
/// <b>Two more sibling kinds, found by sweeping rather than reasoning.</b>
/// (1) A same-compilation GENERIC — `typeof(MyBox[Status])` — serialised as
/// the bare `P.MyBox`: the constructed `StructSymbol` carries its
/// arguments on `TypeArguments` and leaves `TypeParameters` empty, so
/// the arity suffix computed to zero and no argument list was written at all.
/// That name does not resolve, so the attribute could not be decoded — with an
/// IMPORTED argument (`MyBox[int32]`) too, which has nothing to do with
/// erasure. (2) An attribute whose `Type[]` argument contains a
/// same-compilation `typeof` was dropped from the assembly ENTIRELY, with
/// no diagnostic: #3684 widened the constant CONTAINER to `object[]` to
/// hold the `TypeSymbol` placeholder, and the constructor matcher then
/// refused `object[]` for a `Type[]` parameter.
///
/// <b>A third kind, from the review sweep: a constructed generic
/// DELEGATE.</b> `DelegateTypeSymbol.CreateConstructed` keeps the vector on
/// `TypeArguments` like a struct does, but unlike a struct it PRESERVES
/// `TypeParameters`, so the arity suffix was already right and
/// `typeof(Pred[Status])` serialised as the open `P.Pred`1` — a name
/// that resolves, quietly dropping the argument. Nested as an argument
/// (`Box[Pred[Status]]`) it was worse: an open generic in an instantiation
/// slot reifies to a type with no `FullName` at all.
///
/// <b>Constructor SELECTION, not just encoding.</b> The
/// `Type[]` repair widens what `ArgAssignable` admits, and
/// `ArgAssignable` is the applicability rule. Scoped to the container the
/// compiler itself widened — asked of `BoundAttributeArgument.Type`, the
/// type the AUTHOR wrote — it must not make every `object[]` covariant by
/// its current element values. See
/// (cref:OnlyTheWidenedTypeArrayContainerSatisfiesAnArrayConstructor).
///
/// <b>ILVerify is not the discriminator here.</b> The blob is metadata,
/// not IL: every row verified before the fix and verifies after it. Each row is
/// still IL-verified — a metadata repair that broke the IL would be a
/// regression — but what tells the rows apart is the REIFIED type read back out
/// of the emitted assembly through a (cref:MetadataLoadContext), and, for
/// the issue's own shape, a program that runs and serialises.
///
/// <b>Reified, not printed.</b> Every assertion describes the argument by
/// walking its generic definition and arguments and naming each part's declaring
/// ASSEMBLY. A printed type name can read correctly while the TypeSpec is
/// wrong.
///
/// <b>What is deliberately NOT covered.</b> A nested type inside a generic
/// OUTER — `typeof(Outer[Status].Inner)` — loses its enclosing type
/// argument and serialises as the open `P.Outer`1+Inner`. That name
/// RESOLVES, so it fails quietly rather than loudly, and it needs a different
/// vector (`StructSymbol.ConstructNested` records the arguments on
/// `EnclosingTypeArguments` and leaves `TypeArguments` empty) plus a
/// decision about what arity the nested TypeDef declares. Measured on both sides
/// of this fix and filed as issue #4095. A G# STRUCTURAL type over a
/// same-compilation component — `Box[map[string, Status]]`,
/// `Box[(int32, Status)]`, `Box[func(Status) bool]`,
/// `Box[chan[Status]]`, `Box[sequence[Status]]` — serialises its G#
/// SPELLING (`map`, `(Status) -> bool`) because the symbol's own
/// `ClrType` is null and the default arm falls back to `type.Name`.
/// FIVE kinds, and three of them need a projection DECIDED before they can be
/// written (`ValueTuple`'s `TRest` nesting above arity 7, `Func`
/// versus `Action` — by-ref parameters have neither — and the channel
/// direction), so repairing the two that are plain lookups would leave three
/// siblings undecodable. Filed as issue #4098, measured on this side; the claim
/// that the parent behaves identically is reasoning from the serialiser that
/// was replaced (a single `GetMetadataTypeName` plus one assembly name,
/// which reaches the same fallback), not a measurement, and issue #4098 says
/// so. The same kinds over an IMPORTED component already serialise correctly,
/// which is what identifies the trigger. Repaired since, in
/// (cref:Issue4098StructuralAttributeTypeArgumentTests).
///
/// <b>Almost no new diagnostic.</b> Every program in this file's
/// (cref:AnAttributeTypeArgument_ReifiesToTheTypeTheSourceNames) rows is
/// legal and was accepted before; only the metadata it emitted was wrong. The
/// two source-illegal rows in
/// (cref:OnlyTheWidenedTypeArrayContainerSatisfiesAnArrayConstructor)
/// are the exception: they used to be dropped silently and now report GS0583
/// (issue #4097).
open class Issue4073GenericAttributeTypeArgumentTests {
    /// Every spelling compiles, IL-verifies, and reifies to the type the source
    /// names. The assertion is on the exact ORDERED list of reified arguments —
    /// positional then named, array elements flattened — so a dropped attribute
    /// (which is how the `Type[]`-of-source-scalars row failed) is an empty
    /// list rather than a silent pass.
    /// @param name The case name.
    /// @param declaration The annotated G# declaration.
    /// @param expected The expected reified arguments, in order.
    @Theory
    @MemberData("TypeArguments")
    func AnAttributeTypeArgument_ReifiesToTheTypeTheSourceNames(name string, declaration string, expected[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4073_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            // The emitted assembly's identity is the PACKAGE name, so the file
            // must be named for it or nothing can resolve `P` when the blob's
            // assembly-qualified names are decoded.
            let appPath = Path.Combine(tempDir, "P.dll")
            let source = Preamble + declaration + `

Console.WriteLine("ok")
`
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.Empty(ErrorIds(appLog))
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
            let reified = ReifiedAttributeArguments(appPath, libPath, "Target")
            Assert.Equal(expected, reified)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The issue's own program, end to end: a generic attribute whose type
    /// parameter is constrained `where TEnum : struct, Enum` is
    /// materialised by reflection at run time. Before the fix this threw
    /// `ArgumentException: GenericArguments[0], 'System.Int32', … violates the
    /// constraint of type parameter 'TEnum'` — the exact symptom the
    /// self-migration gate reported. Kept beside the metadata rows because a
    /// reified-metadata assertion alone would not prove the CLR accepts the
    /// instantiation.
    @Fact
    func AConstrainedGenericAttributeArgumentMaterialisesAtRunTime() {
        const Declaration = `@Marker(typeof(Constrained[Status]))
class Target {
}`
        const Body = "\nConsole.WriteLine(Probe.DescribeMarker(typeof(Target)))"
        let tempDir = Directory.CreateTempSubdirectory("gs_4073_run_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "P.dll")
            let source = Preamble + Declaration + "\n" + Body + "\n"
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.Empty(ErrorIds(appLog))
            Assert.True(File.Exists(appPath), (`the sample must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
            let (exit, output) = RunDotnet(appPath, libPath)
            Assert.True(exit == 0, (`the sample must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal([]string{"P.Status"}, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Review feedback on PR #4087. The widened-container arm this fix added is
    /// an applicability rule, so it decides which constructor the emitter
    /// SELECTS. Matching on the container alone made every `object[]`
    /// covariant by its current element VALUES, and
    /// `@Names([]object{"x"})` — whose source array type is
    /// `object[]` — satisfied a `string[]` constructor the author
    /// could not have called. The arm must fire for the container the compiler
    /// itself widened and for nothing else, so all three shapes are asserted
    /// together: the widened one is encoded, and neither of the source-illegal
    /// ones is.
    /// @remarks The two rejected shapes used to be dropped SILENTLY, with no
    /// diagnostic — the pre-existing behaviour of an attribute matching no
    /// constructor, and the reason this issue's own `Type[]` half went
    /// unnoticed. That was filed as issue #4097 and this test asserted the drop
    /// with a note saying the rows would become diagnostics when #4097 landed.
    /// It has: they now report GS0583, and
    /// (cref:Issue4097AttributeConstructorNotFoundTests) owns the
    /// diagnostic's own coverage.
    ///
    /// The rejected rows moved into compilations of their own because the
    /// GS0583 channel is emit-time and aborts on the first offending attribute,
    /// so one source file can no longer carry an accepted row and a rejected
    /// one at once. What this test asserts is unchanged in substance: the arm
    /// fires for the container the compiler itself widened and for nothing
    /// else.
    @Fact
    func OnlyTheWidenedTypeArrayContainerSatisfiesAnArrayConstructor() {
        const Accepted = `@Names([]string{"x"})
class Faithful {
}

@Many([]Type{typeof(Status)})
class WidenedTypes {
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_4073_ctor_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "P.dll")
            let source = Preamble + Accepted + `

Console.WriteLine("ok")
`
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.Empty(ErrorIds(appLog))
            Assert.True(File.Exists(appPath), (`the sample must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
            // A source `[]string` at a `string[]` parameter: always matched, and
            // must keep matching.
            Assert.Equal([]string{"NamesAttribute"}, HelperAttributeNames(appPath, libPath, "Faithful"))
            // The container #3684 widened, at the parameter it was widened FOR.
            Assert.Equal([]string{"ManyAttribute"}, HelperAttributeNames(appPath, libPath, "WidenedTypes"))
            Assert.Equal([]string{"P.Status@P"}, ReifiedAttributeArguments(appPath, libPath, "WidenedTypes"))
            // Source-illegal: the declared element type is `object`, not the
            // parameter's. Neither may be encoded — and, since #4097, neither
            // may be waved through in silence.
            for rejected in[]string{`@Names([]object{"x"})
class WidenedStrings {
}`, `@Many([]object{typeof(Status)})
class ObjectTypes {
}`} {
                let rejectedPath = Path.Combine(tempDir, "Rejected.dll")
                let rejectedLog = Compile(tempDir, "Rejected.gs", Preamble + rejected + `

Console.WriteLine("ok")
`, rejectedPath, "/target:exe", "/reference:" + libPath)
                Assert.Contains("GS0583", ErrorIds(rejectedLog))
            }
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The C# library every row links against. `Constrained<TEnum>`
        /// reproduces the constraint from the issue's `JsonStringEnumConverter`
        /// without depending on `System.Text.Json`'s shape.
        private const LibrarySource string = (`using System;

namespace HelperLib4073;

[AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
public class MarkerAttribute : Attribute
{
    public MarkerAttribute(Type value)
    {
        Value = value;
    }

    public Type Value { get; }

    public Type? Named { get; set; }

    public Type[]? Many { get; set; }
}

[AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
public class ManyAttribute : Attribute
{
    public ManyAttribute(Type[] values)
    {
        Values = values;
    }

    public Type[] Values { get; }
}

// Review feedback on PR #4087: a ` + "`" + `string[]` + "`" + ` constructor, so the widened
// ` + "`" + `object[]` + "`" + ` container has an unrelated array parameter to be tested
// against. Nothing here takes a ` + "`" + `Type` + "`" + `.
[AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
public class NamesAttribute : Attribute
{
    public NamesAttribute(string[] values)
    {
        Values = values;
    }

    public string[] Values { get; }
}

public class Box<T>
{
}

public class Pair<TA, TB>
{
}

public class Constrained<TEnum>
    where TEnum : struct, Enum
{
}

public static class Probe
{
    public static string DescribeMarker(Type target)
    {
        var marker = (MarkerAttribute)Attribute.GetCustomAttribute(target, typeof(MarkerAttribute))!;
        return marker.Value.GetGenericArguments()[0].FullName!;
    }
}`)

        /// The declarations every row's program shares: a source enum, a source
        /// class, and a source generic, so a row's body is only the annotated type.
        private const Preamble string = `package P
import System
import HelperLib4073

enum Status {
    Active,
    Retired
}

class Local {
}

class MyBox[T] {
    prop V T
}

delegate Pred[T](value T) bool;

delegate Plain(value int32);
`

        /// Every attribute-argument kind that carries a `System.Type`. The
        /// expected value is a structural description of the REIFIED argument: a
        /// constructed generic reads as
        /// `Def`N@DefAssembly[Arg@ArgAssembly, …]`, so a row cannot pass by
        /// printing a plausible name — the argument's declaring assembly is part of
        /// the assertion, and the surrogates this issue emitted
        /// (`System.Int32@System.Private.CoreLib`,
        /// `System.Object@System.Private.CoreLib`) are distinct strings.
        /// @returns Case name, the annotated G# declaration, and the expected reified arguments in order.
        func TypeArguments() sequence[[]object] {
            // --- The issue's shape and its argument-kind siblings. ---
            yield[]object{"constructed-generic-over-source-enum", `@Marker(typeof(Box[Status]))
class Target {
}`, []string{"HelperLib4073.Box`1@HelperLib4073[P.Status@P]"}}
            yield[]object{"constructed-generic-over-source-class", `@Marker(typeof(Box[Local]))
class Target {
}`, []string{"HelperLib4073.Box`1@HelperLib4073[P.Local@P]"}}
            yield[]object{"nested-constructed-generic-over-source-enum", `@Marker(typeof(Box[Box[Status]]))
class Target {
}`, []string{"HelperLib4073.Box`1@HelperLib4073[HelperLib4073.Box`1@HelperLib4073[P.Status@P]]"}}
            yield[]object{"two-parameter-generic-over-source-enum-and-class", `@Marker(typeof(Pair[Status, Local]))
class Target {
}`, []string{"HelperLib4073.Pair`2@HelperLib4073[P.Status@P,P.Local@P]"}}
            yield[]object{"slice-of-source-enum-as-argument", `@Marker(typeof(Box[[]Status]))
class Target {
}`, []string{"HelperLib4073.Box`1@HelperLib4073[P.Status@P[]]"}}
            yield[]object{"nilable-source-enum-as-argument", `@Marker(typeof(Box[Status?]))
class Target {
}`, []string{"HelperLib4073.Box`1@HelperLib4073[System.Nullable`1@System.Private.CoreLib[P.Status@P]]"}}
            // The reported failure mode: a generic whose parameter is CONSTRAINED,
            // so reflection materialisation refuses the surrogate outright.
            yield[]object{"constrained-generic-over-source-enum", `@Marker(typeof(Constrained[Status]))
class Target {
}`, []string{"HelperLib4073.Constrained`1@HelperLib4073[P.Status@P]"}}
            // --- Argument POSITIONS. Same defect, three different encoders. ---
            yield[]object{"named-argument", `@Marker(typeof(string), Named: typeof(Box[Status]))
class Target {
}`, []string{"System.String@System.Private.CoreLib", "HelperLib4073.Box`1@HelperLib4073[P.Status@P]"}}
            yield[]object{"array-element-in-named-argument", `@Marker(typeof(string), Many: []Type{typeof(Box[Status])})
class Target {
}`, []string{"System.String@System.Private.CoreLib", "HelperLib4073.Box`1@HelperLib4073[P.Status@P]"}}
            yield[]object{"array-positional-argument", `@Many([]Type{typeof(Box[Status]), typeof(Local)})
class Target {
}`, []string{"HelperLib4073.Box`1@HelperLib4073[P.Status@P]", "P.Local@P"}}
            // The whole attribute vanished when a Type[] held a same-compilation
            // scalar typeof: the widened `object[]` container failed the ctor match.
            yield[]object{"array-of-source-scalars", `@Many([]Type{typeof(Status), typeof(Local)})
class Target {
}`, []string{"P.Status@P", "P.Local@P"}}
            // --- A same-compilation generic: a different branch, same wrong name. ---
            yield[]object{"source-generic-over-source-enum", `@Marker(typeof(MyBox[Status]))
class Target {
}`, []string{"P.MyBox`1@P[P.Status@P]"}}
            yield[]object{"source-generic-over-imported-argument", `@Marker(typeof(MyBox[int32]))
class Target {
}`, []string{"P.MyBox`1@P[System.Int32@System.Private.CoreLib]"}}
            // --- A constructed generic DELEGATE. Review feedback on PR #4087: the
            // kind the first sweep missed, and it fails one step further along than
            // the source-generic rows above. `CreateConstructed` PRESERVES
            // `TypeParameters`, so the arity suffix is right and `P.Pred`1`
            // RESOLVES — to the open definition, silently losing the argument.
            yield[]object{"constructed-delegate-over-source-enum", `@Marker(typeof(Pred[Status]))
class Target {
}`, []string{"P.Pred`1@P[P.Status@P]"}}
            yield[]object{"constructed-delegate-over-source-class", `@Marker(typeof(Pred[Local]))
class Target {
}`, []string{"P.Pred`1@P[P.Local@P]"}}
            // Erasure is not what breaks this one: an IMPORTED argument lost the
            // instantiation just the same, exactly as `MyBox[int32]` did.
            yield[]object{"constructed-delegate-over-imported-argument", `@Marker(typeof(Pred[int32]))
class Target {
}`, []string{"P.Pred`1@P[System.Int32@System.Private.CoreLib]"}}
            // Nested as an ARGUMENT it is worse than a wrong name: the blob named an
            // open generic in an instantiation slot, so the reified type had no
            // `FullName` at all.
            yield[]object{"imported-generic-over-constructed-delegate", `@Marker(typeof(Box[Pred[Status]]))
class Target {
}`, []string{"HelperLib4073.Box`1@HelperLib4073[P.Pred`1@P[P.Status@P]]"}}
            yield[]object{"source-generic-over-constructed-delegate", `@Marker(typeof(MyBox[Pred[Status]]))
class Target {
}`, []string{"P.MyBox`1@P[P.Pred`1@P[P.Status@P]]"}}
            // --- Controls. Already correct before the fix; must not move. ---
            yield[]object{"non-generic-delegate", `@Marker(typeof(Plain))
class Target {
}`, []string{"P.Plain@P"}}
            // The OPEN definition still serialises as the open definition — the
            // constructed arm must not fire on an empty argument vector.
            yield[]object{"open-generic-delegate", `@Marker(typeof(Pred))
class Target {
}`, []string{"P.Pred`1@P"}}
            yield[]object{"scalar-source-enum", `@Marker(typeof(Status))
class Target {
}`, []string{"P.Status@P"}}
            yield[]object{"scalar-source-class", `@Marker(typeof(Local))
class Target {
}`, []string{"P.Local@P"}}
            yield[]object{"constructed-generic-over-imported-argument", `@Marker(typeof(Box[int32]))
class Target {
}`, []string{"HelperLib4073.Box`1@HelperLib4073[System.Int32@System.Private.CoreLib]"}}
            yield[]object{"scalar-imported-type", `@Marker(typeof(string))
class Target {
}`, []string{"System.String@System.Private.CoreLib"}}
            yield[]object{"array-of-imported-scalars", `@Many([]Type{typeof(int32), typeof(string)})
class Target {
}`, []string{"System.Int32@System.Private.CoreLib", "System.String@System.Private.CoreLib"}}
        }

        /// Names the attributes from the helper library that were actually emitted
        /// onto one type. Distinguishes "encoded" from "dropped", which the reified
        /// ARGUMENT list cannot: an attribute with no `Type` argument and an
        /// attribute that was never written both describe as an empty list.
        /// @param assemblyPath The emitted assembly.
        /// @param libPath The referenced helper library.
        /// @param typeName The annotated type's simple name.
        /// @returns The helper attribute type names, in metadata order.
        private func HelperAttributeNames(assemblyPath string, libPath string, typeName string)[]string {
            let paths = List[string](TrustedPlatformAssemblies()){assemblyPath, libPath}
            using let context = MetadataLoadContext(PathAssemblyResolver(paths.Distinct(StringComparer.Ordinal)))
            let assembly = context.LoadFromAssemblyPath(assemblyPath)
            let target = assembly.GetTypes().Single((candidate Type) -> candidate.Name == typeName)
            return target
                .GetCustomAttributesData()
                .Where(
                (attribute CustomAttributeData) -> attribute
                    .AttributeType
                    .Namespace
                    ?.StartsWith("HelperLib4073", StringComparison.Ordinal) == true
            )
                .Select((attribute CustomAttributeData) -> attribute.AttributeType.Name)
                .ToArray()
        }

        private func ErrorIds(log string)[]string -> Regex
            .Matches(log, "error (GS[0-9]{4})")
            .Select((match Match) -> match.Groups[1].Value)
            .ToArray()

        /// Loads the emitted assembly in a (cref:MetadataLoadContext) and
        /// returns a structural description of every `System.Type` argument on
        /// the attributes of [`typeName`](paramref) — positional first, then
        /// named, with array arguments flattened in element order. Decoding through
        /// the metadata reader is what makes this an assertion about the emitted
        /// TypeSpec: an argument whose serialised name does not resolve throws here
        /// rather than reading back as something plausible.
        /// @param assemblyPath The emitted assembly.
        /// @param libPath The referenced helper library.
        /// @param typeName The annotated type's simple name.
        /// @returns The reified argument descriptions, in order.
        private func ReifiedAttributeArguments(assemblyPath string, libPath string, typeName string)[]string {
            let Flatten = func (argument CustomAttributeTypedArgument, into List[string]) {
                if argument.Value is IReadOnlyCollection[CustomAttributeTypedArgument]elements {
                    for element in elements {
                        Flatten(element, into)
                    }
                    return
                }
                if argument.Value is Type type {
                    into.Add(Describe(type))
                }
            }
            let paths = List[string](TrustedPlatformAssemblies()){assemblyPath, libPath}
            using let context = MetadataLoadContext(PathAssemblyResolver(paths.Distinct(StringComparer.Ordinal)))
            let assembly = context.LoadFromAssemblyPath(assemblyPath)
            let target = assembly.GetTypes().Single((candidate Type) -> candidate.Name == typeName)
            let described = List[string]()
            for attribute in target.GetCustomAttributesData() {
                if !attribute.AttributeType.Namespace?.StartsWith("HelperLib4073", StringComparison.Ordinal) ?? true {
                    continue
                }
                for argument in attribute.ConstructorArguments {
                    Flatten(argument, described)
                }
                for named in attribute.NamedArguments {
                    Flatten(named.TypedValue, described)
                }
            }
            return described.ToArray()
        }

        /// Describes a reified type structurally: a constructed generic reads as
        /// `Definition@DefinitionAssembly[Argument@ArgumentAssembly, …]`,
        /// an array appends `[]`, and a leaf is its full name plus the SIMPLE
        /// name of the assembly that declares it. Version and public key are
        /// deliberately left out — they are not what this issue is about — but the
        /// declaring assembly is not, because the whole defect was an argument
        /// coming from the wrong one.
        /// @param type The reified type.
        /// @returns The structural description.
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
                "HelperLib4073",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "HelperLib4073.dll")
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
