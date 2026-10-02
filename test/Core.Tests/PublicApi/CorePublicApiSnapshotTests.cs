// <copyright file="CorePublicApiSnapshotTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.PublicApi;

/// <summary>
/// Issue #4651: the public API of <c>GSharp.Core</c> is the ABI every G#
/// analyzer binds to (analyzers reference Core by assembly identity, and
/// <c>GS9303</c> only warns on an AssemblyVersion mismatch). It had no
/// snapshot, so a change to it, including one introduced by rebuilding Core
/// from its G# translation, was invisible until an analyzer failed to load.
/// <para>
/// The snapshot is rendered from METADATA (System.Reflection.Metadata), not
/// runtime reflection: it needs no dependency resolution, and it describes the
/// built assembly exactly, so the same test reads a C#-built and a G#-built
/// <c>GSharp.Core.dll</c> the same way. It records every public or protected
/// type and member with the shape that binds callers: kind, base type,
/// interfaces, generic parameters and constraints, member signatures with
/// parameter names, and constant values (enum members included, since
/// <c>SyntaxKind</c> values are compiled into analyzers). Property and event
/// accessors are listed as methods on purpose: <c>get_X</c> and <c>add_E</c>
/// are the members a compiled analyzer actually binds to, and they carry the
/// static/abstract/virtual/sealed modifiers; the <c>property</c>/<c>event</c>
/// lines add the grouping, the init-only setter and accessor accessibilities.
/// It deliberately omits what differs between compilers without changing the
/// contract: attributes, <c>beforefieldinit</c>, layout flags and assembly
/// scopes of referenced types.
/// </para>
/// </summary>
public sealed class CorePublicApiSnapshotTests
{
    private const string SnapshotFileName = "gsharp-core-public-api.txt";

    // The modifier an init-only setter carries on its return type.
    private const string InitOnlyModifier = "modreq(System.Runtime.CompilerServices.IsExternalInit)";

    /// <summary>
    /// The public surface of the built <c>GSharp.Core.dll</c> matches the
    /// committed snapshot. An intentional API change regenerates it with
    /// <c>GSHARP_UPDATE_GOLDENS=1</c>.
    /// </summary>
    [Fact]
    public void GSharpCore_PublicApi_MatchesSnapshot()
    {
        string assemblyPath = typeof(GSharp.Core.CodeAnalysis.Compilation.Compilation).Assembly.Location;
        IReadOnlyList<string> lines = RenderPublicApi(assemblyPath);

        // A snapshot of nothing would pass against an empty golden: require a
        // surface the size of the real one before comparing.
        Assert.True(lines.Count(line => line.StartsWith("type ", StringComparison.Ordinal)) > 300, "too few public types rendered");
        Assert.Contains(lines, line => line.StartsWith("type class GSharp.Core.CodeAnalysis.Compilation.Compilation", StringComparison.Ordinal));

        GoldenFile.AssertMatches(
            Path.Combine(LocateRepoRoot(), "test", "Core.Tests", "Baselines", SnapshotFileName),
            string.Join("\n", lines) + "\n",
            "The public API of GSharp.Core changed. Analyzers bind to it by assembly identity; if the change "
            + "is intended, regenerate with GSHARP_UPDATE_GOLDENS=1 and review the diff as an ABI change.");
    }

