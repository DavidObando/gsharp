// <copyright file="GsStubRenderer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq
import System.Text
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import Cs2Gs.Translator
import Microsoft.CodeAnalysis.CSharp

/// ADR-0145 §B: renders a bound G# global scope into a single declaration-only
/// C# compilation unit ("stub"). The stub carries every user-declared type with
/// its accessibility, base clause, generics/constraints, member signatures, and
/// — critically — every symbol's attributes spelled by fully-qualified CLR
/// metadata name, which is exactly what a Roslyn incremental generator matches
/// on via `ForAttributeWithMetadataName`. All member bodies are elided
/// (`=> throw null!`).
///
/// The correctness bar is that the emitted text re-parses as valid C#; it is
/// never compiled to a runnable assembly.
class GsStubRenderer {
    private let speller GsToCSharpTypeSpeller
    private let notes List[string] = List[string]()
    private let partialDefinitions List[StubPartialDefinition] = List[StubPartialDefinition]()
    private let dataTypes List[StubDataType] = List[StubDataType]()

    // Issues #5252/#5253: the types the last render made `abstract` only
    // semantically, keyed by SemanticAbstractTypeKey, with whether the user
    // declared each `open`. Sorted, so the dictionary order is stable.
    private let semanticOnlyAbstractTypes SortedDictionary[string, bool] = SortedDictionary[string, bool](
        StringComparer.Ordinal
    )

    // The data types the last render projects as C# records: see PlanRecords.
    private var recordTypes HashSet[StructSymbol] = HashSet[StructSymbol]()

    // Identifier locations gsc reported GS0610 (wrong partial part count) at.
    // PartialMethodMerger's error recovery keeps one bodiless declaring part
    // when a group has several and no implementation; that survivor must not
    // be offered to generators as a lone definition to implement.
    private var partCountErrorLocations HashSet[TextLocation] = HashSet[TextLocation]()

    /// Initializes a new instance of the (cref:GsStubRenderer) class.
    convenience init() {
        init(GsToCSharpTypeSpeller())
    }

    /// Initializes a new instance of the (cref:GsStubRenderer) class with
    /// a shared type speller.
    /// @param speller The type speller whose fallbacks accumulate across the render.
    init(speller GsToCSharpTypeSpeller) {
        this.speller = speller ?? throw ArgumentNullException("speller")
    }

    /// How a G# method projects with respect to C# partial methods.
    private enum PartialShape {
        None,
        Definition,
        Pair
    }

    /// Which C# declaration of a method (cref:RenderMethod) writes.
    private enum PartialPart {
        None,
        Definition,
        Implementation
    }

    /// Gets the type-spelling fallbacks accumulated during the last render
    /// (ADR-0145 §H / `GS9204`).
    prop Fallbacks IReadOnlyList[string] -> speller.Fallbacks

    /// Gets the human-readable notes for arguments/members that could not be
    /// projected faithfully (e.g. an unrenderable attribute argument that was
    /// omitted).
    prop Notes IReadOnlyList[string] -> notes

    /// Gets the lone G# declaring parts the last render offered to generators
    /// as C# partial method definitions (ADR-0192 follow-on 2).
    prop PartialDefinitions IReadOnlyList[StubPartialDefinition] -> partialDefinitions

    /// Gets the top-level G# data types the last render projected, whose
    /// generated parts the back-translation spells as `data` parts
    /// (ADR-0192 amendment, partial data types).
    prop DataTypes IReadOnlyList[StubDataType] -> dataTypes

    /// Gets the top-level G# classes the last render made `abstract` in the stub only
    /// because they inherit unimplemented abstract members (the user never wrote
    /// `abstract`), keyed by (cref:SemanticAbstractTypeKey) and mapped to whether
    /// the user declared the class `open`. Generators see these types as abstract
    /// (ADR-0195), but the user's declared shape does not include it, so a
    /// generated part must not state `abstract` (issue #5252) and its members'
    /// `open` follows the declared openness (issue #5253).
    prop SemanticOnlyAbstractTypes IReadOnlyDictionary[string, bool] -> semanticOnlyAbstractTypes

