// <copyright file="MetadataMemberComparison.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

/// Compares the members of every type definition with the context (ADR-0209 section 7, Q6 to Q10).
/// @remarks Each member has an identity (kind, table, row), its own row data that always compares, and a signature part.
/// A member whose signature names a type that the context cannot load is written `signature-missing` on both sides.
/// The grain is the member, not the type (table 7b). One function spells each part for both sides.
internal shared class MetadataMemberComparison {
    private let AllDeclared BindingFlags = BindingFlags.DeclaredOnly |
    BindingFlags.Instance |
    BindingFlags.Static |
    BindingFlags.Public |
    BindingFlags.NonPublic

    /// Compares the members of each type of each searched module.
    internal func Compare(resolver ReferenceResolver, set ReferenceImageSet, result List[ModelDisagreement]) {
        for var m = 0; m < set.SearchedCount; m++ {
            let module = set.Modules[m]
            for fullName in module.DefinedNames {
                module.TryGetDefinition(fullName, out var handle)
                let symbol = module.GetTypeSymbol(handle)
                let type = resolver.FindTypeForComparison(module.Identity.Name, fullName)
                if type == nil {
                    continue
                }
                Add(result, module, fullName, TypeMembers(type, module), SymbolMembers(symbol))
            }
        }
    }

    private func Add(
        result List[ModelDisagreement],
        module MetadataModule,
        fullName string,
        expectedLines List[string]?,
        actualLines List[string]
    ) {
        // A type whose members the context cannot even list has nothing to compare.
        if expectedLines == nil {
            return
        }
        // Both lists are in row order. A line that differs, or a line only one side has, is a disagreement.
        let limit = Math.Max(expectedLines.Count, actualLines.Count)
        for var i = 0; i < limit; i++ {
            let expected = if i < expectedLines.Count {
                expectedLines[i]
            } else {
                "(none)"
            }
            let actual = if i < actualLines.Count {
                actualLines[i]
            } else {
                "(none)"
            }
            if expected != actual {
                result.Add(ModelDisagreement("Q6.member", module.Identity.Name + "!" + fullName, expected, actual))
            }
        }
    }

    // The order is by kind and then by table row, on both sides.
    internal func SymbolMembers(symbol MetadataTypeSymbol) List[string] {
        let lines = List[string]()
        for method in symbol.Methods {
            lines.Add(DescribeMethod(method))
        }
        for field in symbol.Fields {
            lines.Add(DescribeField(field))
        }
        for property in symbol.Properties {
            lines.Add(DescribeProperty(property))
        }
        for event_ in symbol.Events {
            lines.Add(DescribeEvent(event_))
        }
        return lines
    }

    internal func TypeMembers(type Type, module MetadataModule) List[string]? {
        let lines = List[string]()
        try {
            let methods = List[MethodBase]()
            methods.AddRange(type.GetMethods(AllDeclared))
            methods.AddRange(type.GetConstructors(AllDeclared))
            for method in methods.OrderBy((m MethodBase) -> m.MetadataToken) {
                lines.Add(DescribeMethod(method))
            }
            for field in type.GetFields(AllDeclared).OrderBy((f FieldInfo) -> f.MetadataToken) {
                lines.Add(DescribeField(field))
            }
            for property in type.GetProperties(AllDeclared).OrderBy((p PropertyInfo) -> p.MetadataToken) {
                lines.Add(
                    DescribeProperty(
                        property,
                        MetadataMembers.DeclaredParameterCount(
                            module.Reader,
                            MetadataTokens.PropertyDefinitionHandle(Row(property.MetadataToken))
                        )
                    )
                )
            }
            for event_ in type.GetEvents(AllDeclared).OrderBy((e EventInfo) -> e.MetadataToken) {
                lines.Add(DescribeEvent(event_))
            }
            return lines
        } catch (ex Exception) when IsLoadFailure(ex) {
            return nil
        }
    }

    internal func IsLoadFailure(ex Exception) bool -> ex is FileNotFoundException ||
        ex is FileLoadException ||
        ex is BadImageFormatException ||
        ex is TypeLoadException

    // ---- the one spelling of a member

    private func Line(
        kind string,
        row int32,
        name string,
        attributes int32,
        shape string,
        signature string
    ) string -> string.Join("|", kind, row.ToString(), name, attributes.ToString(), shape, signature)

    private func Row(handle EntityHandle) int32 -> if handle.IsNil {
        0
    } else {
        MetadataTokens.GetRowNumber(handle)
    }

    private func Row(token int32) int32 -> token & 0x00FFFFFF

    private func Parameter(name string, attributes int32, type string) string -> name + ":" + attributes.ToString() +
        ":" +
        type

    private func GenericShape(name string, ordinal int32, attributes GenericParameterAttributes) string -> string.Join(
        ":",
        name,
        ordinal.ToString(),
        MetadataTypeParameters.VarianceOf(attributes).ToString(),
        ((attributes & GenericParameterAttributes.ReferenceTypeConstraint) != 0).ToString(),
        ((attributes & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0).ToString(),
        ((attributes & GenericParameterAttributes.DefaultConstructorConstraint) != 0).ToString()
    )

    // The one spelling of the signature header fields that the table keeps beyond the flags.
    private func HeaderText(hasThis bool, explicitThis bool, isVarArg bool) string -> "this:" + hasThis.ToString() +
        "/" +
        explicitThis.ToString() + "/vararg:" + isVarArg.ToString()

    private func MethodSignature(returnType string, parameters IEnumerable[string]) string -> returnType +
        "(" +
        string.Join(";", parameters) + ")"

    // ---- symbols

    internal func DescribeMethod(method MetadataMethodSymbol) string {
        let generics = method.GenericParameters
        let shape = string.Join(
            "/",
            ((cast[int32](method.ImplAttributes))).ToString(),
            string.Join(
                ",",
                generics.Parameters.Select((p TypeParameterSymbol) -> GenericShape(p.Name, p.Ordinal, ToAttributes(p)))
            ),
            MetadataModelComparison.ConstraintsOf(generics.Constraints),
            HeaderText(method.Signature.HasThis, method.Signature.Header.HasExplicitThis, method.Signature.IsVarArg)
        )
        let signature = method.Signature
        let text = if signature.ContainsMissing {
            "signature-missing"
        } else {
            MethodSignature(
                MetadataTypeKeys.Of(signature.ReturnType) + ReturnModifiers(method),
                signature.Parameters.Select(
                    (p MetadataParameter) -> Parameter(
                        p.Name,
                        cast[int32](p.Attributes),
                        MetadataTypeKeys.Of(p.Type) + MetadataModifiers.Format(p.Type)
                    )
                )
            )
        }
        return Line("method", Row(method.Handle), method.Name, cast[int32](method.Flags), shape, text)
    }

    internal func DescribeField(field MetadataFieldSymbol) string {
        let text = if MetadataTypeKeys.ContainsMissing(field.FieldType) {
            "signature-missing"
        } else {
            MetadataTypeKeys.Of(field.FieldType) + MetadataModifiers.Format(field.FieldType)
        }
        return Line("field", Row(field.Handle), field.Name, cast[int32](field.Flags), "", text)
    }

    internal func DescribeProperty(property MetadataPropertySymbol) string {
        let signature = property.Signature
        let text = if signature.ContainsMissing {
            "signature-missing"
        } else {
            MethodSignature(
                MetadataTypeKeys.Of(signature.ReturnType) + MetadataModifiers.Format(signature.ReturnType),
                signature.Parameters.Select(
                    (p MetadataParameter) -> MetadataTypeKeys.Of(p.Type) + MetadataModifiers.Format(p.Type)
                )
            )
        }
        let accessors = Row(property.Getter).ToString() + "/" + Row(property.Setter).ToString()
        return Line("property", Row(property.Handle), property.Name, cast[int32](property.Flags), accessors, text)
    }

    internal func DescribeEvent(event_ MetadataEventSymbol) string {
        let text = if MetadataTypeKeys.ContainsMissing(event_.HandlerType) {
            "signature-missing"
        } else {
            MetadataTypeKeys.Of(event_.HandlerType)
        }
        let accessors = Row(event_.Adder).ToString() + "/" + Row(event_.Remover).ToString() + "/" + Row(
            event_.Raiser
        ).ToString()
        return Line("event", Row(event_.Handle), event_.Name, cast[int32](event_.Flags), accessors, text)
    }

    // The attribute bits that the symbol keeps, rebuilt for the shared GenericShape spelling.
    private func ToAttributes(parameter TypeParameterSymbol) GenericParameterAttributes {
        var attributes = GenericParameterAttributes.None
        if parameter.Variance == TypeParameterVariance.Out {
            attributes |= GenericParameterAttributes.Covariant
        }
        if parameter.Variance == TypeParameterVariance.In {
            attributes |= GenericParameterAttributes.Contravariant
        }
        if parameter.HasReferenceTypeConstraint {
            attributes |= GenericParameterAttributes.ReferenceTypeConstraint
        }
        if parameter.HasValueTypeConstraint {
            attributes |= GenericParameterAttributes.NotNullableValueTypeConstraint
        }
        if parameter.HasDefaultConstructorConstraint {
            attributes |= GenericParameterAttributes.DefaultConstructorConstraint
        }
        return attributes
    }

    // ---- reflection types

    internal func DescribeMethod(method MethodBase) string {
        let arguments = if method is MethodInfo {
            method.GetGenericArguments()
        } else {
            Array.Empty[Type]()
        }
        let shape = string.Join(
            "/",
            (cast[int32](method.GetMethodImplementationFlags())).ToString(),
            string.Join(
                ",",
                arguments.Select(
                    (a Type) -> GenericShape(a.Name, a.GenericParameterPosition, a.GenericParameterAttributes)
                )
            ),
            MetadataModelComparison.ConstraintsOf(arguments),
            HeaderText(
                (method.CallingConvention & CallingConventions.HasThis) != 0,
                (method.CallingConvention & CallingConventions.ExplicitThis) != 0,
                (method.CallingConvention & CallingConventions.VarArgs) != 0
            )
        )
        var text = ""
        try {
            let returnType = if method is MethodInfo info {
                MetadataTypeKeys.Of(info.ReturnType) + Modifiers(info.ReturnParameter)
            } else {
                "System.Void"
            }
            text = MethodSignature(
                returnType,
                method
                    .GetParameters()
                    .Select(
                    (p ParameterInfo) -> Parameter(
                        p.Name ?? "",
                        cast[int32](p.Attributes),
                        MetadataTypeKeys.Of(p.ParameterType) + Modifiers(p)
                    )
                )
                    .ToList()
            )
        } catch (ex Exception) when IsLoadFailure(ex) {
            text = "signature-missing"
        }
        return Line("method", Row(method.MetadataToken), method.Name, cast[int32](method.Attributes), shape, text)
    }

    internal func DescribeField(field FieldInfo) string {
        var text = ""
        try {
            text = MetadataTypeKeys.Of(field.FieldType) + MetadataModifiers.Format(
                field.GetRequiredCustomModifiers(),
                field.GetOptionalCustomModifiers()
            )
        } catch (ex Exception) when IsLoadFailure(ex) {
            text = "signature-missing"
        }
        return Line("field", Row(field.MetadataToken), field.Name, cast[int32](field.Attributes), "", text)
    }

    internal func DescribeProperty(property PropertyInfo, declaredParameterCount int32) string {
        var text = ""
        try {
            text = MethodSignature(
                MetadataTypeKeys.Of(property.PropertyType) + MetadataModifiers.Format(
                    property.GetRequiredCustomModifiers(),
                    property.GetOptionalCustomModifiers()
                ),
                IndexParameters(property, declaredParameterCount).Select(
                    (p ParameterInfo) -> MetadataTypeKeys.Of(p.ParameterType) + Modifiers(p)
                )
                    .ToList()
            )
        } catch (ex Exception) when IsLoadFailure(ex) {
            text = "signature-missing"
        }
        let getter = property.GetGetMethod(true)
        let setter = property.GetSetMethod(true)
        let accessors = AccessorRow(getter) + "/" + AccessorRow(setter)
        return Line(
            "property",
            Row(property.MetadataToken),
            property.Name,
            cast[int32](property.Attributes),
            accessors,
            text
        )
    }

    internal func DescribeEvent(event_ EventInfo) string {
        var text = ""
        try {
            text = MetadataTypeKeys.Of(event_.EventHandlerType)
        } catch (ex Exception) when IsLoadFailure(ex) {
            text = "signature-missing"
        }
        let accessors = AccessorRow(event_.GetAddMethod(true)) +
            "/" +
            AccessorRow(event_.GetRemoveMethod(true)) +
            "/" +
            AccessorRow(event_.GetRaiseMethod(true))
        return Line("event", Row(event_.MetadataToken), event_.Name, cast[int32](event_.Attributes), accessors, text)
    }

    // Reflection takes the index parameters of a property from its accessor. F#'s `static member get_IsNone(option)`
    // then reports the accessor's argument as an index parameter, while the property signature in the table declares
    // none. The table is the truth: only as many index parameters as the row declares are kept. A genuine static
    // indexed property declares its parameter in both places and keeps it.
    private func IndexParameters(property PropertyInfo, declaredParameterCount int32)[]ParameterInfo -> property
        .GetIndexParameters()
        .Take(declaredParameterCount)
        .ToArray()

    // Reflection has no return parameter for a constructor (ConstructorInfo), so the return modifiers of a `.ctor` or
    // `.cctor` cannot be compared. Both sides leave them out of the line; the symbol keeps them and a structural test
    // covers them.
    private func ReturnModifiers(method MetadataMethodSymbol) string -> if method.Name == ".ctor" ||
        method.Name == ".cctor" {
        ""
    } else {
        MetadataModifiers.Format(method.Signature.ReturnType)
    }

    // The modifiers of a parameter position, by the shared format.
    private func Modifiers(parameter ParameterInfo) string -> MetadataModifiers.Format(
        parameter.GetRequiredCustomModifiers(),
        parameter.GetOptionalCustomModifiers()
    )

    private func AccessorRow(method MethodInfo?) string -> if method == nil {
        "0"
    } else {
        Row(method.MetadataToken).ToString()
    }
}