    /// <summary>
    /// The renderer sees a change to a public signature and ignores a private
    /// one, checked on a small assembly so the witness does not depend on Core.
    /// </summary>
    [Fact]
    public void Renderer_TracksPublicShape_AndIgnoresPrivateMembers()
    {
        IReadOnlyList<string> rendered = RenderPublicApi(typeof(SnapshotFixture).Assembly.Location);
        string baseline = string.Join("\n", rendered
            .SkipWhile(line => !line.StartsWith("type class GSharp.Core.Tests.PublicApi.SnapshotFixture", StringComparison.Ordinal))
            .TakeWhile((line, index) => index == 0 || !line.StartsWith("type ", StringComparison.Ordinal)));

        Assert.Contains("type class GSharp.Core.Tests.PublicApi.SnapshotFixture : System.Object", baseline, StringComparison.Ordinal);
        Assert.Contains("  method public static Int32 Add(Int32 left, Int32 right)", baseline, StringComparison.Ordinal);
        Assert.Contains("  field public const Int32 Answer = 42", baseline, StringComparison.Ordinal);
        Assert.Contains("  method public static Int32 Take(Int32 count = 3)", baseline, StringComparison.Ordinal);
        Assert.Contains("  method public static Int32 Peek(in Int32 value)", baseline, StringComparison.Ordinal);
        Assert.Contains(
            "type protected internal sealed class GSharp.Core.Tests.PublicApi.SnapshotFixture+Nested : System.Object",
            rendered);
        Assert.Contains("  property public String Name { get; protected set; }", baseline, StringComparison.Ordinal);
        Assert.Contains("  property public Int32 Fixed { get; init; }", baseline, StringComparison.Ordinal);

        // Accessors are the bound members, so they are listed as methods too.
        Assert.Contains("  method public String get_Name()", baseline, StringComparison.Ordinal);
        Assert.Contains("  method protected Void set_Name(String value)", baseline, StringComparison.Ordinal);
        Assert.Contains(
            "  method public Void modreq(System.Runtime.CompilerServices.IsExternalInit) set_Fixed(Int32 value)",
            baseline,
            StringComparison.Ordinal);
        Assert.Contains("  property protected internal Int32 Shared { get; set; }", baseline, StringComparison.Ordinal);
        Assert.Contains("  field public const String Quoted = \"a\\\"b\\\\c\\nd\"", baseline, StringComparison.Ordinal);
        Assert.Contains("  method protected virtual Void OnChanged()", baseline, StringComparison.Ordinal);
        Assert.Contains("  method public virtual override String ToString()", baseline, StringComparison.Ordinal);
        Assert.DoesNotContain("Hidden", baseline, StringComparison.Ordinal);

        // An enum records its underlying type: changing it changes the enum's size.
        Assert.Contains(
            "type enum GSharp.Core.Tests.PublicApi.SnapshotByteEnum : Byte",
            rendered);
    }

    internal static IReadOnlyList<string> RenderPublicApi(string assemblyPath)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        MetadataReader reader = pe.GetMetadataReader();
        var provider = new SignatureNames(reader);
        var types = new List<(string Header, List<string> Members)>();

        foreach (TypeDefinitionHandle handle in reader.TypeDefinitions)
        {
            TypeDefinition type = reader.GetTypeDefinition(handle);
            if (!IsVisible(reader, type))
            {
                continue;
            }

            var members = new List<string>();
            RenderFields(reader, type, provider, members);
            RenderMethods(reader, type, provider, members);
            RenderProperties(reader, type, provider, members);
            RenderEvents(reader, type, provider, members);
            members.Sort(StringComparer.Ordinal);
            types.Add((RenderTypeHeader(reader, handle, type, provider), members));
        }

        var lines = new List<string>();
        foreach ((string header, List<string> members) in types.OrderBy(t => t.Header, StringComparer.Ordinal))
        {
            lines.Add(header);
            lines.AddRange(members);
        }