    /// Renders the C# stub for every user-declared type in [`scope`](paramref).
    /// @param scope The bound global scope to project.
    /// @returns A single C# compilation-unit string, prefixed with `#nullable enable`.
    func RenderStub($scope BoundGlobalScope?) string {
        if $scope == nil {
            throw ArgumentNullException("scope")
        }
        this.partCountErrorLocations = $scope
            .Diagnostics
            .Where((diagnostic Diagnostic) -> diagnostic.Id == "GS0610")
            .Select((diagnostic Diagnostic) -> diagnostic.Location)
            .ToHashSet()
        this.partialDefinitions.Clear()
        this.dataTypes.Clear()
        this.semanticOnlyAbstractTypes.Clear()
        this.recordTypes = PlanRecords($scope.Structs)
        let builder = StringBuilder()
        builder.AppendLine("#nullable enable")
        // Group every top-level user type by its package (namespace). A type
        // nested inside another type is rendered by its enclosing type; skip it
        // at the namespace level (v1: top-level only).
        let byPackage = SortedDictionary[string, List[(StringBuilder, string) -> void]](StringComparer.Ordinal)
        let AddType = func (packageName string, emit(StringBuilder, string) -> void) {
            let key = packageName ?? string.Empty
            if !byPackage.TryGetValue(key, out var list) {
                list = List[(StringBuilder, string) -> void]()
                byPackage[key] = list
            }
            list.Add(emit)
        }
        for structSymbol in $scope.Structs {
            if SkipType(structSymbol.Name) || structSymbol.ContainingType != nil {
                continue
            }
            if structSymbol.IsData {
                // The user's positional list, if any, which a generated part
                // must not also carry (GS9209): the merged declaration takes it
                // from the one part that states it (ADR-0144, GS0482).
                let declaration StructDeclarationSyntax? = structSymbol.Declaration
                let positionalList = declaration?.PrimaryConstructorOpenParenthesisToken?.Location
                dataTypes.Add(
                    StubDataType(
                        structSymbol.PackageName,
                        structSymbol.Name,
                        structSymbol.TypeParameters.Length,
                        structSymbol.IsClass,
                        positionalList
                    )
                )
            }
            AddType(
                structSymbol.PackageName,
                (sb StringBuilder, indent string) -> RenderStruct(sb, indent, structSymbol)
            )
        }
        for iface in $scope.Interfaces {
            if SkipType(iface.Name) || iface.ContainingType != nil {
                continue
            }
            AddType(iface.PackageName, (sb StringBuilder, indent string) -> RenderInterface(sb, indent, iface))
        }
        for enumSymbol in $scope.Enums {
            if SkipType(enumSymbol.Name) || enumSymbol.ContainingType != nil {
                continue
            }
            AddType(enumSymbol.PackageName, (sb StringBuilder, indent string) -> RenderEnum(sb, indent, enumSymbol))
        }
        for del in $scope.Delegates {
            if SkipType(del.Name) {
                continue
            }
            AddType(del.PackageName, (sb StringBuilder, indent string) -> RenderDelegate(sb, indent, del))
        }
        for pair in byPackage {
            let packageName = pair.Key
            let hasNamespace = !string.IsNullOrEmpty(packageName)
            let indent = if hasNamespace {
                "    "
            } else {
                string.Empty
            }
            if hasNamespace {
                builder.Append("namespace ").AppendLine(packageName)
                builder.AppendLine("{")
            }
            var first = true
            for emit in pair.Value {
                if !first {
                    builder.AppendLine()
                }
                first = false
                emit(builder, indent)
            }
            if hasNamespace {
                builder.AppendLine("}")
            }
        }
        return builder.ToString()
    }

    private func RenderStruct(sb StringBuilder, indent string, structSymbol StructSymbol) {
        RenderAttributes(sb, indent, structSymbol.Attributes)
        sb.Append(indent).Append(AccessibilityKeyword(structSymbol.Accessibility)).Append(' ')
        // ADR-0195: a G# `shared class` is a C# static class, so a generator (and the
        // back-translation of what it emits) sees the real shape: every part of the
        // type, including the generated one, is then translated as a `shared` part.
        if structSymbol.IsSharedClass {
            sb.Append("static ")
        }
        // Use the emitter's semantic status, including unimplemented inherited
        // members. Shared classes already use C#'s static modifier above.
        if structSymbol.IsAbstract && !structSymbol.IsSharedClass {
            sb.Append("abstract ")
            // Issues #5252/#5253: abstract only by inheritance, not by the user's
            // declaration; recorded so the back-translation can keep it out of the
            // generated parts. The stub is rendered top-level only (nested types are
            // not projected), so the key is the package and the type's own name.
            if !structSymbol.IsDeclaredAbstract {
                let metadataName = if structSymbol.TypeParameters.Length > 0 {
                    structSymbol.Name + "`" + structSymbol.TypeParameters.Length.ToString(CultureInfo.InvariantCulture)
                } else {
                    structSymbol.Name
                }
                semanticOnlyAbstractTypes[
                    SemanticAbstractTypeKey.Format(structSymbol.PackageName, []string{metadataName})
                ] =
                structSymbol.IsOpen
            }
        }
        if structSymbol.Declaration?.IsPartial ?? false {
            sb.Append("partial ")
        }
        // A G# `data class` / `data struct` is the spelling of a C# `record` /
        // `record struct` (ADR-0192 amendment, partial data types), so a
        // generator that checks `IsRecord` sees the real shape; C# supplies
        // the record's synthesized members itself. The positional parameter
        // list is NOT rendered: the properties and constructors below already
        // carry the type's shape, and with a positional list C# rejects an
        // explicit constructor that does not chain to it (CS8862) and a
        // property whose type differs from its parameter's (CS8866, a variadic
        // `...T` parameter is `T[]` but its property a slice). Fidelity only:
        // the back-translation spells a generated part of a data type as a
        // `data` part from DataTypes, whatever keyword the generator
        // re-declared it with.
        if recordTypes.Contains(structSymbol) {
            sb.Append(
                if structSymbol.IsClass {
                    "record "
                } else {
                    "record struct "
                }
            )
        } else {
            sb.Append(
                if structSymbol.IsClass {
                    "class "
                } else {
                    "struct "
                }
            )
        }
        sb.Append(structSymbol.Name)
        sb.Append(RenderTypeParameters(structSymbol.TypeParameters))
        let bases = CollectBaseTypes(structSymbol)
        if bases.Count > 0 {
            sb.Append(" : ").Append(string.Join(", ", bases))
        }
        sb.Append(RenderConstraints(structSymbol.TypeParameters))
        sb.AppendLine()
        sb.Append(indent).AppendLine("{")
        let memberIndent = indent + "    "
        RenderConstFields(sb, memberIndent, structSymbol.ConstFields)
        RenderFields(sb, memberIndent, structSymbol.Fields, isStatic: false)
        RenderFields(sb, memberIndent, structSymbol.StaticFields, isStatic: true)
        RenderProperties(sb, memberIndent, structSymbol.Properties, isStatic: false)
        RenderProperties(sb, memberIndent, structSymbol.StaticProperties, isStatic: true)
        RenderEvents(sb, memberIndent, structSymbol.Events, isStatic: false)
        RenderEvents(sb, memberIndent, structSymbol.StaticEvents, isStatic: true)
        RenderConstructors(sb, memberIndent, structSymbol)
        let isPartialType = structSymbol.Declaration?.IsPartial ?? false
        RenderMethods(sb, memberIndent, structSymbol.Methods, isStatic: false, isPartialType)
        RenderMethods(sb, memberIndent, structSymbol.StaticMethods, isStatic: true, isPartialType)
        RecordPartialDefinitions(structSymbol, structSymbol.Methods, isPartialType)
        RecordPartialDefinitions(structSymbol, structSymbol.StaticMethods, isPartialType)
        sb.Append(indent).AppendLine("}")
    }

