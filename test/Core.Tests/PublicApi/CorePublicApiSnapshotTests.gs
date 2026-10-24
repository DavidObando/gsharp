// <copyright file="CorePublicApiSnapshotTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.PublicApi

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import GSharp.Tests
import Xunit
import Xunit.Abstractions
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.Tests
import System.Globalization

/// Issue #4651: the public API of `GSharp.Core` is the ABI every G#
/// analyzer binds to (analyzers reference Core by assembly identity, and
/// `GS9303` only warns on an AssemblyVersion mismatch). It had no
/// snapshot, so a change to it, including one introduced by rebuilding Core
/// from its G# translation, was invisible until an analyzer failed to load.
///
/// The snapshot is rendered from METADATA (System.Reflection.Metadata), not
/// runtime reflection: it needs no dependency resolution, and it describes the
/// built assembly exactly, so the same test reads a C#-built and a G#-built
/// `GSharp.Core.dll` the same way. It records every type and member another
/// assembly can reach: public, protected and protected internal (FamORAssem);
/// private protected (FamANDAssem) is excluded because only the declaring
/// assembly's derived types see it. For each it records the shape that binds
/// callers: kind, base type,
/// interfaces, generic parameters and constraints, member signatures with
/// parameter names, and constant values (enum members included, since
/// `SyntaxKind` values are compiled into analyzers). Property and event
/// accessors are listed as methods on purpose: `get_X` and `add_E`
/// are the members a compiled analyzer actually binds to, and they carry the
/// static/abstract/virtual/sealed modifiers; the `property`/`event`
/// lines add the grouping, the init-only setter and accessor accessibilities.
/// It deliberately omits what differs between compilers without changing the
/// contract: attributes, `beforefieldinit`, layout flags and assembly
/// scopes of referenced types.
class CorePublicApiSnapshotTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    /// The public surface of the built `GSharp.Core.dll` matches the
    /// committed snapshot. An intentional API change regenerates it with
    /// `GSHARP_UPDATE_GOLDENS=1`.
    @Fact
    func GSharpCore_DoesNotDefineReplExecutionHost() {
        // ADR-0212 S0 (#5303): the REPL execution host lives in `gsi`
        // (GSharp.Repl.Engine), not in Core.
        let core = typeof(Compilation).Assembly
        Assert.Null(core.GetType("GSharp.Core.CodeAnalysis.Execution.InteractiveSessionHost"))
        Assert.Null(core.GetType("GSharp.Core.CodeAnalysis.Execution.SubmissionRunResult"))
        Assert.Null(core.GetType("GSharp.Repl.Engine.InteractiveSessionHost"))
        Assert.Null(core.GetType("GSharp.Repl.Engine.SubmissionRunResult"))
    }

    @Fact
    func GSharpCore_PublicApi_MatchesSnapshot() {
        let assemblyPath = typeof(Compilation).Assembly.Location
        let lines = RenderPublicApi(assemblyPath)
        // A snapshot of nothing would pass against an empty golden: require a
        // surface the size of the real one before comparing.
        let typeCount = lines.Count((line string) -> line.StartsWith("type ", StringComparison.Ordinal))
        Assert.True(typeCount > MinimumRenderedTypeCount, "only $typeCount public types rendered")
        // Presence only: the type's modifiers are the golden's business, so a
        // changed `class`/`sealed class` still reaches the comparison (and
        // update mode) instead of stopping here.
        Assert.Contains(
            lines,
            (line string) -> line.StartsWith("type ", StringComparison.Ordinal) && line.Contains(
                " GSharp.Core.CodeAnalysis.Compilation.Compilation ",
                StringComparison.Ordinal
            )
        )
        // ADR-0199: a G#-built Core may carry the exact, listed record
        // `Deconstruct` additions; they are removed here, reported below, and
        // everything else still has to match the native golden.
        let baselines = Path.Combine(LocateRepoRoot(), "test", "Core.Tests", "Baselines")
        let allowance = CorePublicApiAllowance.Apply(
            lines,
            CorePublicApiAllowance.Parse(
                File.ReadAllText(Path.Combine(baselines, CorePublicApiAllowance.AllowanceFileName))
            ),
            CorePublicApiAllowance.IsBuiltByGsc(assemblyPath)
        )
        this.output.WriteLine("Allowed additions present (ADR-0199): ${allowance.Present.Count}")
        for present in allowance.Present {
            this.output.WriteLine("  " + present)
        }
        GoldenFile.AssertMatches(
            Path.Combine(baselines, SnapshotFileName),
            string.Join("\n", allowance.Lines) + "\n",
            "The public API of GSharp.Core changed. Analyzers bind to it by assembly identity; if the change " +
                "is intended, regenerate with GSHARP_UPDATE_GOLDENS=1 and review the diff as an ABI change."
        )
    }

    /// The renderer sees a change to a public signature and ignores a private
    /// one, checked on a small assembly so the witness does not depend on Core.
    @Fact
    func Renderer_TracksPublicShape_AndIgnoresPrivateMembers() {
        // These are native C# metadata contracts, not types from the
        // self-migrated test assembly (which maps protected internal to internal).
        using let fixture = CSharpFixture(`namespace GSharp.Core.Tests.PublicApi;

public enum SnapshotByteEnum : byte
{
    One = 1,
}

public class SnapshotFixture
{
    public const int Answer = 42;
    public const string Quoted = "a\"b\\c\nd";
    private int hidden;

    public string Name { get; protected set; }
    public int Fixed { get; init; }
    protected internal int Shared { get; set; }

    public static int Add(int left, int right) => left + right;
    public static int Take(int count = 3) => count;
    public static int Peek(in int value) => value;
    public static decimal Price(decimal amount = 1.5m) => amount;
    public static System.DateTime At(
        [System.Runtime.InteropServices.Optional, System.Runtime.CompilerServices.DateTimeConstant(42L)]
        System.DateTime when) => when;

    protected virtual void OnChanged()
    {
        this.hidden++;
        this.HiddenHelper();
    }

    public override string ToString() => "fixture";
    private void HiddenHelper() => this.hidden--;

    protected internal sealed class Nested
    {
    }
}`)
        let rendered = RenderPublicApi(fixture.AssemblyPath)
        let baseline = string.Join(
            "\n",
            rendered.SkipWhile(
                (line string) -> !line.StartsWith(
                    "type class GSharp.Core.Tests.PublicApi.SnapshotFixture",
                    StringComparison.Ordinal
                )
            )
                .TakeWhile(
                (line string, index int32) -> index == 0 || !line.StartsWith("type ", StringComparison.Ordinal)
            )
        )
        Assert.Contains(
            "type class GSharp.Core.Tests.PublicApi.SnapshotFixture : System.Object",
            baseline,
            StringComparison.Ordinal
        )
        Assert.Contains("  method public static Int32 Add(Int32 left, Int32 right)", baseline, StringComparison.Ordinal)
        Assert.Contains("  field public const Int32 Answer = 42", baseline, StringComparison.Ordinal)
        Assert.Contains("  method public static Int32 Take(Int32 count = 3)", baseline, StringComparison.Ordinal)
        Assert.Contains("  method public static Int32 Peek(in Int32 value)", baseline, StringComparison.Ordinal)
        Assert.Contains(
            "  method public static System.Decimal Price(System.Decimal amount = 1.5m)",
            baseline,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "  method public static System.DateTime At(System.DateTime when = DateTime(42))",
            baseline,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "type protected internal sealed class GSharp.Core.Tests.PublicApi.SnapshotFixture+Nested : System.Object",
            rendered
        )
        Assert.Contains("  property public String Name { get; protected set; }", baseline, StringComparison.Ordinal)
        Assert.Contains("  property public Int32 Fixed { get; init; }", baseline, StringComparison.Ordinal)
        // Accessors are the bound members, so they are listed as methods too.
        Assert.Contains("  method public String get_Name()", baseline, StringComparison.Ordinal)
        Assert.Contains("  method protected Void set_Name(String value)", baseline, StringComparison.Ordinal)
        Assert.Contains(
            "  method public Void modreq(System.Runtime.CompilerServices.IsExternalInit) set_Fixed(Int32 value)",
            baseline,
            StringComparison.Ordinal
        )
        Assert.Contains("  property protected internal Int32 Shared { get; set; }", baseline, StringComparison.Ordinal)
        Assert.Contains("  field public const String Quoted = \"a\\\"b\\\\c\\nd\"", baseline, StringComparison.Ordinal)
        Assert.Contains("  method protected virtual Void OnChanged()", baseline, StringComparison.Ordinal)
        Assert.Contains("  method public virtual override String ToString()", baseline, StringComparison.Ordinal)
        Assert.DoesNotContain("Hidden", baseline, StringComparison.Ordinal)
        // An enum records its underlying type: changing it changes the enum's size.
        Assert.Contains("type enum GSharp.Core.Tests.PublicApi.SnapshotByteEnum : Byte", rendered)
        Assert.Contains("  field public const GSharp.Core.Tests.PublicApi.SnapshotByteEnum One = 1", rendered)
    }

    /// Renders metadata type signatures: types by namespace-qualified name
    /// (nested types with `+`), primitives by their CLR type name
    /// (`Int32`, `String`, `Void`), generic parameters by
    /// position (`!0`, `!!0`).
    private class SignatureNames : ISignatureTypeProvider[string, object] {
        private let reader MetadataReader

        init(reader MetadataReader) {
            this.reader = reader
        }

        func Describe(handle EntityHandle) string -> switch handle.Kind {
            case HandleKind.TypeDefinition: FullName(this.reader, TypeDefinitionHandle(handle))
            case HandleKind.TypeReference: this.GetTypeFromReference(this.reader, TypeReferenceHandle(handle), 0)
            case HandleKind.TypeSpecification: this.GetTypeFromSpecification(
                this.reader,
                nil,
                TypeSpecificationHandle(handle),
                0
            )
            default: throw InvalidOperationException("unsupported type handle kind " + handle.Kind.ToString())
        }

        func GetPrimitiveType(typeCode PrimitiveTypeCode) string -> typeCode.ToString()

        func GetGenericTypeParameter(genericContext object, index int32) string -> "!" + index.ToString()

        func GetGenericMethodParameter(genericContext object, index int32) string -> "!!" + index.ToString()

        func GetTypeFromDefinition(
            reader MetadataReader,
            handle TypeDefinitionHandle,
            rawTypeKind uint8
        ) string -> FullName(reader, handle)

        func GetTypeFromReference(reader MetadataReader, handle TypeReferenceHandle, rawTypeKind uint8) string {
            let reference = reader.GetTypeReference(handle)
            let name = reader.GetString(reference.Name)
            if reference.ResolutionScope.Kind == HandleKind.TypeReference {
                return this.GetTypeFromReference(reader, TypeReferenceHandle(reference.ResolutionScope), rawTypeKind) +
                    "+" +
                    name
            }
            let ns = reader.GetString(reference.Namespace)
            return if ns.Length == 0 {
                name
            } else {
                ns + "." + name
            }
        }

        func GetTypeFromSpecification(
            reader MetadataReader,
            genericContext object?,
            handle TypeSpecificationHandle,
            rawTypeKind uint8
        ) string -> reader
            .GetTypeSpecification(handle).DecodeSignature(this, genericContext)

        func GetGenericInstantiation(genericType string, typeArguments ImmutableArray[string]) string -> genericType +
            "<" +
            string.Join(", ", typeArguments) + ">"

        // A general (non-vector) array is a different type from T[] even at
        // rank one; csc's own notation for that is T[*].
        func GetArrayType(elementType string, shape ArrayShape) string -> if shape.Rank == 1 {
            elementType + "[*]"
        } else {
            elementType + "[" + String(',', shape.Rank - 1) + "]"
        }

        func GetByReferenceType(elementType string) string -> "ref " + elementType

        func GetPointerType(elementType string) string -> elementType + "*"

        func GetSZArrayType(elementType string) string -> elementType + "[]"

        func GetFunctionPointerType(signature MethodSignature[string]) string -> "delegate*<" + string.Join(
            ", ",
            signature.ParameterTypes.Append(signature.ReturnType)
        ) +
            ">"

        func GetModifiedType(modifier string, unmodifiedType string, isRequired bool) string -> unmodifiedType +
            (
            if isRequired {
                " modreq("
            } else {
                " modopt("
            }
        ) +
            modifier +
            ")"

        func GetPinnedType(elementType string) string -> elementType

        shared {
            func FullName(reader MetadataReader, handle TypeDefinitionHandle) string {
                let definition = reader.GetTypeDefinition(handle)
                let name = reader.GetString(definition.Name)
                let declaring = definition.GetDeclaringType()
                if !declaring.IsNil {
                    return FullName(reader, declaring) + "+" + name
                }
                let ns = reader.GetString(definition.Namespace)
                return if ns.Length == 0 {
                    name
                } else {
                    ns + "." + name
                }
            }
        }
    }

    shared {
        private const SnapshotFileName string = "gsharp-core-public-api.txt"

        // GSharp.Core exports over 500 types; far fewer means the renderer broke.
        private const MinimumRenderedTypeCount int32 = 300

        // The modifier an init-only setter carries on its return type.
        private const InitOnlyModifier string = "modreq(System.Runtime.CompilerServices.IsExternalInit)"

        internal func RenderPublicApi(assemblyPath string) IReadOnlyList[string] {
            using let stream = File.OpenRead(assemblyPath)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            let provider = SignatureNames(reader)
            let types = List[(Header string, Members List[string])]()
            for handle in reader.TypeDefinitions {
                let type = reader.GetTypeDefinition(handle)
                if !IsVisible(reader, type) {
                    continue
                }
                let members = List[string]()
                RenderFields(reader, type, provider, members)
                RenderMethods(reader, type, provider, members)
                RenderProperties(reader, type, provider, members)
                RenderEvents(reader, type, provider, members)
                members.Sort(StringComparer.Ordinal)
                types.Add((RenderTypeHeader(reader, handle, type, provider), members))
            }
            let lines = List[string]()
            for (header, members) in types.OrderBy(
                (t(Header string, Members List[string])) -> t.Header,
                StringComparer.Ordinal
            ) {
                lines.Add(header)
                lines.AddRange(members)
            }
            return lines
        }

        private func IsVisible(reader MetadataReader, type TypeDefinition) bool {
            let visibility = type.Attributes & TypeAttributes.VisibilityMask
            if visibility == TypeAttributes.Public {
                return true
            }
            let nestedVisible = visibility == TypeAttributes.NestedPublic ||
                visibility == TypeAttributes.NestedFamily ||
                visibility == TypeAttributes.NestedFamORAssem
            return nestedVisible && IsVisible(reader, reader.GetTypeDefinition(type.GetDeclaringType()))
        }

        private func RenderTypeHeader(
            reader MetadataReader,
            handle TypeDefinitionHandle,
            type TypeDefinition,
            provider SignatureNames
        ) string {
            let baseType string? = if type.BaseType.IsNil {
                default(string?)
            } else {
                provider.Describe(type.BaseType)
            }
            var kind string
            if (type.Attributes & TypeAttributes.Interface) != 0 {
                kind = "interface"
            } else if baseType == "System.Enum" {
                kind = "enum"
            } else if baseType == "System.ValueType" {
                kind = "struct"
            } else if baseType == "System.MulticastDelegate" {
                kind = "delegate"
            } else {
                let isAbstract = (type.Attributes & TypeAttributes.Abstract) != 0
                let isSealed = (type.Attributes & TypeAttributes.Sealed) != 0
                kind = if isAbstract && isSealed {
                    "static class"
                } else {
                    (
                        if isAbstract {
                            "abstract class"
                        } else {
                            (
                                if isSealed {
                                    "sealed class"
                                } else {
                                    "class"
                                }
                            )
                        }
                    )
                }
            }
            // A nested type's own accessibility is part of who can see it; a
            // top-level visible type is always public.
            let visibility = type.Attributes & TypeAttributes.VisibilityMask
            let nestedAccess = if visibility == TypeAttributes.NestedPublic {
                "public "
            } else {
                (
                    if visibility == TypeAttributes.NestedFamily {
                        "protected "
                    } else {
                        (
                            if visibility == TypeAttributes.NestedFamORAssem {
                                "protected internal "
                            } else {
                                string.Empty
                            }
                        )
                    }
                )
            }
            let header = StringBuilder("type ")
                .Append(nestedAccess)
                .Append(kind)
                .Append(' ')
                .Append(SignatureNames.FullName(reader, handle))
            header.Append(RenderGenericParameters(reader, type.GetGenericParameters(), provider))
            let supertypes = List[string]()
            if baseType != nil &&
                (kind == "class" || kind == "abstract class" || kind == "sealed class" || kind == "static class") {
                supertypes.Add(baseType)
            } else if kind == "enum" {
                // The underlying type lives on the special `value__` field, which
                // the member list skips; it decides the enum's size and passing.
                supertypes.Add(EnumUnderlyingType(reader, type, provider))
            }
            supertypes.AddRange(
                type
                    .GetInterfaceImplementations()
                    .Select(
                    (i InterfaceImplementationHandle) -> provider.Describe(
                        reader.GetInterfaceImplementation(i).Interface
                    )
                )
                    .OrderBy((name string) -> name, StringComparer.Ordinal)
            )
            if supertypes.Count > 0 {
                header.Append(" : ").Append(string.Join(", ", supertypes))
            }
            return header.ToString()
        }

        private func EnumUnderlyingType(reader MetadataReader, type TypeDefinition, provider SignatureNames) string {
            // ECMA-335 II.14.3: the underlying type is the type of the instance
            // field named `value__`.
            for handle in type.GetFields() {
                let field = reader.GetFieldDefinition(handle)
                if (field.Attributes & FieldAttributes.Static) == 0 && reader.GetString(field.Name) == "value__" {
                    return field.DecodeSignature(provider, nil)
                }
            }
            throw InvalidOperationException("enum without a value__ field: " + reader.GetString(type.Name))
        }

        private func RenderGenericParameters(
            reader MetadataReader,
            parameters GenericParameterHandleCollection,
            provider SignatureNames
        ) string {
            if parameters.Count == 0 {
                return string.Empty
            }
            let rendered = List[string]()
            for handle in parameters {
                let parameter = reader.GetGenericParameter(handle)
                let constraints = List[string]()
                let flags = parameter.Attributes
                if (flags & GenericParameterAttributes.ReferenceTypeConstraint) != 0 {
                    constraints.Add("class")
                }
                if (flags & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0 {
                    constraints.Add("struct")
                }
                if (flags & GenericParameterAttributes.DefaultConstructorConstraint) != 0 {
                    constraints.Add("new()")
                }
                constraints.AddRange(
                    parameter
                        .GetConstraints()
                        .Select(
                        (c GenericParameterConstraintHandle) -> provider.Describe(
                            reader.GetGenericParameterConstraint(c).Type
                        )
                    )
                        .OrderBy((name string) -> name, StringComparer.Ordinal)
                )
                let variance = if (flags & GenericParameterAttributes.Covariant) != 0 {
                    "out "
                } else {
                    (
                        if (flags & GenericParameterAttributes.Contravariant) != 0 {
                            "in "
                        } else {
                            string.Empty
                        }
                    )
                }
                let name = variance + reader.GetString(parameter.Name)
                rendered.Add(
                    if constraints.Count == 0 {
                        name
                    } else {
                        name + " : " + string.Join(" & ", constraints)
                    }
                )
            }
            return "<" + string.Join(", ", rendered) + ">"
        }

        private func RenderFields(
            reader MetadataReader,
            type TypeDefinition,
            provider SignatureNames,
            members List[string]
        ) {
            for handle in type.GetFields() {
                let field = reader.GetFieldDefinition(handle)
                let access string? = Access(field.Attributes & FieldAttributes.FieldAccessMask)
                if access == nil || (field.Attributes & FieldAttributes.SpecialName) != 0 {
                    continue
                }
                let line = StringBuilder("  field ").Append(access)
                if (field.Attributes & FieldAttributes.Literal) != 0 {
                    line.Append(" const")
                } else {
                    line.Append(
                        if (field.Attributes & FieldAttributes.Static) != 0 {
                            " static"
                        } else {
                            string.Empty
                        }
                    )
                        .Append(
                        if (field.Attributes & FieldAttributes.InitOnly) != 0 {
                            " readonly"
                        } else {
                            string.Empty
                        }
                    )
                }
                line
                    .Append(' ')
                    .Append(field.DecodeSignature(provider, nil))
                    .Append(' ')
                    .Append(reader.GetString(field.Name))
                let constant = field.GetDefaultValue()
                let attributeConstant string? = AttributeConstant(reader, field.GetCustomAttributes())
                if !constant.IsNil {
                    line.Append(" = ").Append(CorePublicApiSnapshotTests.ConstantValue(reader, constant))
                } else if attributeConstant != nil {
                    line.Append(" = ").Append(attributeConstant)
                }
                members.Add(line.ToString())
            }
        }

        private func RenderMethods(
            reader MetadataReader,
            type TypeDefinition,
            provider SignatureNames,
            members List[string]
        ) {
            for handle in type.GetMethods() {
                let method = reader.GetMethodDefinition(handle)
                let access string? = Access(method.Attributes & MethodAttributes.MemberAccessMask)
                if access == nil {
                    continue
                }
                let signature = method.DecodeSignature(provider, nil)
                let line = StringBuilder("  method ")
                    .Append(access)
                    .Append(MethodModifiers(method.Attributes))
                    .Append(' ')
                    .Append(signature.ReturnType)
                    .Append(' ')
                    .Append(reader.GetString(method.Name))
                    .Append(RenderGenericParameters(reader, method.GetGenericParameters(), provider))
                let names = Dictionary[int32, (Name string, Default string?, Out bool, In bool)]()
                for parameterHandle in method.GetParameters() {
                    let parameter = reader.GetParameter(parameterHandle)
                    if parameter.SequenceNumber == 0 {
                        // The return-value row carries no name to pin.
                        continue
                    }
                    // An optional parameter's default is baked into callers, so the
                    // value itself is part of the API, not just its presence.
                    var defaultValue string? = nil
                    if (parameter.Attributes & ParameterAttributes.Optional) != 0 {
                        let constant = parameter.GetDefaultValue()
                        defaultValue = if !constant.IsNil {
                            CorePublicApiSnapshotTests.ConstantValue(reader, constant)
                        } else {
                            AttributeConstant(reader, parameter.GetCustomAttributes()) ?? "?"
                        }
                    }
                    names[parameter.SequenceNumber] = (
                        if parameter.Name.IsNil {
                            "arg" + parameter.SequenceNumber.ToString(CultureInfo.InvariantCulture)
                        } else {
                            reader.GetString(parameter.Name)
                        },
                        defaultValue,
                        (parameter.Attributes & ParameterAttributes.Out) != 0,
                        (parameter.Attributes & ParameterAttributes.In) != 0
                    )
                }
                let parameters = List[string]()
                for var index = 0; index < signature.ParameterTypes.Length; index++ {
                    var rendered = signature.ParameterTypes[index]
                    // ECMA-335 allows a parameter without a Param row: name it
                    // positionally so every parameter renders the same shape.
                    if !names.TryGetValue(index + 1, out var parameter) {
                        parameter = ("arg" + (index + 1).ToString(CultureInfo.InvariantCulture), nil, false, false)
                    }
                    // csc marks `out` and `in` with parameter flags; only virtual
                    // methods also carry a modreq for `in`, so the flag decides.
                    if parameter.Out && rendered.StartsWith("ref ", StringComparison.Ordinal) {
                        rendered = "out " + rendered.Substring("ref ".Length)
                    } else if parameter.In && rendered.StartsWith("ref ", StringComparison.Ordinal) {
                        rendered = "in " + rendered.Substring("ref ".Length)
                    }
                    rendered += " " +
                        parameter.Name +
                        (
                        if parameter.Default == nil {
                            string.Empty
                        } else {
                            " = " + parameter.Default
                        }
                    )
                    parameters.Add(rendered)
                }
                line.Append('(').Append(string.Join(", ", parameters)).Append(')')
                members.Add(line.ToString())
            }
        }

        private func RenderProperties(
            reader MetadataReader,
            type TypeDefinition,
            provider SignatureNames,
            members List[string]
        ) {
            for handle in type.GetProperties() {
                let property = reader.GetPropertyDefinition(handle)
                let accessors = property.GetAccessors()
                let getter string? = AccessorAccess(reader, accessors.Getter)
                let setter string? = AccessorAccess(reader, accessors.Setter)
                if getter == nil && setter == nil {
                    continue
                }
                let widest string? = WidestAccess(getter, setter)
                let signature = property.DecodeSignature(provider, nil)
                let line = StringBuilder("  property ")
                    .Append(widest)
                    .Append(' ')
                    .Append(signature.ReturnType)
                    .Append(' ')
                    .Append(reader.GetString(property.Name))
                if signature.ParameterTypes.Length > 0 {
                    line.Append('[').Append(string.Join(", ", signature.ParameterTypes)).Append(']')
                }
                line.Append(" {")
                if getter != nil {
                    line.Append(
                        if getter == widest {
                            " get;"
                        } else {
                            " " + getter + " get;"
                        }
                    )
                }
                if setter != nil {
                    // An init-only setter carries modreq(IsExternalInit) on its
                    // return type; `set` and `init` are different contracts.
                    let keyword = if reader
                        .GetMethodDefinition(accessors.Setter)
                        .DecodeSignature(provider, nil)
                        .ReturnType
                        .Contains(InitOnlyModifier, StringComparison.Ordinal) {
                        "init;"
                    } else {
                        "set;"
                    }
                    line.Append(
                        if setter == widest {
                            " " + keyword
                        } else {
                            " " + setter + " " + keyword
                        }
                    )
                }
                members.Add(line.Append(" }").ToString())
            }
        }

        private func RenderEvents(
            reader MetadataReader,
            type TypeDefinition,
            provider SignatureNames,
            members List[string]
        ) {
            for handle in type.GetEvents() {
                let definition = reader.GetEventDefinition(handle)
                let accessors = definition.GetAccessors()
                // The event is as visible as its widest accessor (add, remove or raise).
                let widest string? = WidestAccess(
                    AccessorAccess(reader, accessors.Adder),
                    AccessorAccess(reader, accessors.Remover),
                    AccessorAccess(reader, accessors.Raiser)
                )
                if widest == nil {
                    continue
                }
                members.Add(
                    "  event " + widest + " " + provider.Describe(definition.Type) + " " + reader.GetString(
                        definition.Name
                    )
                )
            }
        }

        // The widest visible accessibility among accessors (null when none is).
        private func WidestAccess(access ...string?) string? -> if access.Contains("public") {
            "public"
        } else {
            (
                if access.Contains("protected internal") {
                    "protected internal"
                } else {
                    (
                        if access.Contains("protected") {
                            "protected"
                        } else {
                            default(string?)
                        }
                    )
                }
            )
        }

        private func AccessorAccess(
            reader MetadataReader,
            accessor MethodDefinitionHandle
        ) string? -> if accessor.IsNil {
            default(string?)
        } else {
            Access(reader.GetMethodDefinition(accessor).Attributes & MethodAttributes.MemberAccessMask)
        }

        // FamORAssem (`protected internal`) is kept distinct from Family: narrowing
        // one to the other changes what derived types in other assemblies can reach.
        private func Access(access FieldAttributes) string? -> switch access {
            case FieldAttributes.Public: "public"
            case FieldAttributes.Family: "protected"
            case FieldAttributes.FamORAssem: "protected internal"
            default: default(string?)
        }

        private func Access(access MethodAttributes) string? -> switch access {
            case MethodAttributes.Public: "public"
            case MethodAttributes.Family: "protected"
            case MethodAttributes.FamORAssem: "protected internal"
            default: default(string?)
        }

        private func MethodModifiers(attributes MethodAttributes) string {
            let modifiers = StringBuilder()
            if (attributes & MethodAttributes.Static) != 0 {
                modifiers.Append(" static")
            }
            if (attributes & MethodAttributes.Abstract) != 0 {
                modifiers.Append(" abstract")
            } else if (attributes & MethodAttributes.Virtual) != 0 {
                modifiers.Append(
                    if (attributes & MethodAttributes.Final) != 0 {
                        " sealed"
                    } else {
                        " virtual"
                    }
                )
            }
            // A virtual without newslot reuses an inherited slot (an override);
            // with newslot it starts one. The difference changes dispatch for
            // derived types, so it is part of the contract.
            if (attributes & MethodAttributes.Virtual) != 0 && (attributes & MethodAttributes.NewSlot) == 0 {
                modifiers.Append(" override")
            }
            return modifiers.ToString()
        }

        /// A compile-time constant that metadata cannot store in the Constant table
        /// and csc therefore encodes as an attribute: `decimal`
        /// (`DecimalConstantAttribute`) and `DateTime`
        /// (`DateTimeConstantAttribute`). Callers bake these in like any other
        /// constant. Returns `null` when neither attribute is present.
        private func AttributeConstant(reader MetadataReader, attributes CustomAttributeHandleCollection) string? {
            for handle in attributes {
                let attribute = reader.GetCustomAttribute(handle)
                let name = AttributeTypeName(reader, attribute.Constructor)
                var blob = reader.GetBlobReader(attribute.Value)
                if blob.Length < 2 || blob.ReadUInt16() != uint16(1) {
                    continue
                }
                if name == "System.Runtime.CompilerServices.DecimalConstantAttribute" {
                    let scale = blob.ReadByte()
                    let sign = blob.ReadByte()
                    let high = blob.ReadInt32()
                    let middle = blob.ReadInt32()
                    let low = blob.ReadInt32()
                    let value = System.Decimal(low, middle, high, sign != uint8(0), scale)
                    return value.ToString(CultureInfo.InvariantCulture) + "m"
                }
                if name == "System.Runtime.CompilerServices.DateTimeConstantAttribute" {
                    return "DateTime(" + blob.ReadInt64().ToString(CultureInfo.InvariantCulture) + ")"
                }
            }
            return nil
        }

        private func AttributeTypeName(reader MetadataReader, constructor EntityHandle) string {
            let type = switch constructor.Kind {
                case HandleKind.MemberReference: reader.GetMemberReference(MemberReferenceHandle(constructor)).Parent
                case HandleKind.MethodDefinition: EntityHandle(
                    reader.GetMethodDefinition(MethodDefinitionHandle(constructor)).GetDeclaringType()
                )
                default: default(EntityHandle)
            }
            return switch type.Kind {
                case HandleKind.TypeReference: QualifiedName(reader, reader.GetTypeReference(TypeReferenceHandle(type)))
                case HandleKind.TypeDefinition: SignatureNames.FullName(reader, TypeDefinitionHandle(type))
                default: string.Empty
            }
        }

        private func QualifiedName(reader MetadataReader, reference TypeReference) string {
            let ns = reader.GetString(reference.Namespace)
            let name = reader.GetString(reference.Name)
            return if ns.Length == 0 {
                name
            } else {
                ns + "." + name
            }
        }

        private func ConstantValue(reader MetadataReader, handle ConstantHandle) string {
            let constant = reader.GetConstant(handle)
            var blob = reader.GetBlobReader(constant.Value)
            return switch constant.TypeCode {
                case ConstantTypeCode.Boolean: if blob.ReadBoolean() {
                    "true"
                } else {
                    "false"
                }
                case ConstantTypeCode.Char: (int32(blob.ReadChar())).ToString(CultureInfo.InvariantCulture)
                case ConstantTypeCode.SByte: blob.ReadSByte().ToString(CultureInfo.InvariantCulture)
                case ConstantTypeCode.Byte: blob.ReadByte().ToString(CultureInfo.InvariantCulture)
                case ConstantTypeCode.Int16: blob.ReadInt16().ToString(CultureInfo.InvariantCulture)
                case ConstantTypeCode.UInt16: blob.ReadUInt16().ToString(CultureInfo.InvariantCulture)
                case ConstantTypeCode.Int32: blob.ReadInt32().ToString(CultureInfo.InvariantCulture)
                case ConstantTypeCode.UInt32: blob.ReadUInt32().ToString(CultureInfo.InvariantCulture)
                case ConstantTypeCode.Int64: blob.ReadInt64().ToString(CultureInfo.InvariantCulture)
                case ConstantTypeCode.UInt64: blob.ReadUInt64().ToString(CultureInfo.InvariantCulture)
                case ConstantTypeCode.Single: blob.ReadSingle().ToString("R", CultureInfo.InvariantCulture)
                case ConstantTypeCode.Double: blob.ReadDouble().ToString("R", CultureInfo.InvariantCulture)
                case ConstantTypeCode.String: Quote(blob.ReadUTF16(blob.Length))
                case ConstantTypeCode.NullReference: "null"
                default: throw InvalidOperationException(
                    "unsupported constant type " + constant.TypeCode.ToString() +
                        "; render it explicitly rather than lose its value"
                )
            }
        }

        /// Quotes a string constant on ONE line: backslash, quote and every control
        /// character are escaped, so a constant can never split or blur the
        /// snapshot's line format.
        private func Quote(value string) string {
            let quoted = StringBuilder("\"")
            for character in value {
                switch character {
                    case '\\' {
                        quoted.Append("\\\\")
                    }
                    case '"' {
                        quoted.Append("\\\"")
                    }
                    case '\n' {
                        quoted.Append("\\n")
                    }
                    case '\r' {
                        quoted.Append("\\r")
                    }
                    case '\t' {
                        quoted.Append("\\t")
                    }
                    default {
                        if char.IsControl(character) {
                            quoted.Append("\\u").Append((int32(character)).ToString("x4", CultureInfo.InvariantCulture))
                        } else {
                            quoted.Append(character)
                        }
                    }
                }
            }
            return quoted.Append('"').ToString()
        }

        internal func LocateRepoRoot() string {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                if File.Exists(Path.Combine(dir.FullName, "test", "Core.Tests", "Baselines", SnapshotFileName)) {
                    return dir.FullName
                }
                dir = dir.Parent
            }
            throw InvalidOperationException(
                "no ancestor of " + AppContext.BaseDirectory + " holds test/Core.Tests/Baselines/" + SnapshotFileName
            )
        }
    }
}