        return lines;
    }

    private static bool IsVisible(MetadataReader reader, TypeDefinition type)
    {
        TypeAttributes visibility = type.Attributes & TypeAttributes.VisibilityMask;
        if (visibility == TypeAttributes.Public)
        {
            return true;
        }

        bool nestedVisible = visibility == TypeAttributes.NestedPublic
            || visibility == TypeAttributes.NestedFamily
            || visibility == TypeAttributes.NestedFamORAssem;
        return nestedVisible && IsVisible(reader, reader.GetTypeDefinition(type.GetDeclaringType()));
    }

    private static string RenderTypeHeader(
        MetadataReader reader, TypeDefinitionHandle handle, TypeDefinition type, SignatureNames provider)
    {
        string baseType = type.BaseType.IsNil ? null : provider.Describe(type.BaseType);
        string kind;
        if ((type.Attributes & TypeAttributes.Interface) != 0)
        {
            kind = "interface";
        }
        else if (baseType == "System.Enum")
        {
            kind = "enum";
        }
        else if (baseType == "System.ValueType")
        {
            kind = "struct";
        }
        else if (baseType == "System.MulticastDelegate")
        {
            kind = "delegate";
        }
        else
        {
            bool isAbstract = (type.Attributes & TypeAttributes.Abstract) != 0;
            bool isSealed = (type.Attributes & TypeAttributes.Sealed) != 0;
            kind = isAbstract && isSealed ? "static class" : isAbstract ? "abstract class" : isSealed ? "sealed class" : "class";
        }

        // A nested type's own accessibility is part of who can see it; a
        // top-level visible type is always public.
        TypeAttributes visibility = type.Attributes & TypeAttributes.VisibilityMask;
        string nestedAccess = visibility == TypeAttributes.NestedPublic ? "public "
            : visibility == TypeAttributes.NestedFamily ? "protected "
            : visibility == TypeAttributes.NestedFamORAssem ? "protected internal "
            : string.Empty;
        var header = new StringBuilder("type ").Append(nestedAccess).Append(kind).Append(' ')
            .Append(SignatureNames.FullName(reader, handle));
        header.Append(RenderGenericParameters(reader, type.GetGenericParameters(), provider));
        var supertypes = new List<string>();
        if (baseType is not null && kind is "class" or "abstract class" or "sealed class" or "static class")
        {
            supertypes.Add(baseType);
        }
        else if (kind == "enum")
        {
            // The underlying type lives on the special `value__` field, which
            // the member list skips; it decides the enum's size and passing.
            supertypes.Add(EnumUnderlyingType(reader, type, provider));
        }

        supertypes.AddRange(type.GetInterfaceImplementations()
            .Select(i => provider.Describe(reader.GetInterfaceImplementation(i).Interface))
            .OrderBy(name => name, StringComparer.Ordinal));
        if (supertypes.Count > 0)
        {
            header.Append(" : ").Append(string.Join(", ", supertypes));
        }

        return header.ToString();
    }

    private static string EnumUnderlyingType(MetadataReader reader, TypeDefinition type, SignatureNames provider)
    {
        // ECMA-335 II.14.3: the underlying type is the type of the instance
        // field named `value__`.
        foreach (FieldDefinitionHandle handle in type.GetFields())
        {
            FieldDefinition field = reader.GetFieldDefinition(handle);
            if ((field.Attributes & FieldAttributes.Static) == 0 && reader.GetString(field.Name) == "value__")
            {
                return field.DecodeSignature(provider, null);
            }
        }

        throw new InvalidOperationException("enum without a value__ field: " + reader.GetString(type.Name));
    }

    private static string RenderGenericParameters(
        MetadataReader reader, GenericParameterHandleCollection parameters, SignatureNames provider)
    {
        if (parameters.Count == 0)
        {
            return string.Empty;
        }

        var rendered = new List<string>();
        foreach (GenericParameterHandle handle in parameters)
        {
            GenericParameter parameter = reader.GetGenericParameter(handle);
            var constraints = new List<string>();
            GenericParameterAttributes flags = parameter.Attributes;
            if ((flags & GenericParameterAttributes.ReferenceTypeConstraint) != 0)
            {
                constraints.Add("class");
            }

            if ((flags & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0)
            {
                constraints.Add("struct");
            }

            if ((flags & GenericParameterAttributes.DefaultConstructorConstraint) != 0)
            {
                constraints.Add("new()");
            }

            constraints.AddRange(parameter.GetConstraints()
                .Select(c => provider.Describe(reader.GetGenericParameterConstraint(c).Type))
                .OrderBy(name => name, StringComparer.Ordinal));
            string variance = (flags & GenericParameterAttributes.Covariant) != 0 ? "out "
                : (flags & GenericParameterAttributes.Contravariant) != 0 ? "in " : string.Empty;
            string name = variance + reader.GetString(parameter.Name);
            rendered.Add(constraints.Count == 0 ? name : name + " : " + string.Join(" & ", constraints));
        }

        return "<" + string.Join(", ", rendered) + ">";
    }

    private static void RenderFields(MetadataReader reader, TypeDefinition type, SignatureNames provider, List<string> members)
    {
        foreach (FieldDefinitionHandle handle in type.GetFields())
        {
            FieldDefinition field = reader.GetFieldDefinition(handle);
            string access = Access(field.Attributes & FieldAttributes.FieldAccessMask);
            if (access is null || (field.Attributes & FieldAttributes.SpecialName) != 0)
            {
                continue;
            }

            var line = new StringBuilder("  field ").Append(access);
            if ((field.Attributes & FieldAttributes.Literal) != 0)
            {
                line.Append(" const");
            }
            else
            {
                line.Append((field.Attributes & FieldAttributes.Static) != 0 ? " static" : string.Empty)
                    .Append((field.Attributes & FieldAttributes.InitOnly) != 0 ? " readonly" : string.Empty);
            }

            line.Append(' ').Append(field.DecodeSignature(provider, null)).Append(' ').Append(reader.GetString(field.Name));
            ConstantHandle constant = field.GetDefaultValue();
            if (!constant.IsNil)
            {
                line.Append(" = ").Append(ConstantValue(reader, constant));
            }

            members.Add(line.ToString());
        }
    }

    private static void RenderMethods(MetadataReader reader, TypeDefinition type, SignatureNames provider, List<string> members)
    {
        foreach (MethodDefinitionHandle handle in type.GetMethods())
        {
            MethodDefinition method = reader.GetMethodDefinition(handle);
            string access = Access(method.Attributes & MethodAttributes.MemberAccessMask);
            if (access is null)
            {
                continue;
            }

            MethodSignature<string> signature = method.DecodeSignature(provider, null);
            var line = new StringBuilder("  method ").Append(access).Append(MethodModifiers(method.Attributes))
                .Append(' ').Append(signature.ReturnType).Append(' ').Append(reader.GetString(method.Name))
                .Append(RenderGenericParameters(reader, method.GetGenericParameters(), provider));
            var names = new Dictionary<int, (string Name, string Default, bool Out, bool In)>();
            foreach (ParameterHandle parameterHandle in method.GetParameters())
            {
                Parameter parameter = reader.GetParameter(parameterHandle);
                if (parameter.SequenceNumber == 0)
                {
                    // The return-value row carries no name to pin.
                    continue;
                }

                // An optional parameter's default is baked into callers, so the
                // value itself is part of the API, not just its presence.
                string defaultValue = null;
                if ((parameter.Attributes & ParameterAttributes.Optional) != 0)
                {
                    ConstantHandle constant = parameter.GetDefaultValue();
                    defaultValue = constant.IsNil ? "?" : ConstantValue(reader, constant);
                }

                names[parameter.SequenceNumber] = (
                    parameter.Name.IsNil
                        ? "arg" + parameter.SequenceNumber.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        : reader.GetString(parameter.Name),
                    defaultValue,
                    (parameter.Attributes & ParameterAttributes.Out) != 0,
                    (parameter.Attributes & ParameterAttributes.In) != 0);
            }

            var parameters = new List<string>();
            for (int index = 0; index < signature.ParameterTypes.Length; index++)
            {
                string rendered = signature.ParameterTypes[index];
                // ECMA-335 allows a parameter without a Param row: name it
                // positionally so every parameter renders the same shape.
                if (!names.TryGetValue(index + 1, out (string Name, string Default, bool Out, bool In) parameter))
                {
                    parameter = ("arg" + (index + 1).ToString(System.Globalization.CultureInfo.InvariantCulture), null, false, false);
                }

                // csc marks `out` and `in` with parameter flags; only virtual
                // methods also carry a modreq for `in`, so the flag decides.
                if (parameter.Out && rendered.StartsWith("ref ", StringComparison.Ordinal))
                {
                    rendered = "out " + rendered.Substring("ref ".Length);
                }
                else if (parameter.In && rendered.StartsWith("ref ", StringComparison.Ordinal))
                {
                    rendered = "in " + rendered.Substring("ref ".Length);
                }

                rendered += " " + parameter.Name + (parameter.Default is null ? string.Empty : " = " + parameter.Default);

                parameters.Add(rendered);
            }

            line.Append('(').Append(string.Join(", ", parameters)).Append(')');
            members.Add(line.ToString());
        }
    }

    private static void RenderProperties(MetadataReader reader, TypeDefinition type, SignatureNames provider, List<string> members)
    {
        foreach (PropertyDefinitionHandle handle in type.GetProperties())
        {
            PropertyDefinition property = reader.GetPropertyDefinition(handle);
            PropertyAccessors accessors = property.GetAccessors();
            string getter = AccessorAccess(reader, accessors.Getter);
            string setter = AccessorAccess(reader, accessors.Setter);
            if (getter is null && setter is null)
            {
                continue;
            }

            string widest = getter == "public" || setter == "public" ? "public"
                : getter == "protected internal" || setter == "protected internal" ? "protected internal"
                : "protected";
            MethodSignature<string> signature = property.DecodeSignature(provider, null);
            var line = new StringBuilder("  property ").Append(widest).Append(' ')
                .Append(signature.ReturnType).Append(' ').Append(reader.GetString(property.Name));
            if (signature.ParameterTypes.Length > 0)
            {
                line.Append('[').Append(string.Join(", ", signature.ParameterTypes)).Append(']');
            }

            line.Append(" {");
            if (getter is not null)
            {
                line.Append(getter == widest ? " get;" : " " + getter + " get;");
            }

            if (setter is not null)
            {
                // An init-only setter carries modreq(IsExternalInit) on its
                // return type; `set` and `init` are different contracts.
                string keyword = reader.GetMethodDefinition(accessors.Setter).DecodeSignature(provider, null).ReturnType
                    .Contains(InitOnlyModifier, StringComparison.Ordinal)
                    ? "init;"
                    : "set;";
                line.Append(setter == widest ? " " + keyword : " " + setter + " " + keyword);
            }

            members.Add(line.Append(" }").ToString());
        }
    }

    private static void RenderEvents(MetadataReader reader, TypeDefinition type, SignatureNames provider, List<string> members)
    {
        foreach (EventDefinitionHandle handle in type.GetEvents())
        {
            EventDefinition definition = reader.GetEventDefinition(handle);
            EventAccessors accessors = definition.GetAccessors();

            // The event is as visible as its widest accessor (add, remove or raise).
            string[] access =
            {
                AccessorAccess(reader, accessors.Adder),
                AccessorAccess(reader, accessors.Remover),
                AccessorAccess(reader, accessors.Raiser),
            };
            string widest = access.Contains("public") ? "public"
                : access.Contains("protected internal") ? "protected internal"
                : access.Contains("protected") ? "protected"
                : null;
            if (widest is null)
            {
                continue;
            }

            members.Add("  event " + widest + " " + provider.Describe(definition.Type) + " " + reader.GetString(definition.Name));
        }
    }

    private static string AccessorAccess(MetadataReader reader, MethodDefinitionHandle accessor) =>
        accessor.IsNil
            ? null
            : Access(reader.GetMethodDefinition(accessor).Attributes & MethodAttributes.MemberAccessMask);

    // FamORAssem (`protected internal`) is kept distinct from Family: narrowing
    // one to the other changes what derived types in other assemblies can reach.
    private static string Access(FieldAttributes access) => access switch
    {
        FieldAttributes.Public => "public",
        FieldAttributes.Family => "protected",
        FieldAttributes.FamORAssem => "protected internal",
        _ => null,
    };

    private static string Access(MethodAttributes access) => access switch
    {
        MethodAttributes.Public => "public",
        MethodAttributes.Family => "protected",
        MethodAttributes.FamORAssem => "protected internal",
        _ => null,
    };

    private static string MethodModifiers(MethodAttributes attributes)
    {
        var modifiers = new StringBuilder();
        if ((attributes & MethodAttributes.Static) != 0)
        {
            modifiers.Append(" static");
        }

        if ((attributes & MethodAttributes.Abstract) != 0)
        {
            modifiers.Append(" abstract");
        }
        else if ((attributes & MethodAttributes.Virtual) != 0)
        {
            modifiers.Append((attributes & MethodAttributes.Final) != 0 ? " sealed" : " virtual");
        }

        // A virtual without newslot reuses an inherited slot (an override);
        // with newslot it starts one. The difference changes dispatch for
        // derived types, so it is part of the contract.
        if ((attributes & MethodAttributes.Virtual) != 0 && (attributes & MethodAttributes.NewSlot) == 0)
        {
            modifiers.Append(" override");
        }

        return modifiers.ToString();
    }

    private static string ConstantValue(MetadataReader reader, ConstantHandle handle)
    {
        Constant constant = reader.GetConstant(handle);
        BlobReader blob = reader.GetBlobReader(constant.Value);
        return constant.TypeCode switch
        {
            ConstantTypeCode.Boolean => blob.ReadBoolean() ? "true" : "false",
            ConstantTypeCode.Char => ((int)blob.ReadChar()).ToString(System.Globalization.CultureInfo.InvariantCulture),
            ConstantTypeCode.SByte => blob.ReadSByte().ToString(System.Globalization.CultureInfo.InvariantCulture),
            ConstantTypeCode.Byte => blob.ReadByte().ToString(System.Globalization.CultureInfo.InvariantCulture),
            ConstantTypeCode.Int16 => blob.ReadInt16().ToString(System.Globalization.CultureInfo.InvariantCulture),
            ConstantTypeCode.UInt16 => blob.ReadUInt16().ToString(System.Globalization.CultureInfo.InvariantCulture),
            ConstantTypeCode.Int32 => blob.ReadInt32().ToString(System.Globalization.CultureInfo.InvariantCulture),
            ConstantTypeCode.UInt32 => blob.ReadUInt32().ToString(System.Globalization.CultureInfo.InvariantCulture),
            ConstantTypeCode.Int64 => blob.ReadInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
            ConstantTypeCode.UInt64 => blob.ReadUInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
            ConstantTypeCode.Single => blob.ReadSingle().ToString("R", System.Globalization.CultureInfo.InvariantCulture),
            ConstantTypeCode.Double => blob.ReadDouble().ToString("R", System.Globalization.CultureInfo.InvariantCulture),
            ConstantTypeCode.String => Quote(blob.ReadUTF16(blob.Length)),
            ConstantTypeCode.NullReference => "null",
            _ => constant.TypeCode.ToString(),
        };
    }

    /// <summary>
    /// Quotes a string constant on ONE line: backslash, quote and every control
    /// character are escaped, so a constant can never split or blur the
    /// snapshot's line format.
    /// </summary>
    private static string Quote(string value)
    {
        var quoted = new StringBuilder("\"");
        foreach (char character in value)
        {
            switch (character)
            {
                case '\\':
                    quoted.Append("\\\\");
                    break;
                case '"':
                    quoted.Append("\\\"");
                    break;
                case '\n':
                    quoted.Append("\\n");
                    break;
                case '\r':
                    quoted.Append("\\r");
                    break;
                case '\t':
                    quoted.Append("\\t");
                    break;
                default:
                    if (char.IsControl(character))
                    {
                        quoted.Append("\\u").Append(((int)character).ToString("x4", System.Globalization.CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        quoted.Append(character);
                    }

                    break;
            }
        }

        return quoted.Append('"').ToString();
    }

    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "test", "Core.Tests", "Baselines", SnapshotFileName)))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        throw new InvalidOperationException(
            "no ancestor of " + AppContext.BaseDirectory + " holds test/Core.Tests/Baselines/" + SnapshotFileName);
    }

    /// <summary>
    /// Renders metadata type signatures: types by namespace-qualified name
    /// (nested types with <c>+</c>), primitives by their CLR type name
    /// (<c>Int32</c>, <c>String</c>, <c>Void</c>), generic parameters by
    /// position (<c>!0</c>, <c>!!0</c>).
    /// </summary>
    private sealed class SignatureNames : ISignatureTypeProvider<string, object>
    {
        private readonly MetadataReader reader;

        public SignatureNames(MetadataReader reader)
        {
            this.reader = reader;
        }

        public static string FullName(MetadataReader reader, TypeDefinitionHandle handle)
        {
            TypeDefinition definition = reader.GetTypeDefinition(handle);
            string name = reader.GetString(definition.Name);
            TypeDefinitionHandle declaring = definition.GetDeclaringType();
            if (!declaring.IsNil)
            {
                return FullName(reader, declaring) + "+" + name;
            }

            string ns = reader.GetString(definition.Namespace);
            return ns.Length == 0 ? name : ns + "." + name;
        }

        public string Describe(EntityHandle handle) => handle.Kind switch
        {
            HandleKind.TypeDefinition => FullName(this.reader, (TypeDefinitionHandle)handle),
            HandleKind.TypeReference => this.GetTypeFromReference(this.reader, (TypeReferenceHandle)handle, 0),
            HandleKind.TypeSpecification => this.GetTypeFromSpecification(this.reader, null, (TypeSpecificationHandle)handle, 0),
            _ => handle.Kind.ToString(),
        };

        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();

        public string GetGenericTypeParameter(object genericContext, int index) => "!" + index;

        public string GetGenericMethodParameter(object genericContext, int index) => "!!" + index;

        public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind) =>
            FullName(reader, handle);

        public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
        {
            TypeReference reference = reader.GetTypeReference(handle);
            string name = reader.GetString(reference.Name);
            if (reference.ResolutionScope.Kind == HandleKind.TypeReference)
            {
                return this.GetTypeFromReference(reader, (TypeReferenceHandle)reference.ResolutionScope, rawTypeKind) + "+" + name;
            }

            string ns = reader.GetString(reference.Namespace);
            return ns.Length == 0 ? name : ns + "." + name;
        }

        public string GetTypeFromSpecification(MetadataReader reader, object genericContext, TypeSpecificationHandle handle, byte rawTypeKind) =>
            reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);

        public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments) =>
            genericType + "<" + string.Join(", ", typeArguments) + ">";

        public string GetArrayType(string elementType, ArrayShape shape) =>
            elementType + "[" + new string(',', shape.Rank - 1) + "]";

        public string GetByReferenceType(string elementType) => "ref " + elementType;

        public string GetPointerType(string elementType) => elementType + "*";

        public string GetSZArrayType(string elementType) => elementType + "[]";

        public string GetFunctionPointerType(MethodSignature<string> signature) =>
            "delegate*<" + string.Join(", ", signature.ParameterTypes.Append(signature.ReturnType)) + ">";

        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) =>
            isRequired ? unmodifiedType + " modreq(" + modifier + ")" : unmodifiedType;

        public string GetPinnedType(string elementType) => elementType;
    }
}