    /// ADR-0192 follow-on 2, step 4: records each lone G# declaring part the
    /// stub offered to generators as a C# partial method definition, so the
    /// back-translation can spell a generated implementing part with the
    /// user's own header ((cref:ImplementingPartHeaders)).
    private func RecordPartialDefinitions(
        owner StructSymbol,
        methods ImmutableArray[FunctionSymbol],
        isPartialType bool
    ) {
        if methods.IsDefaultOrEmpty {
            return
        }
        for method in methods {
            if !SkipType(method.Name) &&
                method.Declaration is {} declaration &&
                ClassifyPartialShape(method, isPartialType) == PartialShape
                .Definition {
                partialDefinitions.Add(
                    StubPartialDefinition(owner.PackageName, owner.Name, owner.TypeParameters.Length, declaration)
                )
            }
        }
    }

    private func CollectBaseTypes(structSymbol StructSymbol) List[string] {
        let bases = List[string]()
        if structSymbol.IsClass {
            if structSymbol.BaseClass != nil {
                bases.Add(speller.Spell(structSymbol.BaseClass))
            } else if structSymbol.ImportedBaseType != nil {
                bases.Add(speller.Spell(structSymbol.ImportedBaseType))
            }
        }
        if !structSymbol.Interfaces.IsDefaultOrEmpty {
            bases.AddRange(structSymbol.Interfaces.Select((i InterfaceSymbol) -> speller.Spell(i)))
        }
        if !structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty {
            // ADR-0199: every data type implements IEquatable[Self] implicitly,
            // so the stub does not restate it (a generated part would otherwise
            // name an interface its user part never declared).
            bases.AddRange(
                structSymbol
                    .ImplementedClrInterfaces
                    .Where(
                    (i TypeSymbol) -> !(
                        structSymbol.IsData && DataEqualityMemberModel.ListsSelfEquatable(structSymbol, []TypeSymbol{i})
                    )
                )
                    .Select((i TypeSymbol) -> speller.Spell(i))
            )
        }
        return bases
    }

    private func RenderInterface(sb StringBuilder, indent string, iface InterfaceSymbol) {
        RenderAttributes(sb, indent, iface.Attributes)
        sb.Append(indent).Append(AccessibilityKeyword(iface.Accessibility)).Append(' ')
        if iface.Declaration?.IsPartial ?? false {
            sb.Append("partial ")
        }
        sb.Append("interface ").Append(iface.Name)
        sb.Append(RenderTypeParameters(iface.TypeParameters))
        let bases = List[string]()
        if !iface.BaseInterfaces.IsDefaultOrEmpty {
            bases.AddRange(iface.BaseInterfaces.Select((i InterfaceSymbol) -> speller.Spell(i)))
        }
        if !iface.BaseClrInterfaces.IsDefaultOrEmpty {
            bases.AddRange(iface.BaseClrInterfaces.Select((i TypeSymbol) -> speller.Spell(i)))
        }
        if bases.Count > 0 {
            sb.Append(" : ").Append(string.Join(", ", bases))
        }
        sb.Append(RenderConstraints(iface.TypeParameters))
        sb.AppendLine()
        sb.Append(indent).AppendLine("{")
        let memberIndent = indent + "    "
        RenderProperties(sb, memberIndent, iface.Properties, isStatic: false)
        RenderEvents(sb, memberIndent, iface.Events, isStatic: false)
        RenderMethods(sb, memberIndent, iface.Methods, isStatic: false, isPartialType: false)
        RenderMethods(sb, memberIndent, iface.StaticMethods, isStatic: true, isPartialType: false)
        sb.Append(indent).AppendLine("}")
    }

