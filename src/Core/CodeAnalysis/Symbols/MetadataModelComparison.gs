// <copyright file="MetadataModelComparison.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Compilation
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Text

/// One question on which the `MetadataLoadContext` model and the handle model gave different answers.
internal class ModelDisagreement {
    internal init(question string, subject string, expected string, actual string) {
        Question = question
        Subject = subject
        Expected = expected
        Actual = actual
    }

    /// Gets the question id of ADR-0209 section 7 and the part of it that was asked.
    internal prop Question string

    /// Gets the module or type that the question was about.
    internal prop Subject string

    /// Gets the answer of the `MetadataLoadContext` model.
    internal prop Expected string

    /// Gets the answer of the handle model.
    internal prop Actual string
}

/// Compares the handle model with the `MetadataLoadContext` model by name (ADR-0209 section 10, PR 1).
/// @remarks The answers are compared as identities: the assembly simple name and the full name in the spelling of reflection.
/// The three questions are the type names of each module (Q1), the resolution of each type reference (Q1) and the well-known types.
internal shared class MetadataModelComparison {
    /// The name of the counter of different answers.
    internal let CounterName string = "metadata.model-disagreements"

    // The report lists at most this many disagreements. The counter holds the true number.
    private let MaximumReportedLines int32 = 1000

    /// Compares the two models over the images of a resolver.
    /// @param resolver The resolver, which answers for the `MetadataLoadContext` model.
    /// @param set The handle model over the same images, or `null` when it could not be built.
    /// @returns The different answers, in a fixed order: by module, then by table row.
    internal func Compare(resolver ReferenceResolver, set ReferenceImageSet?) List[ModelDisagreement] {
        let result = List[ModelDisagreement]()
        if set == nil {
            result.Add(ModelDisagreement("Q1.set", "reference set", "built", "not built"))
            return result
        }
        CompareNames(resolver, set, result)
        CompareTypeReferences(resolver, set, result)
        CompareWellKnownTypes(resolver, set, result)
        CompareTypeDefinitions(resolver, set, result)
        return result
    }

    /// Compares the two models, counts the different answers and writes the report.
    /// The counter `metadata.model-disagreements` is present, with the value 0, when the models agree.
    /// The report file is next to the phase JSON: the path of that file with `.model-disagreements.txt` appended.
    internal func CompareAndReport(resolver ReferenceResolver, set ReferenceImageSet?) {
        using let measurement = CompilationMeasurements.BeginPhase("references.model-compare")
        let disagreements = Compare(resolver, set)
        // The oracle lookups fill the resolution cache of the resolver, before the consumer name is known.
        // Discard them, so that comparison cannot change a later binding.
        resolver.DiscardResolutionCache()
        CompilationMeasurements.Count(CounterName, disagreements.Count)
        if CompilationMeasurements.CurrentOutputPath is {} phasePath {
            File.AppendAllText(phasePath + ".model-disagreements.txt", FormatReport(disagreements))
        }
    }

    /// Writes one line for each disagreement: question, subject, expected, actual.
    internal func FormatReport(disagreements List[ModelDisagreement]) string {
        let builder = StringBuilder()
        builder.Append("metadata.model-disagreements: ").Append(disagreements.Count).Append('\n')
        for var i = 0; i < disagreements.Count && i < MaximumReportedLines; i++ {
            let item = disagreements[i]
            builder
                .Append(item.Question)
                .Append('\t')
                .Append(item.Subject)
                .Append('\t')
                .Append(item.Expected)
                .Append('\t')
                .Append(item.Actual)
                .Append('\n')
        }
        return builder.ToString()
    }

    // Q1: the indexed names of each searched module, in order.
    private func CompareNames(resolver ReferenceResolver, set ReferenceImageSet, result List[ModelDisagreement]) {
        let expected = resolver.ReadIndexedTypeNames()
        if expected.Count != set.SearchedCount {
            result.Add(ModelDisagreement("Q1.modules", "reference set", "${expected.Count}", "${set.SearchedCount}"))
            return
        }
        for var i = 0; i < expected.Count; i++ {
            let actual = set.GetIndexedNames(i)
            if expected[i].SequenceEqual(actual) {
                continue
            }
            var at = 0
            while at < expected[i].Count && at < actual.Count && expected[i][at] == actual[at] {
                at++
            }
            result.Add(
                ModelDisagreement(
                    "Q1.names",
                    set.Modules[i].Identity.Name,
                    "${expected[i].Count} names; at ${at}: ${NameAt(expected[i], at)}",
                    "${actual.Count} names; at ${at}: ${NameAt(actual, at)}"
                )
            )
        }
    }

    private func NameAt(names List[string], index int32) string -> if index < names.Count {
        names[index]
    } else {
        "(end)"
    }

    // Q1: every type reference row of every module resolves to the type that the context reaches by name.
    private func CompareTypeReferences(
        resolver ReferenceResolver,
        set ReferenceImageSet,
        result List[ModelDisagreement]
    ) {
        for module in set.Modules {
            for handle in module.Reader.TypeReferences {
                let actual = set.ResolveTypeReference(module, handle)
                var assemblyName = ""
                let fullName = SpellReference(module.Reader, handle, out assemblyName)
                if fullName == nil {
                    // The context has no name for a reference that a module scope or a nil scope holds.
                    continue
                }
                let found = resolver.FindTypeForComparison(assemblyName, fullName)
                let expected = if found == nil {
                    "missing"
                } else {
                    Identify(found)
                }
                let actualText = Describe(actual)
                if !string.Equals(expected, actualText, StringComparison.OrdinalIgnoreCase) {
                    result.Add(ModelDisagreement("Q1.type-reference", Subject(module, handle), expected, actualText))
                }
            }
        }
    }

    // Q1 and the well-known types: each name of the table resolves where the resolver resolves it.
    private func CompareWellKnownTypes(
        resolver ReferenceResolver,
        set ReferenceImageSet,
        result List[ModelDisagreement]
    ) {
        for fullName in set.WellKnown.FullNames {
            let actual = set.WellKnown.TryGet(fullName)!!
            var found Type? = nil
            let expected = if resolver.TryResolveType(fullName, false, out found) {
                Identify(found!!)
            } else {
                "missing"
            }
            let actualText = Describe(actual)
            if !string.Equals(expected, actualText, StringComparison.OrdinalIgnoreCase) {
                result.Add(ModelDisagreement("Q1.well-known", fullName, expected, actualText))
            }
        }
    }

    private func Identify(type Type) string -> (type.Assembly.GetName().Name ?? string.Empty) +
        "!" +
        (type.FullName ?? string.Empty)

    // Q2 and Q3: name, nesting, arity, generic parameters, kind flags and base of every type a searched module defines.
    // One function spells each answer, and it spells both sides, so the two cannot be decided apart.
    private func CompareTypeDefinitions(
        resolver ReferenceResolver,
        set ReferenceImageSet,
        result List[ModelDisagreement]
    ) {
        for var m = 0; m < set.SearchedCount; m++ {
            let module = set.Modules[m]
            for fullName in module.DefinedNames {
                module.TryGetDefinition(fullName, out var handle)
                let symbol = module.GetTypeSymbol(handle)
                let type = resolver.FindTypeForComparison(module.Identity.Name, fullName)
                let expected = if type == nil {
                    "missing"
                } else {
                    DescribeType(type)
                }
                let actual = DescribeSymbol(symbol)
                if expected != actual {
                    result.Add(
                        ModelDisagreement("Q2.type-definition", module.Identity.Name + "!" + fullName, expected, actual)
                    )
                }
            }
        }
    }

    // A description has two parts. The first part reads only the type's own row and always compares.
    // The second part needs the base chain. When the context cannot load a base (table 7b, Q4), both sides
    // write "base-missing" for the second part, and only that part is left out.
    internal func DescribeSymbol(symbol MetadataTypeSymbol) string {
        let parameters = string.Join(
            ",",
            symbol.GenericParameters.Select(
                (p MetadataGenericParameter) -> p.Name + ":" + p.Ordinal.ToString() +
                    ":" +
                    (cast[int32](p.Attributes)).ToString()
            )
        )
        let kinds = symbol.Kinds
        let own = string.Join(
            "|",
            symbol.FullName,
            MetadataTypeNameReader.Escape(symbol.Name),
            MetadataTypeNameReader.Escape(symbol.Namespace),
            parameters,
            kinds.IsInterface,
            kinds.IsAbstract,
            kinds.IsSealed,
            symbol.EnclosingType?.FullName ?? ""
        )
        if !symbol.IsBaseChainComplete {
            return own + "|base-missing"
        }
        let baseName = if symbol.BaseDefinition is {} resolvedBase {
            Describe(resolvedBase)
        } else {
            ""
        }
        return own + "|" + string.Join("|", kinds.IsValueType, kinds.IsEnum, kinds.IsDelegate, baseName)
    }

    internal func DescribeType(type Type) string {
        let all = type.GetGenericArguments()
        let parameters = List[string]()
        for var i = 0; i < all.Length; i++ {
            parameters.Add(
                all[i].Name + ":" + i.ToString() + ":" + (cast[int32](all[i].GenericParameterAttributes)).ToString()
            )
        }
        let own = string.Join(
            "|",
            type.FullName ?? "",
            type.Name,
            if type.DeclaringType == nil {
                type.Namespace ?? ""
            } else {
                ""
            },
            string.Join(",", parameters),
            type.IsInterface,
            type.IsAbstract,
            type.IsSealed,
            type.DeclaringType?.FullName ?? ""
        )
        try {
            // The raw properties answer false across reflection contexts (#3764); the safe forms answer from the base name.
            let valueType = type.IsValueTypeSafe()
            let isEnum = type.BaseType?.FullName == "System.Enum" && type.FullName != "System.Enum"
            let isDelegate = ClrTypeUtilities.IsDelegateType(type)
            var baseName = ""
            if type.BaseType is {} baseType {
                // The defining assembly is part of the identity: two assemblies can define the same full name.
                let definition = if baseType.IsGenericType {
                    baseType.GetGenericTypeDefinition()
                } else {
                    baseType
                }
                baseName = Identify(definition)
            }
            return own + "|" + string.Join("|", valueType, isEnum, isDelegate, baseName)
        } catch (ex Exception) when ex is FileNotFoundException ||
            ex is FileLoadException ||
            ex is BadImageFormatException ||
            ex is TypeLoadException {
            return own + "|base-missing"
        }
    }

    private func Describe(resolved ResolvedTypeReference) string -> if resolved.Module is {} module {
        module.Identity.Name + "!" + resolved.FullName
    } else {
        "missing"
    }

    private func Subject(module MetadataModule, handle TypeReferenceHandle) string -> module
        .Identity
        .Name +
        " TypeRef#" +
        MetadataTokens
        .GetRowNumber(handle).ToString()

    // Spells a type reference as the context sees it: the simple name of the assembly that the outermost
    // scope names, and the full name with `+` between the enclosing types. Returns null for a scope
    // that is not an assembly reference or a type reference, and for a chain deeper than the set resolves.
    private func SpellReference(reader MetadataReader, handle TypeReferenceHandle, out assemblyName string) string? {
        assemblyName = ""
        // The same cut as the set, so the oracle sees every answer that the set gives.
        if MetadataTypeNameReader.IsEnclosingChainTooDeep(reader, handle) {
            return nil
        }
        let reference = reader.GetTypeReference(handle)
        let segment = MetadataTypeNameReader.SpellReferenceSegment(reader, reference)
        let resolutionScope = reference.ResolutionScope
        if resolutionScope.Kind == HandleKind.AssemblyReference {
            assemblyName = reader.GetString(
                reader.GetAssemblyReference(cast[AssemblyReferenceHandle](resolutionScope)).Name
            )
            return segment
        }
        if resolutionScope.Kind == HandleKind.TypeReference {
            let outer = SpellReference(reader, cast[TypeReferenceHandle](resolutionScope), out assemblyName)
            return if outer == nil {
                nil
            } else {
                outer + "+" + segment
            }
        }
        return nil
    }
}