/// <summary>An enum with a non-default underlying type, pinned by the renderer test.</summary>
public enum SnapshotByteEnum : byte
{
    /// <summary>The only value.</summary>
    One = 1,
}

/// <summary>A tiny public type whose rendering the renderer test pins.</summary>
public class SnapshotFixture
{
    /// <summary>A public constant.</summary>
    public const int Answer = 42;

    /// <summary>A constant that needs escaping to stay on one line.</summary>
    public const string Quoted = "a\"b\\c\nd";

    private int hidden;

    /// <summary>Gets or sets a name with a protected setter.</summary>
    public string Name { get; protected set; }

    /// <summary>Gets an init-only value.</summary>
    public int Fixed { get; init; }

    /// <summary>Gets or sets a protected internal value.</summary>
    protected internal int Shared { get; set; }

    /// <summary>Adds two numbers.</summary>
    /// <param name="left">The left operand.</param>
    /// <param name="right">The right operand.</param>
    /// <returns>The sum.</returns>
    public static int Add(int left, int right) => left + right;

    /// <summary>Has an optional parameter whose default value is part of the API.</summary>
    /// <param name="count">How many.</param>
    /// <returns>The count.</returns>
    public static int Take(int count = 3) => count;

    /// <summary>Takes an <c>in</c> parameter.</summary>
    /// <param name="value">The value.</param>
    /// <returns>The value.</returns>
    public static int Peek(in int value) => value;

    /// <summary>A protected virtual hook.</summary>
    protected virtual void OnChanged()
    {
        this.hidden++;
        this.HiddenHelper();
    }

    /// <summary>Overrides an inherited slot.</summary>
    /// <returns>A fixed string.</returns>
    public override string ToString() => "fixture";

    private void HiddenHelper() => this.hidden--;

    /// <summary>A nested type visible only to derived types.</summary>
    protected internal sealed class Nested
    {
    }
}