    private func RenderEnum(sb StringBuilder, indent string, enumSymbol EnumSymbol) {
        RenderAttributes(sb, indent, enumSymbol.Attributes)
        sb
            .Append(indent)
            .Append(AccessibilityKeyword(enumSymbol.Accessibility))
            .Append(" enum ")
            .Append(enumSymbol.Name)
        sb.AppendLine()
        sb.Append(indent).AppendLine("{")
        let memberIndent = indent + "    "
        for member in enumSymbol.Members {
            RenderAttributes(sb, memberIndent, member.Attributes)
            sb
                .Append(memberIndent)
                .Append(member.Name)
                .Append(" = ")
                .Append(member.Value.ToString(CultureInfo.InvariantCulture))
                .AppendLine(",")
        }
        sb.Append(indent).AppendLine("}")
    }

    private func RenderDelegate(sb StringBuilder, indent string, del DelegateTypeSymbol) {
        RenderAttributes(sb, indent, del.Attributes)
        sb.Append(indent).Append(AccessibilityKeyword(del.Accessibility)).Append(" delegate ")
        sb.Append(
            if del.ReturnType == nil || del.ReturnType == TypeSymbol.Void {
                "void"
            } else {
                speller.Spell(del.ReturnType)
            }
        )
        sb.Append(' ').Append(del.Name)
        sb.Append(RenderTypeParameters(del.TypeParameters))
        sb.Append('(').Append(RenderParameters(del.Parameters)).Append(')')
        sb.Append(RenderConstraints(del.TypeParameters))
        sb.AppendLine(";")
    }

    private func RenderConstFields(sb StringBuilder, indent string, fields ImmutableArray[FieldSymbol]) {
        if fields.IsDefaultOrEmpty {
            return
        }
        for field in fields {
            RenderAttributes(sb, indent, field.Attributes)
            sb.Append(indent).Append(AccessibilityKeyword(field.Accessibility)).Append(" const ")
            sb.Append(speller.Spell(field.Type)).Append(' ').Append(field.Name).Append(" = ")
            sb.Append(RenderConstant(field.ConstantValue, field.Type) ?? "default").AppendLine(";")
        }
    }

    private func RenderFields(sb StringBuilder, indent string, fields ImmutableArray[FieldSymbol], isStatic bool) {
        if fields.IsDefaultOrEmpty {
            return
        }
        for field in fields {
            if field.IsConst {
                continue
            }
            RenderAttributes(sb, indent, field.Attributes)
            sb.Append(indent).Append(AccessibilityKeyword(field.Accessibility)).Append(' ')
            if isStatic || field.IsStatic {
                sb.Append("static ")
            }
            if field.IsReadOnly {
                sb.Append("readonly ")
            }
            sb.Append(speller.Spell(field.Type)).Append(' ').Append(field.Name).AppendLine(";")
        }
    }

    private func RenderProperties(
        sb StringBuilder,
        indent string,
        properties ImmutableArray[PropertySymbol],
        isStatic bool
    ) {
        if properties.IsDefaultOrEmpty {
            return
        }
        for property in properties {
            RenderAttributes(sb, indent, property.Attributes)
            sb.Append(indent).Append(AccessibilityKeyword(property.Accessibility)).Append(' ')
            if isStatic || property.IsStatic {
                sb.Append("static ")
            }
            sb.Append(speller.Spell(property.Type)).Append(' ').Append(property.Name).Append(" { ")
            if property.HasGetter {
                sb.Append("get => throw null!; ")
            }
            if property.HasSetter {
                sb.Append(
                    if property.IsInitOnly {
                        "init { } "
                    } else {
                        "set { } "
                    }
                )
            }
            sb.AppendLine("}")
        }
    }

    private func RenderEvents(sb StringBuilder, indent string, events ImmutableArray[EventSymbol], isStatic bool) {
        if events.IsDefaultOrEmpty {
            return
        }
        for evt in events {
            RenderAttributes(sb, indent, evt.Attributes)
            sb.Append(indent).Append(AccessibilityKeyword(evt.Accessibility)).Append(' ')
            if isStatic || evt.IsStatic {
                sb.Append("static ")
            }
            sb.Append("event ").Append(speller.Spell(evt.Type)).Append(' ').Append(evt.Name).AppendLine(";")
        }
    }

    private func RenderConstructors(sb StringBuilder, indent string, structSymbol StructSymbol) {
        if structSymbol.IsSharedClass {
            // The emitter's private placeholder is not a C# static-class member.
            return
        }
        if structSymbol.ExplicitConstructors.IsDefaultOrEmpty {
            if structSymbol.IsClass {
                // Match ReflectionMetadataEmitter.EmitClassMethodBodies: a
                // forwarding primary constructor suppresses the default one.
                if !structSymbol.HasPrimaryConstructor || structSymbol.BaseConstructorInitializer == nil {
                    let emptyPrimary = !structSymbol.HasPrimaryConstructor &&
                        (structSymbol.Declaration?.HasPrimaryConstructor ?? false)
                    let accessibility = if structSymbol.IsDeclaredAbstract && !emptyPrimary {
                        Accessibility.Protected
                    } else {
                        (
                            if structSymbol.HasPrimaryConstructor && !structSymbol.IsData {
                                Accessibility.Internal
                            } else {
                                Accessibility.Public
                            }
                        )
                    }
                    RenderConstructor(
                        sb,
                        indent,
                        structSymbol,
                        accessibility,
                        ImmutableArray[ParameterSymbol].Empty,
                        structSymbol.BaseConstructorInitializer
                    )
                }
                if structSymbol.HasPrimaryConstructor {
                    RenderConstructor(
                        sb,
                        indent,
                        structSymbol,
                        Accessibility.Public,
                        structSymbol.PrimaryConstructorParameters,
                        structSymbol.BaseConstructorInitializer
                    )
                }
            }
            return
        }
        for ctor in structSymbol.ExplicitConstructors {
            let function FunctionSymbol? = ctor.Function
            RenderAttributes(
                sb,
                indent,
                function?.Attributes ?? ImmutableArray[GSharp.Core.CodeAnalysis.Binding.BoundAttribute].Empty
            )
            let accessibility = function?.Accessibility ?? Accessibility.Public
            let baseInitializer BaseConstructorInitializer? = if ctor.IsSynthesizedFromPrimaryConstructor {
                structSymbol.BaseConstructorInitializer
            } else {
                ctor.BaseInitializer
            }
            RenderConstructor(sb, indent, structSymbol, accessibility, ctor.Parameters, baseInitializer)
        }
    }

    private func RenderConstructor(
        sb StringBuilder,
        indent string,
        structSymbol StructSymbol,
        accessibility Accessibility,
        parameters ImmutableArray[ParameterSymbol],
        baseInitializer BaseConstructorInitializer?
    ) {
        sb.Append(indent).Append(AccessibilityKeyword(accessibility)).Append(' ')
        sb.Append(structSymbol.Name).Append('(').Append(RenderParameters(parameters)).Append(')')
        if baseInitializer != nil &&
            !baseInitializer
            .Arguments
            .IsDefaultOrEmpty &&
            baseInitializer
            .ArgumentRefKinds
            .All((refKind RefKind) -> refKind == RefKind.None) {
            // Only signatures are projected; typed defaults select the bound
            // base overload without evaluating the source's initializer. Keep
            // the existing elision for by-reference arguments, not rvalue defaults.
            sb
                .Append(" : base(")
                .Append(
                string.Join(
                    ", ",
                    baseInitializer.Arguments.Select(
                        (argument GSharp.Core.CodeAnalysis.Binding.BoundExpression) -> "default(" + speller.Spell(
                            argument.Type
                        ) +
                            ")"
                    )
                )
            )
                .Append(')')
        }
        // A value struct cannot carry a body-less expression ctor; give it an
        // empty block. Classes get the elided throwing body.
        sb.AppendLine(
            if structSymbol.IsClass {
                " => throw null!;"
            } else {
                " { }"
            }
        )
    }

    private func RenderMethods(
        sb StringBuilder,
        indent string,
        methods ImmutableArray[FunctionSymbol],
        isStatic bool,
        isPartialType bool
    ) {
        if methods.IsDefaultOrEmpty {
            return
        }
        for method in methods {
            if SkipType(method.Name) {
                continue
            }
            switch ClassifyPartialShape(method, isPartialType) {
                case PartialShape.Definition {
                    RenderMethod(sb, indent, method, isStatic, PartialPart.Definition, method.Attributes)
                }
                case PartialShape.Pair {
                    // gsc merged the two parts into one symbol whose attributes
                    // are the union of both parts. C# unions a partial method's
                    // attributes the same way, so stating them once, on the
                    // definition, is exact and avoids a duplicate-attribute error.
                    RenderMethod(sb, indent, method, isStatic, PartialPart.Definition, method.Attributes)
                    RenderMethod(
                        sb,
                        indent,
                        method,
                        isStatic,
                        PartialPart.Implementation,
                        ImmutableArray[GSharp.Core.CodeAnalysis.Binding.BoundAttribute].Empty
                    )
                }
                default {
                    RenderMethod(sb, indent, method, isStatic, PartialPart.None, method.Attributes)
                }
            }
        }
    }

    /// ADR-0192: classifies how a G# `partial func` projects into the stub.
    /// gsc keeps a lone declaring part after GS0609 precisely so a generator can
    /// see it and supply the implementation, and C# generators (the Regex
    /// generator first among them) only fill in a method declared
    /// `partial` with no body — any other shape is SYSLIB1043 — so that
    /// part renders as a C# partial method definition. A pair gsc has already
    /// merged renders as a C# definition plus implementation. Every other shape
    /// keeps the ordinary-method rendering: a lone implementing part, or the
    /// declaring part gsc kept to recover from several declaring parts (both GS0610),
    /// a partial method in a non-partial type (GS0608), or a receiver-clause or
    /// explicit-interface partial (GS0607). C# would reject a partial member in
    /// each of those, and gsc has already reported the real error.
    private func ClassifyPartialShape(method FunctionSymbol, isPartialType bool) PartialShape {
        let declaration FunctionDeclarationSyntax? = method.Declaration
        if !isPartialType ||
            !(declaration != nil && declaration.IsPartial == true) ||
            declaration.Receiver != nil ||
            declaration.ExplicitInterfaceType != nil {
            return PartialShape.None
        }
        if declaration.DeclaringPart != nil {
            return PartialShape.Pair
        }
        return if declaration.Body == nil && !this.partCountErrorLocations.Contains(declaration.Identifier.Location) {
            PartialShape.Definition
        } else {
            PartialShape.None
        }
    }

    private func RenderMethod(
        sb StringBuilder,
        indent string,
        method FunctionSymbol,
        isStatic bool,
        part PartialPart,
        attributes ImmutableArray[GSharp.Core.CodeAnalysis.Binding.BoundAttribute]
    ) {
        RenderAttributes(sb, indent, attributes)
        sb.Append(indent).Append(AccessibilityKeyword(method.Accessibility)).Append(' ')
        if isStatic || method.IsStatic {
            sb.Append("static ")
        }
        // C# requires `partial` immediately before the return type.
        if part != PartialPart.None {
            sb.Append("partial ")
        }
        let isVoid = method.Type == nil || method.Type == TypeSymbol.Void
        sb.Append(RenderMethodReturnType(method, isVoid)).Append(' ').Append(method.Name)
        sb.Append(RenderTypeParameters(method.TypeParameters))
        // A default value belongs on the definition; C# ignores one restated
        // on the implementation and warns about it (CS1066).
        let includeDefaults = part != PartialPart.Implementation
        sb.Append('(').Append(RenderParameters(method.Parameters, includeDefaults)).Append(')')
        sb.Append(RenderConstraints(method.TypeParameters))
        if part == PartialPart.Definition {
            sb.AppendLine(";")
            return
        }
        sb.AppendLine(
            if isVoid && !method.IsAsync {
                " { }"
            } else {
                " => throw null!;"
            }
        )
    }

    private func RenderMethodReturnType(method FunctionSymbol, isVoid bool) string {
        if !method.IsAsync {
            return if isVoid {
                "void"
            } else {
                speller.Spell(method.Type)
            }
        }
        let wrapper = if method.AsyncReturnsValueTask {
            "global::System.Threading.Tasks.ValueTask"
        } else {
            "global::System.Threading.Tasks.Task"
        }
        return if isVoid {
            wrapper
        } else {
            wrapper + "<" + speller.Spell(method.Type) + ">"
        }
    }

    private func RenderParameters(parameters ImmutableArray[ParameterSymbol], includeDefaults bool = true) string {
        if parameters.IsDefaultOrEmpty {
            return string.Empty
        }
        let parts = List[string](parameters.Length)
        for parameter in parameters {
            let builder = StringBuilder()
            switch parameter.RefKind {
                case RefKind.Ref {
                    builder.Append("ref ")
                }
                case RefKind.Out {
                    builder.Append("out ")
                }
                case RefKind.In {
                    builder.Append("in ")
                }
                default {
                    let _ = 0
                }
            }
            if parameter.IsVariadic && parameter.Type is SliceTypeSymbol slice {
                // `params T[]` — a params parameter must be an array, not the
                // Span shape a bare slice would otherwise spell to.
                builder.Append("params ").Append(speller.Spell(slice.ElementType)).Append("[] ")
            } else {
                builder.Append(speller.Spell(parameter.Type)).Append(' ')
            }
            builder.Append(parameter.Name)
            if includeDefaults &&
                parameter.HasExplicitDefaultValue &&
                parameter.RefKind == RefKind.None &&
                !parameter
                .IsVariadic {
                let rendered string? = RenderConstant(parameter.ExplicitDefaultValue, parameter.Type)
                builder.Append(" = ").Append(rendered ?? "default")
            }
            parts.Add(builder.ToString())
        }
        return string.Join(", ", parts)
    }

    private func RenderTypeParameters(typeParameters ImmutableArray[TypeParameterSymbol]) string {
        if typeParameters.IsDefaultOrEmpty {
            return string.Empty
        }
        return "<" + string.Join(", ", typeParameters.Select((tp TypeParameterSymbol) -> tp.Name)) + ">"
    }

    private func RenderConstraints(typeParameters ImmutableArray[TypeParameterSymbol]) string {
        if typeParameters.IsDefaultOrEmpty {
            return string.Empty
        }
        let builder = StringBuilder()
        for tp in typeParameters {
            let constraints = List[string]()
            let isValueLike = tp.HasValueTypeConstraint || tp.HasUnmanagedConstraint
            if tp.HasUnmanagedConstraint {
                constraints.Add("unmanaged")
            } else if tp.HasValueTypeConstraint {
                constraints.Add("struct")
            } else if tp.HasReferenceTypeConstraint {
                constraints.Add("class")
            }
            if tp.ConstraintReferenceType != nil {
                constraints.Add(speller.Spell(tp.ConstraintReferenceType))
            }
            if tp.HasDefaultConstructorConstraint && !isValueLike {
                constraints.Add("new()")
            }
            if constraints.Count > 0 {
                builder.Append(" where ").Append(tp.Name).Append(" : ").Append(string.Join(", ", constraints))
            }
        }
        return builder.ToString()
    }

    private func RenderAttributes(
        sb StringBuilder,
        indent string,
        attributes ImmutableArray[GSharp.Core.CodeAnalysis.Binding.BoundAttribute]
    ) {
        if attributes.IsDefaultOrEmpty {
            return
        }
        for attribute in attributes {
            let name = speller.Spell(attribute.AttributeType)
            // Trim the conventional `Attribute` suffix so the spelled name is
            // the metadata name a generator matches; C# accepts either form.
            let args = List[string]()
            for positional in attribute.PositionalArguments {
                let rendered string? = RenderConstant(positional.Value, positional.Type)
                if rendered == nil {
                    notes.Add("omitted positional argument on [$name]")
                    continue
                }
                if positional.Name is {} {
                    let parameterName string? = attribute.GetConstructorParameterMetadataName(positional) ??
                        positional.Name
                    args.Add("${EscapeCSharpIdentifier(parameterName)}: $rendered")
                } else {
                    args.Add(rendered)
                }
            }
            for named in attribute.NamedArguments {
                let rendered string? = RenderConstant(named.Value, named.Type)
                if rendered == nil {
                    notes.Add("omitted named argument '${named.Name}' on [$name]")
                    continue
                }
                args.Add("${named.Name} = $rendered")
            }
            sb.Append(indent).Append('[').Append(name)
            if args.Count > 0 {
                sb.Append('(').Append(string.Join(", ", args)).Append(')')
            }
            sb.AppendLine("]")
        }
    }

    /// Renders a bound compile-time constant attribute/parameter value to a
    /// parseable C# expression, or `null` when it has no
    /// faithful spelling (the caller then omits it).
    private func RenderConstant(value object?, type TypeSymbol?) string? {
        // Issue #4144: an enum (or enum-array) element of an `object[]`
        // argument keeps its enum type by arriving wrapped in its own bound
        // argument; render it with that type.
        if value is BoundAttributeArgument wrapped {
            return RenderConstant(wrapped.Value, wrapped.Type)
        }
        if value != nil && EnumTypeOf(type) is {} enumType {
            return RenderEnumConstant(value, speller.Spell(enumType))
        }
        if value is Array array {
            return RenderArray(array, type)
        }
        switch value {
            case nil {
                return "null"
            }
            case boxedEnum is Enum {
                // A real enum instance whose static type is not an enum (an
                // element of an enum-typed CLR array read without its type).
                return RenderEnumConstant(boxedEnum, SpellClrType(boxedEnum.GetType()))
            }
            case s is string {
                return "\"" + EscapeString(s) + "\""
            }
            case b is bool {
                return if b {
                    "true"
                } else {
                    "false"
                }
            }
            case c is char {
                return "'" + EscapeChar(c) + "'"
            }
            case ts is TypeSymbol {
                return "typeof(${speller.Spell(ts)})"
            }
            case clrType is Type {
                return "typeof(${SpellClrType(clrType)})"
            }
            case f is float32 {
                return f.ToString("R", CultureInfo.InvariantCulture) + "f"
            }
            case d is float64 {
                return d.ToString("R", CultureInfo.InvariantCulture) + "d"
            }
            case m is decimal {
                return m.ToString(CultureInfo.InvariantCulture) + "m"
            }
            case l is int64 {
                return l.ToString(CultureInfo.InvariantCulture) + "L"
            }
            case ul is uint64 {
                return ul.ToString(CultureInfo.InvariantCulture) + "UL"
            }
            case ui is uint32 {
                return ui.ToString(CultureInfo.InvariantCulture) + "u"
            }
            case _ is int8 or _ is uint8 or _ is int16 or _ is uint16 or _ is int32 {
                return Convert.ToString(value, CultureInfo.InvariantCulture)
            }
        }
        return nil
    }

    /// Renders an enum constant as a cast of its underlying integral value to
    /// [`enumSpelling`](paramref). gsc binds an enum argument to its
    /// underlying primitive, and C# converts only the constant `0`
    /// implicitly to an enum, so a bare number binds the wrong overload or
    /// none (`[GeneratedRegex("…", 513)]` is SYSLIB1040 for the Regex
    /// generator) and loses the enum type through an `object` parameter.
    /// A cast needs no member-name lookup and is exact for any value, including
    /// flag combinations and values no member names.
    private func RenderEnumConstant(value object, enumSpelling string) string? {
        let underlying = if value is Enum boxedEnum {
            Convert.ChangeType(boxedEnum, Enum.GetUnderlyingType(boxedEnum.GetType()), CultureInfo.InvariantCulture)
        } else {
            value
        }
        if !(
            (
                underlying is int8 ||
                    underlying is uint8 ||
                    underlying is int16 ||
                    underlying is uint16 ||
                    underlying is int32 ||
                    underlying is uint32 ||
                    underlying is int64 ||
                    underlying is uint64
            )
        ) {
            return nil
        }
        var literal string? = RenderConstant(underlying, type: nil)
        // `(E)-1` parses as the subtraction `E - 1`; parenthesize the operand.
        if literal!!.StartsWith('-') {
            literal = "(" + literal + ")"
        }
        return "(" + enumSpelling + ")" + literal
    }

    /// Renders a one-dimensional array constant as a typed array creation.
    /// Every element must be renderable, or the whole argument is omitted.
    private func RenderArray(array Array, type TypeSymbol?) string? {
        let arrayType TypeSymbol? = if type is NullableTypeSymbol nullable {
            nullable.UnderlyingType
        } else {
            type
        }
        let elementType TypeSymbol? = switch arrayType {
            case arraySymbol is ArrayTypeSymbol: arraySymbol.ElementType
            case slice is SliceTypeSymbol: slice.ElementType
            default: default(TypeSymbol?)
        }
        let elementSpelling = if elementType != nil {
            speller.Spell(elementType)
        } else {
            SpellClrType(array.GetType().GetElementType() ?? typeof(object))
        }
        let elements = List[string](array.Length)
        for element in array {
            let rendered string? = RenderConstant(element, elementType)
            if rendered == nil {
                return nil
            }
            elements.Add(rendered)
        }
        return if elements.Count == 0 {
            "new $elementSpelling[0]"
        } else {
            "new $elementSpelling[] { ${string.Join(", ", elements)} }"
        }
    }

    shared {
        private func SkipType(name string) bool -> string.IsNullOrEmpty(name) || name.IndexOf('<') >= 0 || name.IndexOf(
            '$'
        ) >= 0

        private func AccessibilityKeyword(accessibility Accessibility) string -> switch accessibility {
            case Accessibility.Public: "public"
            case Accessibility.Internal: "internal"
            case Accessibility.Private: "private"
            case Accessibility.Protected: "protected"
            default: "internal"
        }

        /// Decides which data types render as C# records, across the inheritance
        /// graph rather than per type. A C# record derives only from `object`
        /// or another record (CS8864), and only a record derives from a record
        /// (CS8865), while a G# data class may derive from any open class and any
        /// open class may derive from a data class. So a data type renders as a
        /// record only when its base class is a record-rendered data type (or it
        /// has none) and every source class deriving from it renders as a record
        /// too. Otherwise the whole connected chain stays classes, which is how
        /// every data type rendered before (a generator just sees no
        /// `IsRecord`). A base class declared elsewhere (a referenced
        /// assembly) is never a record here, so its data descendants stay classes.
        private func PlanRecords(structs ImmutableArray[StructSymbol]) HashSet[StructSymbol] {
            let records = HashSet[StructSymbol](
                structs.Where(
                    (type StructSymbol) -> type.IsData &&
                        type.ImportedBaseType == nil &&
                        (type.BaseClass == nil || DefinitionOf(type.BaseClass)!!.IsData)
                )
            )
            var changed = true
            while changed {
                changed = false
                for type in structs {
                    if type.BaseClass == nil {
                        continue
                    }
                    let baseType StructSymbol? = DefinitionOf(type.BaseClass)
                    // A record deriving from a class, or a class deriving from a
                    // record: both sides of the edge become classes.
                    if records.Contains(type) != records.Contains(baseType!!) {
                        changed |= records.Remove(type)
                        changed |= records.Remove(baseType!!)
                    }
                }
            }
            return records
        }

        private func DefinitionOf(type StructSymbol?) StructSymbol? -> type!!.Definition ?? type

        private func EscapeCSharpIdentifier(name string?) string? -> if (
            Microsoft
                .CodeAnalysis
                .CSharp
                .SyntaxFacts
                .GetKeywordKind(name!!) != Microsoft
                .CodeAnalysis
                .CSharp
                .SyntaxKind
                .None ||
                Microsoft
                .CodeAnalysis
                .CSharp
                .SyntaxFacts
                .GetContextualKeywordKind(name!!) != Microsoft
                .CodeAnalysis
                .CSharp
                .SyntaxKind
                .None
        ) {
            "@$name"
        } else {
            name
        }

        /// Returns the enum type a constant of static type [`type`](paramref)
        /// must be cast to — the type itself, or the underlying type of a nullable
        /// enum — or `null` when it is not an enum.
        private func EnumTypeOf(type TypeSymbol?) TypeSymbol? {
            let candidate TypeSymbol? = if type is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                type
            }
            return if candidate is EnumSymbol || candidate?.ClrType.IsEnumSafe() == true {
                candidate
            } else {
                default(TypeSymbol?)
            }
        }

        private func SpellClrType(clrType Type) string -> "global::" +
            (clrType.FullName?.Replace('+', '.') ?? clrType.Name)

        private func EscapeString(value string) string {
            let builder = StringBuilder(value.Length)
            for c in value {
                builder.Append(EscapeChar(c))
            }
            return builder.ToString()
        }

        private func EscapeChar(c char) string -> switch c {
            case '\\': "\\\\"
            case '"': "\\\""
            case '\'': "\\'"
            case '\u0000': "\\0"
            case '\u0007': "\\a"
            case '\u0008': "\\b"
            case '\u000C': "\\f"
            case '\n': "\\n"
            case '\r': "\\r"
            case '\t': "\\t"
            case '\u000B': "\\v"
            case _ when char.IsControl(c) || (c == ' ' || c == ' '): "\\u" + (int32(c)).ToString(
                "x4",
                CultureInfo.InvariantCulture
            )
            default: c.ToString()
        }
    }
}
